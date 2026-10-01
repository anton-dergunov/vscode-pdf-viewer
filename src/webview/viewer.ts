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
import type { NavTarget } from '../shared/messages';
import { HIGHLIGHT_COLORS } from './layout';

/** Space kept above a destination (a section heading, a table caption) when jumping to it. */
const DEST_CONTEXT_PX = 72;

/** Owns the pdf.js viewer component and the currently loaded document. */
export class PdfView {
  readonly eventBus = new EventBus();
  readonly viewer: PDFViewer;
  readonly findController: PDFFindController;
  uiManager: AnnotationEditorUIManager | null = null;

  private readonly linkService: PDFLinkService;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private document: PDFDocumentProxy | null = null;
  /** False while a document is loading; navigation requested meanwhile waits in `pendingTarget`. */
  private pagesReady = false;
  private pendingTarget: NavTarget | null = null;

  /** Called when the document goes from unmodified to modified. */
  onModified = () => {};
  /** Called to search for a phrase as part of navigation. */
  onSearch = (_query: string) => {};

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
    this.linkService.goToDestination = async (dest) => {
      await this.scrollToDestination(dest);
    };
    this.eventBus.on('annotationeditoruimanager', ({ uiManager }: { uiManager: AnnotationEditorUIManager }) => {
      this.uiManager = uiManager;
      trackCommands(uiManager, () => this.onModified());
    });
    this.trackUndoShortcuts();
    new ResizeObserver(() => this.flushPendingTarget()).observe(container);
  }

  /**
   * Loads (or reloads) the document. A reload keeps the zoom and scroll position unless `target`
   * says where to go.
   */
  async load(data: Uint8Array, target?: NavTarget): Promise<void> {
    this.pagesReady = false;
    this.pendingTarget = target ?? null;
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
        this.pagesReady = true;
        this.flushPendingTarget();
      },
      { once: true },
    );
    this.viewer.setDocument(document);
    this.linkService.setDocument(document);
    await previousTask?.destroy();
  }

  /** Goes to a page, named destination and/or search phrase, now or as soon as it can. */
  navigate(target: NavTarget): void {
    this.pendingTarget = target;
    this.flushPendingTarget();
  }

  /**
   * Navigation needs the pages laid out and the viewer visible: a link can target a tab that is
   * hidden behind another one, and scrolling does nothing until the tab is revealed.
   */
  private flushPendingTarget(): void {
    const target = this.pendingTarget;
    if (!target || !this.pagesReady || this.container.clientHeight === 0) {
      return;
    }
    this.pendingTarget = null;
    void this.goTo(target);
  }

  private async goTo({ page, dest, search }: NavTarget): Promise<void> {
    // Named destinations (hyperref's `section.4.3`, `table.2`, …) point at the exact spot; the
    // page number is the fallback for PDFs without them.
    const found = dest ? await this.scrollToDestination(dest) : false;
    if (!found && page && page <= this.viewer.pagesCount) {
      this.viewer.currentPageNumber = page;
    }
    if (search) {
      this.onSearch(search);
    }
  }

  /**
   * Replaces `PDFLinkService.goToDestination`, which is also what links inside the PDF use. The
   * original focuses the target page's text layer once it renders, without `preventScroll`, so
   * after a long jump the browser scrolls the whole page into view and loses the target. This
   * version also keeps the current zoom and leaves some room above the target: hyperref anchors
   * floats below their caption.
   */
  private async scrollToDestination(dest: string | unknown): Promise<boolean> {
    const document = this.document;
    if (!document) {
      return false;
    }
    const explicit = typeof dest === 'string' ? await document.getDestination(dest).catch(() => null) : await dest;
    if (!Array.isArray(explicit)) {
      return false;
    }
    const [ref] = explicit;
    const pageNumber =
      ref && typeof ref === 'object'
        ? (await document.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])) + 1
        : Number.isInteger(ref)
          ? (ref as number) + 1
          : 0;
    if (!(pageNumber >= 1 && pageNumber <= this.viewer.pagesCount)) {
      return false;
    }
    this.viewer.scrollPageIntoView({ pageNumber, destArray: explicit, ignoreDestinationZoom: true });
    this.container.scrollTop = Math.max(0, this.container.scrollTop - DEST_CONTEXT_PX);
    return true;
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
