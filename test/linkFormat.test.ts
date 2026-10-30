import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRects, parseTargetParts } from '../src/shared/linkFormat';

// The inputs are what `vscode.Uri` gives for a link's path and query: already percent-decoded.

test('file in the path, with destination and page', () => {
  assert.deepEqual(parseTargetParts('/llm/memory/Zep. A Temporal Knowledge Graph.pdf', 'dest=table.2&page=7'), {
    file: 'llm/memory/Zep. A Temporal Knowledge Graph.pdf',
    dest: 'table.2',
    page: 7,
    search: undefined,
    rect: undefined,
  });
});

test('"&" survives in the file name and in the search phrase', () => {
  assert.deepEqual(parseTargetParts('/recsys/Wide & Deep Learning.pdf', 'page=2&search=wide & deep'), {
    file: 'recsys/Wide & Deep Learning.pdf',
    page: 2,
    dest: undefined,
    search: 'wide & deep',
    rect: undefined,
  });
});

test('"+" in the file name is kept, not read as a space', () => {
  assert.equal(parseTargetParts('/graphs/Node2vec+.pdf', '')?.file, 'graphs/Node2vec+.pdf');
});

test('/open?file= form, for absolute paths', () => {
  assert.deepEqual(parseTargetParts('/open', 'file=/Users/me/x & y.pdf&page=3'), {
    file: '/Users/me/x & y.pdf',
    page: 3,
    dest: undefined,
    search: undefined,
    rect: undefined,
  });
});

test('links without a file are rejected', () => {
  assert.equal(parseTargetParts('/open', 'page=3'), undefined);
  assert.equal(parseTargetParts('/', ''), undefined);
});

test('invalid or empty values are ignored', () => {
  assert.deepEqual(parseTargetParts('/a.pdf', 'page=0&dest='), {
    file: 'a.pdf',
    page: undefined,
    dest: undefined,
    search: undefined,
    rect: undefined,
  });
});

test('rectangles beside a page, a destination and a title with "&"', () => {
  assert.deepEqual(parseTargetParts('/recsys/Wide & Deep.pdf', 'page=7&rect=71,402,541,520;71,522,300,534&dest=table.2'), {
    file: 'recsys/Wide & Deep.pdf',
    page: 7,
    dest: 'table.2',
    search: undefined,
    rect: [
      [71, 402, 541, 520],
      [71, 522, 300, 534],
    ],
  });
});

test('rectangles that are not four numbers in order are left out', () => {
  assert.deepEqual(parseRects('1,2,3,4;5,6,7;9,9,1,1;a,b,c,d;1.5,2.5,3.5,4.5'), [
    [1, 2, 3, 4],
    [1.5, 2.5, 3.5, 4.5],
  ]);
  assert.equal(parseRects(''), undefined);
  assert.equal(parseRects('1,2,,4'), undefined);
  assert.equal(parseTargetParts('/a.pdf', 'page=2&rect=nothing')?.rect, undefined);
});
