import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineBoxes, type Box } from '../src/webview/lineBoxes';

// The cases are carrel's tests/highlight.test.mjs; keep them in step.

const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });
const rounded = (boxes: Box[]) =>
  boxes.map((each) => Object.fromEntries(Object.entries(each).map(([key, value]) => [key, +value.toFixed(4)])));

test('a line with a narrow space between two words is one box', () => {
  const words = [box(0.1, 0.5, 0.2, 0.02), box(0.3, 0.5, 0.005, 0.02), box(0.32, 0.5, 0.2, 0.02)];
  assert.deepEqual(rounded(lineBoxes(words, 1)), [box(0.1, 0.5, 0.42, 0.02)]);
});

test('spans of other heights on a line make it as tall as the tallest', () => {
  const smallCaps = [box(0.1, 0.5, 0.01, 0.02), box(0.11, 0.504, 0.03, 0.016), box(0.14, 0.5, 0.01, 0.02)];
  assert.deepEqual(rounded(lineBoxes(smallCaps, 1)), [box(0.1, 0.5, 0.05, 0.02)]);
});

test('two lines stay two boxes, in order', () => {
  const lines = [box(0.1, 0.52, 0.3, 0.02), box(0.1, 0.5, 0.4, 0.02)];
  assert.deepEqual(rounded(lineBoxes(lines, 1)), [box(0.1, 0.5, 0.4, 0.02), box(0.1, 0.52, 0.3, 0.02)]);
});

test('two columns side by side stay apart', () => {
  const columns = [box(0.1, 0.5, 0.35, 0.02), box(0.5, 0.5, 0.35, 0.02)];
  assert.deepEqual(rounded(lineBoxes(columns, 1)), columns);
});

test("a gap is measured against the line's height in the page's proportions", () => {
  // 0.03 of the width is 0.0225 of the height on a page 3:4, wider than the line.
  const words = [box(0.1, 0.5, 0.2, 0.02), box(0.33, 0.5, 0.2, 0.02)];
  assert.equal(lineBoxes(words, 0.75).length, 2);
  assert.equal(lineBoxes(words, 0.5).length, 1);
});

test('no boxes are left as they are', () => {
  assert.equal(lineBoxes(null, 1), null);
  assert.deepEqual(lineBoxes([], 1), []);
});
