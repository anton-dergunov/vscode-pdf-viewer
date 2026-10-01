import type { Layout } from './layout';
import type { PdfView } from './viewer';

const REVEAL_ZONE_PX = 40;
const HIDE_DELAY_MS = 500;

/** Shows the toolbar while the pointer is near the top edge, or while focus or a popup is inside it. */
export function setupAutoHide(ui: Layout): void {
  const { toolbar, colorPopup } = ui;
  let hideTimer: number | undefined;

  const show = () => {
    clearTimeout(hideTimer);
    toolbar.classList.add('visible');
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (toolbar.matches(':hover, :focus-within') || !colorPopup.hidden) {
        return;
      }
      toolbar.classList.remove('visible');
    }, HIDE_DELAY_MS);
  };

  document.addEventListener('pointermove', (event) => {
    if (event.clientY <= REVEAL_ZONE_PX) {
      show();
    } else if (toolbar.classList.contains('visible')) {
      scheduleHide();
    }
  });
  document.documentElement.addEventListener('pointerleave', scheduleHide);
  toolbar.addEventListener('focusin', show);
  toolbar.addEventListener('focusout', scheduleHide);
}

export function setupNavigation(ui: Layout, view: PdfView): void {
  const { viewer, eventBus } = view;

  ui.prevPage.addEventListener('click', () => viewer.previousPage());
  ui.nextPage.addEventListener('click', () => viewer.nextPage());

  ui.pageNumber.addEventListener('change', () => {
    const page = Number.parseInt(ui.pageNumber.value, 10);
    if (page >= 1 && page <= viewer.pagesCount) {
      viewer.currentPageNumber = page;
    } else {
      ui.pageNumber.value = String(viewer.currentPageNumber);
    }
  });

  eventBus.on('pagesinit', () => {
    ui.pageCount.textContent = String(viewer.pagesCount);
    ui.pageNumber.max = String(viewer.pagesCount);
  });
  eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
    ui.pageNumber.value = String(pageNumber);
  });
}

export function setupZoom(ui: Layout, view: PdfView): void {
  const { viewer, eventBus } = view;

  ui.zoomIn.addEventListener('click', () => viewer.increaseScale());
  ui.zoomOut.addEventListener('click', () => viewer.decreaseScale());
  ui.zoomSelect.addEventListener('change', () => {
    viewer.currentScaleValue = ui.zoomSelect.value;
  });

  eventBus.on('scalechanging', ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
    const preset = [...ui.zoomSelect.options].find(
      (option) => option !== ui.zoomCustom && (option.value === presetValue || Number(option.value) === scale),
    );
    ui.zoomCustom.hidden = !!preset;
    if (preset) {
      ui.zoomSelect.value = preset.value;
    } else {
      ui.zoomCustom.textContent = `${Math.round(scale * 100)}%`;
      ui.zoomSelect.value = ui.zoomCustom.value;
    }
  });
}
