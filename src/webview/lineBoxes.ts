/** A box of a selection as pdf.js measures it for a highlight: fractions of the unrotated page. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A selection's boxes joined line by line: one box from a line's first word to its last, as tall as
 * its tallest. pdf.js measures the text layer's spans, and a space the PDF sets as an item of its
 * own gets a span one space of the browser's font wide, however wide the paper made it, so the
 * highlight would have a hole there; small capitals and the like give spans of other heights. Boxes
 * further apart than the line is high stay apart: the gutter between two columns is not highlighted.
 * `aspect` is the page's width over its height.
 *
 * carrel's `src/carrel/static/highlight.js` has the same function; keep the two in step.
 */
export function lineBoxes(boxes: Box[], aspect: number): Box[];
export function lineBoxes(boxes: Box[] | null, aspect: number): Box[] | null;
export function lineBoxes(boxes: Box[] | null, aspect: number): Box[] | null {
  if (!boxes?.length) {
    return boxes;
  }
  const lines: { y: number; height: number; boxes: Box[] }[] = [];
  for (const box of [...boxes].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2))) {
    const line = lines.find((each) => overlap(each, box) >= Math.min(each.height, box.height) / 2);
    if (line) {
      line.boxes.push(box);
      const bottom = Math.max(line.y + line.height, box.y + box.height);
      line.y = Math.min(line.y, box.y);
      line.height = bottom - line.y;
    } else {
      lines.push({ y: box.y, height: box.height, boxes: [box] });
    }
  }
  const joined: Box[] = [];
  for (const line of lines) {
    let run: Box | undefined;
    for (const box of line.boxes.sort((a, b) => a.x - b.x)) {
      if (run && (box.x - (run.x + run.width)) * aspect <= line.height) {
        run.width = Math.max(run.width, box.x + box.width - run.x);
      } else {
        run = { x: box.x, y: line.y, width: box.width, height: line.height };
        joined.push(run);
      }
    }
  }
  return joined;
}

function overlap(a: { y: number; height: number }, b: Box): number {
  return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
}
