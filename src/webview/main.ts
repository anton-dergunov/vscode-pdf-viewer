import './pdfjs';
import { onHostMessage, postToHost, reportError } from './host';
import { createLayout } from './layout';
import { setupSearch } from './search';
import { setupAutoHide, setupNavigation, setupOverflow, setupZoom } from './toolbar';
import { setupTools } from './tools';
import { PdfView } from './viewer';
import { setupWheel } from './wheel';

const ui = createLayout();
const view = new PdfView(ui.container, document.body.dataset.pdfjsRoot!);

setupAutoHide(ui);
setupNavigation(ui, view);
setupZoom(ui, view);
setupOverflow(ui, view);
setupTools(ui, view);
setupWheel(view);
const search = setupSearch(ui, view);
view.onSearch = (query) => search.openWith(query);

const setDirty = (dirty: boolean) => {
  ui.save.disabled = !dirty;
};

// VS Code keeps the edits, and says when the PDF differs from the file (`dirty`).
view.onEdit = () => postToHost({ type: 'edit' });
view.eventBus.on('pagesinit', () => {
  ui.loading.hidden = true;
});
ui.save.addEventListener('click', () => postToHost({ type: 'save' }));

document.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    search.open();
    return;
  }
  if (event.key === 'Escape' && search.isOpen()) {
    search.close();
    return;
  }
  const target = event.target as Element;
  if (mod || event.altKey || target.closest('input, select, .highlightEditor')) {
    return;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    view.viewer.previousPage();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    view.viewer.nextPage();
  }
});

onHostMessage(async (message) => {
  switch (message.type) {
    case 'load':
      ui.loading.hidden = false;
      setDirty(message.dirty);
      try {
        await view.load(message.data, message.target);
      } catch (error) {
        ui.loading.hidden = true;
        reportError(`Could not open the PDF: ${(error as Error).message}`);
      }
      break;
    case 'navigate':
      view.navigate(message.target);
      break;
    case 'getBytes':
      try {
        const data = await view.getBytes();
        postToHost({ type: 'bytes', requestId: message.requestId, data });
      } catch (error) {
        postToHost({ type: 'bytesError', requestId: message.requestId, message: (error as Error).message });
      }
      break;
    case 'undo':
      view.undo();
      break;
    case 'redo':
      view.redo();
      break;
    case 'dirty':
      setDirty(message.dirty);
      break;
  }
});

postToHost({ type: 'ready' });
