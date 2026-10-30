import type { Rect } from '../shared/messages';

/**
 * Where a citation's mark goes on a page (`citeMark.ts` draws it): the rectangles of a paper link
 * as fractions of the page as shown, and the scroll that brings them into view. carrel draws the
 * same mark (`static/cite-mark.js`); keep the two in step.
 */

/** A rectangle taller than this (points) is a block (a table, a figure, an equation), outlined. */
export const BLOCK_HEIGHT = 24;
/** Space around a line's box and a block's box, in points. */
export const LINE_PAD: [number, number] = [2, 1.5];
export const BLOCK_PAD = 6;
/** Room kept above a block too tall for the view, as a share of the view. */
export const TALL_TOP = 1 / 6;

/** A rectangle as fractions of the page as shown: left, top, right, bottom in [0, 1]. */
export type Fractions = [number, number, number, number];

/**
 * A rectangle in points from the top-left of the unrotated crop box (`width` × `height`), as
 * fractions of the page shown turned clockwise by `rotation` degrees; clipped to the page, and
 * null when nothing of it is on the page.
 */
export function pageFractions(r: Rect, width: number, height: number, rotation: number): Fractions | null {
  const x0 = Math.max(0, r[0]) / width;
  const y0 = Math.max(0, r[1]) / height;
  const x1 = Math.min(width, r[2]) / width;
  const y1 = Math.min(height, r[3]) / height;
  if (!(x0 < x1 && y0 < y1)) {
    return null;
  }
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [1 - y1, x0, 1 - y0, x1];
    case 180:
      return [1 - x1, 1 - y1, 1 - x0, 1 - y0];
    case 270:
      return [y0, 1 - x1, y1, 1 - x0];
    default:
      return [x0, y0, x1, y1];
  }
}

/** A mark's boxes with their padding, as fractions of the page shown, and whether each is a block. */
export function markBoxes(
  rects: Rect[],
  width: number,
  height: number,
  rotation: number,
): { box: Fractions; block: boolean }[] {
  const boxes: { box: Fractions; block: boolean }[] = [];
  for (const r of rects) {
    const block = r[3] - r[1] > BLOCK_HEIGHT;
    const [padX, padY] = block ? [BLOCK_PAD, BLOCK_PAD] : LINE_PAD;
    const box = pageFractions([r[0] - padX, r[1] - padY, r[2] + padX, r[3] + padY], width, height, rotation);
    if (box) {
      boxes.push({ box, block });
    }
  }
  return boxes;
}

/** Where to scroll so a mark's span [top, bottom] (pixels in the scroll content) sits in a view. */
export function scrollFor(top: number, bottom: number, view: number): number {
  const height = bottom - top;
  return Math.max(0, height > view * (1 - 2 * TALL_TOP) ? top - view * TALL_TOP : (top + bottom) / 2 - view / 2);
}
