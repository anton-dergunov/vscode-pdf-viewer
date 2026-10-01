import {
  AnnotationEditorType,
  getDocument,
  GlobalWorkerOptions,
  PasswordException,
  type AnnotationEditorUIManager,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import { EventBus, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { HIGHLIGHT_COLORS } from './layout';

/** Owns the pdf.js viewer component and the currently loaded document. */
export class PdfView {
  readonly eventBus = new EventBus();
  readonly viewer: PDFViewer;
  readonly findController: PDFFindController;
  uiManager: AnnotationEditorUIManager | null = null;

  private readonly linkService: PDFLinkService;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private document: PDFDocumentProxy | null = null;

  /** Called when the document goes from unmodified to modified. */
  onModified = () => {};

  constructor(
    readonly container: HTMLDivElement,
    private readonly assetsRoot: string,
  ) {
    this.linkService = new PDFLinkService({ eventBus: this.eventBus, externalLinkTarget: LinkTarget.BLANK });
    this.findController = new PDFFindController({ eventBus: this.eventBus, linkService: this.linkService });
    this.viewer = new PDFViewer({
      container,
      eventBus: this.eventBus,
      linkService: this.linkService,
      findController: this.findController,
      removePageBorders: true,
      annotationEditorMode: AnnotationEditorType.NONE,
      annotationEditorHighlightColors: HIGHLIGHT_COLORS.map((c) => `${c.name}=${c.value}`).join(','),
    });
    this.linkService.setViewer(this.viewer);
    this.eventBus.on('annotationeditoruimanager', ({ uiManager }: { uiManager: AnnotationEditorUIManager }) => {
      this.uiManager = uiManager;
      trackCommands(uiManager, () => this.onModified());
    });
    this.trackUndoShortcuts();
  }

  /** Loads (or reloads) the document, keeping the zoom and scroll position on reload. */
  async load(data: Uint8Array): Promise<void> {
    await ensureWorker(this.assetsRoot);

    const previous = this.document
      ? {
          scale: this.viewer.currentScaleValue,
          left: this.container.scrollLeft,
          top: this.container.scrollTop,
        }
      : null;

    const task = getDocument({
      data,
      cMapUrl: `${this.assetsRoot}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${this.assetsRoot}standard_fonts/`,
      wasmUrl: `${this.assetsRoot}wasm/`,
      iccUrl: `${this.assetsRoot}iccs/`,
      // Fetch these on the main thread: webview resources are served through the document's
      // resource loader, which a blob worker does not reliably share.
      useWorkerFetch: false,
    });
    const previousTask = this.loadingTask;
    this.loadingTask = task;

    let document: PDFDocumentProxy;
    try {
      document = await task.promise;
    } catch (error) {
      if (error instanceof PasswordException) {
        throw new Error('Password-protected PDFs are not supported.');
      }
      throw error;
    }
    if (this.loadingTask !== task) {
      return; // A newer load superseded this one.
    }

    this.uiManager = null;
    this.document = document;

    this.eventBus.on(
      'pagesinit',
      () => {
        this.viewer.currentScaleValue = previous?.scale ?? 'page-width';
        if (previous) {
          this.container.scrollTo(previous.left, previous.top);
        }
      },
      { once: true },
    );
    this.viewer.setDocument(document);
    this.linkService.setDocument(document);
    await previousTask?.destroy();
  }

  /**
   * pdf.js binds its undo/redo shortcuts to the prototype methods, bypassing `trackCommands`, so
   * those keystrokes are counted as edits here when there is something to undo or redo.
   */
  private trackUndoShortcuts(): void {
    let canUndo = false;
    let canRedo = false;
    this.eventBus.on(
      'editingstateschanged',
      ({ details }: { details: { hasSomethingToUndo?: boolean; hasSomethingToRedo?: boolean } }) => {
        canUndo = details.hasSomethingToUndo ?? canUndo;
        canRedo = details.hasSomethingToRedo ?? canRedo;
      },
    );
    document.addEventListener(
      'keydown',
      (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) {
          return;
        }
        const key = event.key.toLowerCase();
        const isRedo = key === 'y' || (key === 'z' && event.shiftKey);
        const isUndo = key === 'z' && !event.shiftKey;
        if ((isUndo && canUndo) || (isRedo && canRedo)) {
          this.onModified();
        }
      },
      { capture: true },
    );
  }

  /** Returns the PDF bytes with all highlight changes applied as an incremental update. */
  async getBytes(): Promise<Uint8Array> {
    if (!this.document) {
      throw new Error('No document is loaded.');
    }
    // saveDocument() warns when there is nothing to save; getData() returns the original bytes.
    return this.document.annotationStorage.size > 0 ? this.document.saveDocument() : this.document.getData();
  }
}

/**
 * Every highlight edit (create, recolor, delete) and every undo/redo from code goes through these
 * methods. pdf.js's own storage-level "modified" flag is not usable for this: it is set merely by
 * entering highlight mode (existing highlights get added to storage), and it misses deleting a
 * highlight that was already in the file.
 */
function trackCommands(uiManager: AnnotationEditorUIManager, onModified: () => void): void {
  const manager = uiManager as unknown as Record<'addCommands' | 'undo' | 'redo', (...args: unknown[]) => void>;
  for (const method of ['addCommands', 'undo', 'redo'] as const) {
    const original = manager[method].bind(uiManager);
    manager[method] = (...args) => {
      original(...args);
      onModified();
    };
  }
}

let workerReady: Promise<void> | undefined;

/**
 * Webview resources are served from a different origin than the webview document, and browsers only
 * start workers from same-origin URLs. Loading the script into a blob URL sidesteps that.
 */
function ensureWorker(assetsRoot: string): Promise<void> {
  workerReady ??= (async () => {
    const response = await fetch(`${assetsRoot}pdf.worker.min.mjs`);
    const blob = new Blob([await response.text()], { type: 'text/javascript' });
    GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(blob), { type: 'module' });
  })();
  return workerReady;
}
