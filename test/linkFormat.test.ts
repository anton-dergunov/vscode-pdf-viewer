import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTargetParts } from '../src/shared/linkFormat';

// The inputs are what `vscode.Uri` gives for a link's path and query: already percent-decoded.

test('file in the path, with destination and page', () => {
  assert.deepEqual(parseTargetParts('/llm/memory/Zep. A Temporal Knowledge Graph.pdf', 'dest=table.2&page=7'), {
    file: 'llm/memory/Zep. A Temporal Knowledge Graph.pdf',
    dest: 'table.2',
    page: 7,
    search: undefined,
  });
});

test('"&" survives in the file name and in the search phrase', () => {
  assert.deepEqual(parseTargetParts('/recsys/Wide & Deep Learning.pdf', 'page=2&search=wide & deep'), {
    file: 'recsys/Wide & Deep Learning.pdf',
    page: 2,
    dest: undefined,
    search: 'wide & deep',
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
  });
});
