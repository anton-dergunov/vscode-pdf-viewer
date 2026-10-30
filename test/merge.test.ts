import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { mergeChanges, snapshotOf, type Change } from '../src/webview/mergePlan';

// pdf.js uses a few methods that browsers have and Node 24 does not yet.
const bytes = (a: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
Object.assign(Uint8Array.prototype, {
  toHex(this: Uint8Array) {
    return bytes(this).toString('hex');
  },
});
Object.assign(Math, {
  sumPrecise: (values: Iterable<number>) => [...values].reduce((sum, value) => sum + value, 0),
});
for (const MapType of [Map, WeakMap]) {
  Object.assign(MapType.prototype, {
    getOrInsertComputed(this: Map<unknown, unknown>, key: unknown, make: (key: unknown) => unknown) {
      if (!this.has(key)) {
        this.set(key, make(key));
      }
      return this.get(key);
    },
  });
}
GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.resolve('node_modules/pdfjs-dist/build/pdf.worker.mjs'),
).href;

const BLANK = new TextEncoder().encode(`%PDF-1.7
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
trailer << /Root 1 0 R /Size 4 >>
%%EOF
`);

/** A new highlight as `HighlightEditor.serialize` gives it, told apart by its red value. */
function highlight(red: number, y: number): Change {
  const box = [10, y, 60, y, 60, y + 10, 10, y + 10];
  return {
    annotationType: 9, // HIGHLIGHT
    color: [red, 0, 0],
    opacity: 1,
    thickness: 12,
    quadPoints: new Float32Array([10, y + 10, 60, y + 10, 10, y, 60, y]),
    outlines: [box],
    pageIndex: 0,
    rect: [10, y, 60, y + 10],
    rotation: 0,
    structTreeParentId: null,
    popupRef: '',
  } as Change;
}

/** Errors only: the main build warns that Node should use the legacy one. */
const open = (data: Uint8Array) => getDocument({ data: data.slice(), verbosity: 0 });

const key = (n: number) => `pdfjs_internal_editor_${n}`;

async function save(data: Uint8Array, changes: Map<string, Change>): Promise<Uint8Array> {
  const task = open(data);
  const document = await task.promise;
  for (const [k, change] of changes) {
    document.annotationStorage.setValue(k, change);
  }
  const saved = await document.saveDocument();
  await task.destroy();
  return saved;
}

async function highlights(data: Uint8Array): Promise<{ id: string; red: number }[]> {
  const task = open(data);
  const document = await task.promise;
  const annotations = await (await document.getPage(1)).getAnnotations();
  await task.destroy();
  return annotations
    .filter((a: { subtype: string }) => a.subtype === 'Highlight')
    .map((a: { id: string; color: Uint8ClampedArray }) => ({ id: a.id, red: a.color[0] }));
}

function startsWith(a: Uint8Array, prefix: Uint8Array): boolean {
  return a.length > prefix.length && bytes(a).subarray(0, prefix.length).equals(bytes(prefix));
}

test("Save adds this tab's highlight changes to a file another device appended to", async () => {
  // The file as opened: one highlight already in it.
  const loaded = await save(BLANK, new Map([[key(0), highlight(10, 10)]]));
  const [existing] = await highlights(loaded);

  // This tab adds h1 and saves.
  const first = new Map([[key(1), highlight(20, 30)]]);
  const savedHere = await save(loaded, first);

  // Another device adds h2 to the saved file.
  const disk = await save(savedHere, new Map([[key(9), highlight(30, 50)]]));
  assert.ok(startsWith(disk, savedHere), 'pdf.js appends its updates');

  // This tab then adds h3 and removes the highlight that was in the file, and saves again.
  const now = new Map<string, Change>([
    ...first,
    [key(2), highlight(40, 70)],
    [key(3), { id: existing.id, deleted: true, pageIndex: 0, popupRef: '' } as Change],
  ]);
  const merged = await mergeChanges(open(disk), disk, now, snapshotOf(first), true);
  assert.ok('data' in merged);
  assert.deepEqual((await highlights(merged.data)).map((h) => h.red).sort(), [20, 30, 40]);
});

test('Save refuses to apply a removal by reference to a rewritten file', async () => {
  const loaded = await save(BLANK, new Map([[key(0), highlight(10, 10)]]));
  const [existing] = await highlights(loaded);
  const now = new Map<string, Change>([[key(3), { id: existing.id, deleted: true, pageIndex: 0 }]]);
  const merged = await mergeChanges(open(loaded), loaded, now, new Map(), false);
  assert.ok('conflict' in merged);
});
