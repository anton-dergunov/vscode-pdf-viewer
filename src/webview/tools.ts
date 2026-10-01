import { AnnotationEditorParamsType, AnnotationEditorType } from 'pdfjs-dist';
import { HIGHLIGHT_COLORS, type Layout } from './layout';
import type { PdfView } from './viewer';

type Tool = 'select' | 'highlight' | 'eraser';

/** pdf.js starts a freehand highlight when a pointerdown lands on one of these instead of on text. */
const FREEHAND_TARGETS = '.endOfContent, [role="img"], .textLayerImages, .textLayerImagePlaceholder';

/**
 * Select, highlight and eraser tools plus the color picker.
 *
 * Highlight and eraser both run pdf.js in highlight-editing mode, which turns every highlight
 * (including ones already in the file) into an editable object; the eraser only differs in how
 * pointer input is handled.
 */
export function setupTools(ui: Layout, view: PdfView): void {
  let tool: Tool = 'select';
  let color: string = HIGHLIGHT_COLORS[0].value;

  const applyEditorMode = () => {
    if (!view.uiManager) {
      return;
    }
    view.viewer.annotationEditorMode = {
      mode: tool === 'select' ? AnnotationEditorType.NONE : AnnotationEditorType.HIGHLIGHT,
    };
  };

  const setTool = (next: Tool) => {
    tool = next;
    document.body.dataset.tool = tool;
    for (const button of ui.toolButtons) {
      button.classList.toggle('active', button.dataset.tool === tool);
      button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
    }
    applyEditorMode();
  };

  const setColor = (next: string) => {
    color = next;
    ui.colorPreview.style.setProperty('--swatch', color);
    for (const swatch of ui.swatches) {
      swatch.classList.toggle('active', swatch.dataset.color === color);
    }
    // Recolors the selected highlight if there is one, otherwise sets the color for new highlights.
    view.uiManager?.updateParams(AnnotationEditorParamsType.HIGHLIGHT_COLOR, color);
  };

  const closePopup = () => {
    ui.colorPopup.hidden = true;
    ui.colorButton.setAttribute('aria-expanded', 'false');
  };

  for (const button of ui.toolButtons) {
    button.addEventListener('click', () => setTool(button.dataset.tool as Tool));
  }

  for (const swatch of ui.swatches) {
    swatch.style.setProperty('--swatch', swatch.dataset.color!);
    swatch.addEventListener('click', () => {
      setColor(swatch.dataset.color!);
      closePopup();
      if (tool !== 'highlight') {
        setTool('highlight');
      }
    });
  }

  ui.colorButton.addEventListener('click', () => {
    ui.colorPopup.hidden = !ui.colorPopup.hidden;
    ui.colorButton.setAttribute('aria-expanded', String(!ui.colorPopup.hidden));
  });
  document.addEventListener('pointerdown', (event) => {
    if (!ui.colorPopup.hidden && !(event.target as Element).closest('.color-picker')) {
      closePopup();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !ui.colorPopup.hidden) {
      closePopup();
    }
  });

  // Runs before pdf.js sees the event (capture phase on an ancestor of the page layers).
  view.container.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as Element;
      if (tool === 'eraser') {
        event.preventDefault();
        event.stopPropagation();
        const editorDiv = target.closest('.highlightEditor');
        if (editorDiv) {
          eraseHighlight(view, editorDiv.id);
        }
      } else if (tool === 'highlight') {
        // Only text selections create highlights; block freehand drawing on empty areas while
        // still letting a native text selection start there.
        const textLayer = target.closest('.textLayer');
        if (textLayer && (target === textLayer || target.matches(FREEHAND_TARGETS))) {
          event.stopPropagation();
        }
      }
    },
    { capture: true },
  );

  // A reload creates a new editor manager, which starts in the default (select) mode.
  view.eventBus.on('pagesinit', applyEditorMode);
  // The manager ignores parameter updates until an editing mode has been entered once.
  view.eventBus.on('annotationeditormodechanged', ({ mode }: { mode: number }) => {
    if (mode === AnnotationEditorType.HIGHLIGHT) {
      setColor(color);
    }
  });

  setTool('select');
  setColor(color);
}

/**
 * Removes a highlight as an undoable command. Mirrors pdf.js's own delete, but without selecting
 * the highlight first: selecting builds its floating toolbar asynchronously, which then fails on
 * the already-removed editor.
 */
function eraseHighlight(view: PdfView, editorId: string): void {
  const uiManager = view.uiManager;
  const editor = uiManager?.getEditor(editorId);
  const layer = editor?.parent;
  if (!uiManager || !editor || !layer) {
    return;
  }
  uiManager.addCommands({
    cmd: () => editor.remove(),
    undo: () => layer.addOrRebuild(editor),
    mustExec: true,
  });
}
