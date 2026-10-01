import type { PdfView } from './viewer';

/** Horizontal travel (in pixels) that turns one page. */
const PAGE_FLIP_THRESHOLD = 60;
/** A pause this long between horizontal wheel events ends the gesture, including trackpad inertia. */
const GESTURE_GAP_MS = 250;
const LINE_HEIGHT_PX = 16;

function deltaInPixels(delta: number, event: WheelEvent, pageSize: number): number {
  switch (event.deltaMode) {
    case WheelEvent.DOM_DELTA_LINE:
      return delta * LINE_HEIGHT_PX;
    case WheelEvent.DOM_DELTA_PAGE:
      return delta * pageSize;
    default:
      return delta;
  }
}

/**
 * - Ctrl/Cmd + wheel and trackpad pinch zoom around the pointer.
 * - A horizontal swipe or tilt-wheel turns exactly one page per gesture, unless the page is wider
 *   than the window and can still be panned in that direction.
 */
export function setupWheel(view: PdfView): void {
  const { container, viewer } = view;
  let accumulated = 0;
  let lastEventTime = -Infinity;
  let flipped = false;

  container.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const delta = deltaInPixels(event.deltaY, event, container.clientHeight);
        const scaleFactor = Math.min(Math.max(Math.exp(-delta / 100), 0.8), 1.25);
        viewer.updateScale({ scaleFactor, origin: [event.clientX, event.clientY], drawingDelay: 300 });
        return;
      }

      const dx = deltaInPixels(event.deltaX, event, container.clientWidth);
      const dy = deltaInPixels(event.deltaY, event, container.clientHeight);
      if (Math.abs(dx) <= Math.abs(dy)) {
        return;
      }
      const canPan =
        dx > 0
          ? container.scrollLeft + container.clientWidth < container.scrollWidth - 1
          : container.scrollLeft > 0;
      if (canPan) {
        return;
      }
      event.preventDefault();

      if (event.timeStamp - lastEventTime > GESTURE_GAP_MS) {
        accumulated = 0;
        flipped = false;
      }
      lastEventTime = event.timeStamp;
      if (flipped) {
        return;
      }
      accumulated += dx;
      if (Math.abs(accumulated) >= PAGE_FLIP_THRESHOLD) {
        flipped = true;
        if (accumulated > 0) {
          viewer.nextPage();
        } else {
          viewer.previousPage();
        }
      }
    },
    { passive: false },
  );
}
