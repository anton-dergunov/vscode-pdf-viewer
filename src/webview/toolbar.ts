import type { Layout } from './layout';
import { keepInWindow } from './popup';
import type { PdfView } from './viewer';

const REVEAL_ZONE_PX = 40;
const HIDE_DELAY_MS = 500;

/** Shows the toolbar while the pointer is near the top edge, or while focus or a popup is inside it. */
export function setupAutoHide(ui: Layout): void {
  const { toolbar, colorPopup, morePopup } = ui;
  let hideTimer: number | undefined;

  const show = () => {
    clearTimeout(hideTimer);
    toolbar.classList.add('visible');
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (toolbar.matches(':hover, :focus-within') || !colorPopup.hidden || !morePopup.hidden) {
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

/**
 * Keeps the toolbar inside a narrow editor. Save loses its label first; then the controls marked
 * `data-overflow` move into the More popup, lowest number first, and return when there is room.
 */
export function setupOverflow(ui: Layout, view: PdfView): void {
  const { toolbar, toolbarItems, overflow, moreButton, morePopup } = ui;

  const controls = [...toolbarItems.querySelectorAll<HTMLElement>('[data-overflow]')];
  // The controls themselves are moved, so they keep their listeners; each leaves a marker behind
  // to return to.
  const homes = new Map(controls.map((control) => [control, document.createComment('')]));
  for (const [control, home] of homes) {
    control.before(home);
  }

  const setPopupOpen = (open: boolean) => {
    morePopup.hidden = !open;
    moreButton.setAttribute('aria-expanded', String(open));
    keepInWindow(morePopup);
  };

  const moveToPopup = (control: HTMLElement) => {
    // The popup lists its controls in toolbar order.
    const index = controls.indexOf(control);
    const next = [...morePopup.children].find((other) => controls.indexOf(other as HTMLElement) > index);
    morePopup.insertBefore(control, next ?? null);
  };

  const ranks = [...new Set(controls.map((control) => Number(control.dataset.overflow)))].sort((a, b) => a - b);
  const steps = [
    { set: (on: boolean) => toolbar.classList.toggle('compact', on), freed: 0 },
    ...ranks.map((rank) => {
      const members = controls.filter((control) => Number(control.dataset.overflow) === rank);
      const set = (on: boolean) =>
        members.forEach((control) => (on ? moveToPopup(control) : homes.get(control)!.after(control)));
      return { set, freed: 0 };
    }),
  ];
  let applied = 0;

  const contentWidth = () =>
    (overflow.hidden ? toolbarItems : overflow).getBoundingClientRect().right -
    toolbarItems.getBoundingClientRect().left;

  /** Applies or undoes a step and returns the width that freed (negative when undoing). */
  const setStep = (step: (typeof steps)[number], on: boolean): number => {
    const before = contentWidth();
    step.set(on);
    for (const group of toolbarItems.children) {
      (group as HTMLElement).hidden = group.childElementCount === 0;
    }
    overflow.hidden = morePopup.childElementCount === 0;
    if (overflow.hidden) {
      setPopupOpen(false);
    }
    return before - contentWidth();
  };

  const fit = () => {
    if (toolbar.clientWidth === 0) {
      return; // The tab is hidden.
    }
    const style = getComputedStyle(toolbar);
    const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    const available = toolbar.clientWidth - padding;

    while (applied < steps.length && contentWidth() > available) {
      const step = steps[applied++];
      step.freed = setStep(step, true);
    }
    while (applied > 0 && contentWidth() + steps[applied - 1].freed <= available) {
      const step = steps[applied - 1];
      setStep(step, false);
      if (contentWidth() > available) {
        // The controls have grown since the step was applied (e.g. a longer page count).
        step.freed = setStep(step, true);
        break;
      }
      applied--;
    }
    keepInWindow(morePopup);
  };

  // The toolbar spans the editor, so moving controls around never changes its own size.
  new ResizeObserver(fit).observe(toolbar);
  // The page count changes the width of the page controls.
  view.eventBus.on('pagesinit', fit);

  moreButton.addEventListener('click', () => setPopupOpen(!!morePopup.hidden));
  document.addEventListener('pointerdown', (event) => {
    if (!morePopup.hidden && !(event.target as Element).closest('.overflow')) {
      setPopupOpen(false);
    }
  });
  document.addEventListener('keydown', (event) => {
    // With the color picker open inside the popup, Escape closes only the color picker.
    if (event.key === 'Escape' && !morePopup.hidden && ui.colorPopup.hidden) {
      setPopupOpen(false);
    }
  });
  // The find bar opens where the popup is. Paging and zooming leave it open for repeated clicks.
  ui.findbar.addEventListener('focusin', () => setPopupOpen(false));
  ui.save.addEventListener('click', () => setPopupOpen(false));
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
