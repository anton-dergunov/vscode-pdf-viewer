import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planMerge, snapshotOf, type Change } from '../src/webview/mergePlan';

const newHighlight = (pageIndex = 0, color = [255, 235, 59]): Change & { color: number[] } => ({
  pageIndex,
  color,
});
const changed = (id: string, deleted = false): Change => ({ id, pageIndex: 0, deleted });

test('new highlights are added', () => {
  const changes = new Map([['a', newHighlight()]]);
  assert.deepEqual(planMerge(changes, new Map(), false, 1), { apply: [['a', newHighlight()]] });
});

test('changes already written by an earlier save are skipped', () => {
  const saved = new Map([
    ['a', newHighlight()],
    ['b', changed('12R', true)],
  ]);
  const changes = new Map([...saved, ['c', newHighlight(0, [1, 2, 3])]]);
  assert.deepEqual(planMerge(changes, snapshotOf(saved), true, 1), { apply: [['c', newHighlight(0, [1, 2, 3])]] });
});

test('a change to a highlight from the file is added only when the file was appended to', () => {
  const changes = new Map([['b', changed('12R', true)]]);
  assert.deepEqual(planMerge(changes, new Map(), true, 1), { apply: [['b', changed('12R', true)]] });
  assert.ok('conflict' in planMerge(changes, new Map(), false, 1));
});

test('a saved highlight changed again since is a conflict', () => {
  const saved = new Map([['a', newHighlight()]]);
  const changes = new Map([['a', newHighlight(0, [1, 2, 3])]]);
  assert.ok('conflict' in planMerge(changes, snapshotOf(saved), true, 1));
});

test('a saved change that is gone since is a conflict', () => {
  const saved = new Map([['a', newHighlight()]]);
  assert.ok('conflict' in planMerge(new Map(), snapshotOf(saved), true, 1));
});

test('a highlight on a page the file no longer has is a conflict', () => {
  const changes = new Map([['a', newHighlight(3)]]);
  assert.ok('conflict' in planMerge(changes, new Map(), true, 2));
});

test('a recolor of a file highlight saved earlier and changed again is added when appended', () => {
  const saved = new Map([['b', { ...changed('12R'), color: [1, 2, 3] }]]);
  const changes = new Map([['b', { ...changed('12R'), color: [4, 5, 6] }]]);
  assert.deepEqual(planMerge(changes, snapshotOf(saved), true, 1), { apply: [...changes] });
});
