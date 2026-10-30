import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { EventBus, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { Rect } from '../shared/messages';
import { markBoxes, scrollFor, type Fractions } from './citeGeometry';

/**
 * A citation's mark: the rectangles a paper link names (`rect=`), drawn over the page. It is an
 * overlay of the page, never an annotation: nothing is written to the PDF and the document never
 * becomes dirty. It arrives with a brief ring that settles, then rests until the reader clicks the
 * page, presses Escape or opens another citation; scrolling keeps it.
 *
 * carrel (the tablet reader) draws the same mark, in its `static/cite-mark.js`; keep the two in
 * step, with the geometry in `citeGeometry.ts` and the styles in `main.css`.
 */

const FADE_MS = 220;
/** The arrival's fade and ring (main.css), after which the mark rests. */
const ARRIVAL_MS = 900;

interface Shown {
  page: number;
  boxes: { box: Fractions; block: boolean }[];
  element: HTMLDivElement;
}

/** The citation mark of one viewer: at most one at a time. */
export class CiteMark {
  private shown: Shown | null = null;

  constructor(
    private readonly viewer: PDFViewer,
    private readonly eventBus: EventBus,
    private readonly container: HTMLElement,
  ) {
    // pdf.js empties a page's div when it draws the page again (at another zoom, say).
    eventBus.on('pagerender', ({ pageNumber }: { pageNumber: number }) => this.attach(pageNumber));
    eventBus.on('pagerendered', ({ pageNumber }: { pageNumber: number }) => this.attach(pageNumber));
    container.addEventListener('pointerdown', (event) => {
      if (event.button === 0 && (event.target as Element).closest('.page')) {
        this.clear(true);
      }
    });
  }

  get visible(): boolean {
    return this.shown !== null;
  }

  /**
   * Marks rectangles on a page and scrolls them into the middle of the view. False when none of
   * them is on the page, which then shows nothing.
   */
  async show(document: PDFDocumentProxy, pageNumber: number, rects: Rect[]): Promise<boolean> {
    this.clear(false);
    if (!(pageNumber >= 1 && pageNumber <= this.viewer.pagesCount)) {
      return false;
    }
    const page = await document.getPage(pageNumber);
    const [vx0, vy0, vx1, vy1] = page.view;
    const rotation = page.rotate + this.viewer.pagesRotation;
    const boxes = markBoxes(rects, vx1 - vx0, vy1 - vy0, rotation);
    if (!boxes.length) {
      return false;
    }
    const element = document_().createElement('div');
    element.className = 'citeMark';
    element.setAttribute('aria-hidden', 'true');
    for (const { box, block } of boxes) {
      const part = document_().createElement('div');
      part.className = block ? 'citeMark-block' : 'citeMark-line';
      Object.assign(part.style, {
        left: `${box[0] * 100}%`,
        top: `${box[1] * 100}%`,
        width: `${(box[2] - box[0]) * 100}%`,
        height: `${(box[3] - box[1]) * 100}%`,
      });
      element.append(part);
    }
    this.shown = { page: pageNumber, boxes, element };
    this.scrollTo(this.shown);
    this.attach(pageNumber);
    // The ring plays once the page is drawn, so it is seen; then the mark rests, so that pdf.js
    // drawing the page again (which re-attaches the mark) does not play it again.
    const arrive = () => {
      element.classList.add('arriving');
      setTimeout(() => element.classList.replace('arriving', 'rested'), ARRIVAL_MS);
    };
    const pageView = this.viewer.getPageView(pageNumber - 1);
    if (pageView?.renderingState === 3 /* FINISHED */) {
      arrive();
    } else {
      const timer = setTimeout(arrive, 600);
      const drawn = ({ pageNumber: number }: { pageNumber: number }) => {
        if (number === pageNumber) {
          clearTimeout(timer);
          this.eventBus.off('pagerendered', drawn);
          arrive();
        }
      };
      this.eventBus.on('pagerendered', drawn);
    }
    return true;
  }

  /** Takes the mark away: faded when the reader dismisses it, at once when it is replaced. */
  clear(fade: boolean): void {
    const shown = this.shown;
    this.shown = null;
    if (!shown) {
      return;
    }
    if (!fade || !shown.element.isConnected) {
      shown.element.remove();
      return;
    }
    shown.element.classList.add('leaving');
    setTimeout(() => shown.element.remove(), FADE_MS);
  }

  private attach(pageNumber: number): void {
    const shown = this.shown;
    if (shown?.page !== pageNumber) {
      return;
    }
    const div = this.viewer.getPageView(pageNumber - 1)?.div;
    if (div && shown.element.parentElement !== div) {
      div.append(shown.element);
    }
  }

  private scrollTo({ page, boxes }: Shown): void {
    const div = this.viewer.getPageView(page - 1)?.div as HTMLElement | undefined;
    if (!div) {
      return;
    }
    const pageBox = div.getBoundingClientRect();
    const view = this.container.getBoundingClientRect();
    const pageTop = pageBox.top - view.top + this.container.scrollTop;
    const pageLeft = pageBox.left - view.left + this.container.scrollLeft;
    const left = Math.min(...boxes.map((b) => b.box[0]));
    const top = Math.min(...boxes.map((b) => b.box[1]));
    const right = Math.max(...boxes.map((b) => b.box[2]));
    const bottom = Math.max(...boxes.map((b) => b.box[3]));
    this.container.scrollTop = scrollFor(
      pageTop + top * pageBox.height,
      pageTop + bottom * pageBox.height,
      this.container.clientHeight,
    );
    // Sideways only when zoomed in far enough that the mark is out of view.
    const markLeft = pageLeft + left * pageBox.width;
    const markRight = pageLeft + right * pageBox.width;
    const scrollLeft = this.container.scrollLeft;
    if (markLeft < scrollLeft || markRight > scrollLeft + this.container.clientWidth) {
      this.container.scrollLeft = Math.max(0, (markLeft + markRight) / 2 - this.container.clientWidth / 2);
    }
  }
}

/** The webview's document; the name `document` is taken by the PDF's. */
function document_(): Document {
  return globalThis.document;
}
