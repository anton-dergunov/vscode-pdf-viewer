import {
  AnnotationEditorType,
  AnnotationEditorUIManager,
  getDocument,
  GlobalWorkerOptions,
  PasswordException,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import { EventBus, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { NavTarget } from '../shared/messages';
import { HIGHLIGHT_COLORS } from './layout';
import { lineBoxes, type Box } from './lineBoxes';
import { mergeChanges, snapshotOf, type Change, type Snapshot } from './mergePlan';

/** Space kept above a destination (a section heading, a table caption) when jumping to it. */
const DEST_CONTEXT_PX = 72;

/** Zoom presets that depend on the viewer's size, so they are re-applied when it resizes. */
const FIT_PRESETS = new Set(['page-width', 'page-fit', 'auto']);

/**
 * VS Code's Undo and Redo step through the highlight history: each change is an edit of the
 * document (`onEdit`), which VS Code undoes and redoes through `PdfView.undo()` and `redo()`, and
 * so knows when the PDF is back as it was saved. The webview passes Ctrl/Cmd+Z on to VS Code too,
 * so pdf.js's own shortcuts, which call these prototype methods, must do nothing, or a key press
 * would undo twice. Nothing else in pdf.js calls them.
 */
const { undo: undoCommand, redo: redoCommand } = AnnotationEditorUIManager.prototype;
AnnotationEditorUIManager.prototype.undo = () => {};
AnnotationEditorUIManager.prototype.redo = () => {};

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
  /** Set while VS Code undoes or redoes a change, which is not a new one. */
  private replaying = false;
  /** The highlight changes as of the last save, and as of a save still being written. */
  private savedChanges: Snapshot = new Map();
  private savingChanges: Snapshot | null = null;

  /** Called for each change to the highlights: one step of VS Code's Undo. */
  onEdit = () => {};
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
      trackCommands(uiManager, () => {
        if (!this.replaying) {
          this.onEdit();
        }
      });
      joinLines(uiManager);
    });
    new ResizeObserver(() => {
      this.refitToContainer();
      this.flushPendingTarget();
    }).observe(container);
  }

  /**
   * Loads (or reloads) the document. A reload keeps the zoom and scroll position unless `target`
   * says where to go.
   */
  async load(data: Uint8Array, target?: NavTarget): Promise<void> {
    this.pagesReady = false;
    this.pendingTarget = target ?? null;
    // Changes from here on are relative to these bytes.
    this.savedChanges = new Map();
    this.savingChanges = null;
    await ensureWorker(this.assetsRoot);

    const previous = this.document
      ? {
          scale: this.viewer.currentScaleValue,
          left: this.container.scrollLeft,
          top: this.container.scrollTop,
        }
      : null;

    const task = this.open(data);
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

  /** pdf.js's viewer component doesn't re-fit on resize (its full app does), so it is done here. */
  private refitToContainer(): void {
    const preset = this.viewer.currentScaleValue;
    if (!this.pagesReady || this.container.clientWidth === 0 || !FIT_PRESETS.has(preset)) {
      return;
    }
    this.viewer.currentScaleValue = preset;
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

  /** Undoes the last change to the highlights, for VS Code's Undo. */
  undo(): void {
    this.replay(undoCommand);
  }

  /** Redoes the last undone change to the highlights, for VS Code's Redo. */
  redo(): void {
    this.replay(redoCommand);
  }

  private replay(command: (this: AnnotationEditorUIManager) => void): void {
    if (!this.uiManager) {
      return; // The document was loaded again since: its history starts afresh.
    }
    this.replaying = true;
    try {
      command.call(this.uiManager);
    } finally {
      this.replaying = false;
    }
  }

  /**
   * Returns the PDF bytes with all highlight changes applied as an incremental update. `forSave`:
   * they are being saved to the file, and `markSaved()` follows once they are written.
   */
  async getBytes(forSave = false): Promise<Uint8Array> {
    if (!this.document) {
      throw new Error('No document is loaded.');
    }
    if (forSave) {
      this.savingChanges = snapshotOf(this.changes());
    }
    // saveDocument() warns when there is nothing to save; getData() returns the original bytes.
    return this.document.annotationStorage.size > 0 ? this.document.saveDocument() : this.document.getData();
  }

  markSaved(): void {
    if (this.savingChanges) {
      this.savedChanges = this.savingChanges;
      this.savingChanges = null;
    }
  }

  /**
   * Adds the highlight changes made since the last save to `disk`, a newer copy of the file, as an
   * incremental update. Returns why it can't be done when some change can't be placed safely
   * (`planMerge`). `appended`: `disk` is the last loaded or saved bytes with more added at the end.
   */
  async mergeOnto(disk: Uint8Array, appended: boolean): Promise<{ data: Uint8Array } | { conflict: string }> {
    if (!this.document) {
      throw new Error('No document is loaded.');
    }
    // pdf.js takes ownership of the bytes it opens.
    return mergeChanges(this.open(disk.slice()), disk, this.changes(), this.savedChanges, appended);
  }

  /** The highlight changes in the loaded document, serialized by pdf.js. */
  private changes(): Map<string, Change> {
    return new Map<string, Change>(this.document?.annotationStorage.serializable.map ?? []);
  }

  private open(data: Uint8Array): PDFDocumentLoadingTask {
    return getDocument({
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
  }
}

/**
 * Every highlight edit (create, recolor, delete) goes through `addCommands`, and each one is a step
 * of pdf.js's history and an edit for VS Code. pdf.js would fold a recolor into the change before it
 * when that was a recolor too, leaving one step where VS Code counts two, so it is asked not to.
 * pdf.js's own storage-level "modified" flag is not usable for this: it is set merely by entering
 * highlight mode (existing highlights get added to storage), and it misses deleting a highlight that
 * was already in the file.
 */
function trackCommands(uiManager: AnnotationEditorUIManager, onEdit: () => void): void {
  const addCommands = uiManager.addCommands.bind(uiManager);
  uiManager.addCommands = (params: object) => {
    addCommands({ ...params, overwriteIfSameType: false });
    onEdit();
  };
}

/** A highlight made from a selection is drawn line by line, without holes (`lineBoxes`). */
function joinLines(uiManager: AnnotationEditorUIManager): void {
  const getSelectionBoxes = uiManager.getSelectionBoxes.bind(uiManager);
  uiManager.getSelectionBoxes = (textLayer: HTMLElement) => {
    const boxes = getSelectionBoxes(textLayer) as Box[] | null;
    if (!boxes) {
      return boxes;
    }
    // The boxes are fractions of the page as it is unrotated.
    const { width, height } = textLayer.getBoundingClientRect();
    const turned = ['90', '270'].includes(textLayer.getAttribute('data-main-rotation') ?? '');
    return lineBoxes(boxes, turned ? height / width : width / height);
  };
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
