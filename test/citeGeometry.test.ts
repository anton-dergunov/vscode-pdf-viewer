import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markBoxes, pageFractions, scrollFor } from '../src/webview/citeGeometry';

// A page 600 × 800 points; the rectangle is in points from the unrotated crop box's top-left.
const R: [number, number, number, number] = [60, 80, 300, 160];

test('unrotated: fractions of the page', () => {
  assert.deepEqual(pageFractions(R, 600, 800, 0), [0.1, 0.1, 0.5, 0.2]);
});

test('turned a quarter clockwise: the top edge goes to the right', () => {
  assert.deepEqual(pageFractions(R, 600, 800, 90), [0.8, 0.1, 0.9, 0.5]);
});

test('turned upside down, and three quarters', () => {
  assert.deepEqual(pageFractions(R, 600, 800, 180), [0.5, 0.8, 0.9, 0.9]);
  assert.deepEqual(pageFractions(R, 600, 800, 270), [0.1, 0.5, 0.2, 0.9]);
  assert.deepEqual(pageFractions(R, 600, 800, -90), pageFractions(R, 600, 800, 270));
});

test('clipped to the page; off the page is nothing', () => {
  assert.deepEqual(pageFractions([-10, -10, 60, 80], 600, 800, 0), [0, 0, 0.1, 0.1]);
  assert.equal(pageFractions([610, 10, 700, 20], 600, 800, 0), null);
});

test('a line gets a little padding, a block more, and an outline', () => {
  const [line, block] = markBoxes(
    [
      [100, 100, 200, 110],
      [100, 200, 300, 400],
    ],
    1000,
    1000,
    0,
  );
  assert.equal(line.block, false);
  assert.deepEqual(line.box, [0.098, 0.0985, 0.202, 0.1115]);
  assert.equal(block.block, true);
  assert.deepEqual(block.box, [0.094, 0.194, 0.306, 0.406]);
});

test('scroll: a mark is centred, a tall one starts near the top', () => {
  assert.equal(scrollFor(1000, 1100, 600), 750);
  assert.equal(scrollFor(1000, 1500, 600), 900);
  assert.equal(scrollFor(10, 20, 600), 0);
});
