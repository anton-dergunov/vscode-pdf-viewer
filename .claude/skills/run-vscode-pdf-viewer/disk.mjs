// Plays "another device" that changes the PDF on disk, using the repo's own pdf.js.
//
//   node disk.mjs fixture <file>        write a 2-page text PDF with one highlight on page 2
//   node disk.mjs list <file>           highlights in the file (page, object ref, color)
//   node disk.mjs append <file> <red>   add a highlight to page 1 as an appended update
//   node disk.mjs rewrite <file> <red>  same, then change an earlier byte: no longer an append
//
// <red> (0-255) tells highlights apart: each gets color rgb(<red>, 200, 0) and its own band near
// the bottom of page 1.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The main pdf.js build uses a few methods that Node (24) lacks; browsers have them.
Uint8Array.prototype.toHex ??= function () {
  return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('hex');
};
Math.sumPrecise ??= (values) => [...values].reduce((a, b) => a + b, 0);
for (const C of [Map, WeakMap]) {
  C.prototype.getOrInsertComputed ??= function (k, make) {
    if (!this.has(k)) this.set(k, make(k));
    return this.get(k);
  };
}

const build = fileURLToPath(new URL('../../../node_modules/pdfjs-dist/build/', import.meta.url));
const { getDocument, GlobalWorkerOptions } = await import(`${build}pdf.mjs`);
GlobalWorkerOptions.workerSrc = `${build}pdf.worker.mjs`;
const open = (data) => getDocument({ data: new Uint8Array(data), verbosity: 0 });

function highlight(red, pageIndex, x, y, w = 228, h = 12) {
  const box = [x, y, x + w, y, x + w, y + h, x, y + h];
  return {
    annotationType: 9, // HIGHLIGHT
    color: [red, 200, 0],
    opacity: 1,
    thickness: 12,
    quadPoints: new Float32Array([x, y + h, x + w, y + h, x, y, x + w, y]),
    outlines: [box],
    pageIndex,
    rect: [x, y, x + w, y + h],
    rotation: 0,
    structTreeParentId: null,
    popupRef: '',
  };
}

async function addHighlights(data, highlights) {
  const task = open(data);
  const doc = await task.promise;
  highlights.forEach((h, i) => doc.annotationStorage.setValue(`pdfjs_internal_editor_disk${Date.now()}_${i}`, h));
  const saved = await doc.saveDocument();
  await task.destroy();
  return Buffer.from(saved);
}

async function list(data) {
  const task = open(data);
  const doc = await task.promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    for (const a of await (await doc.getPage(p)).getAnnotations()) {
      if (a.subtype === 'Highlight') out.push(`p${p} ${a.id} rgb(${[...a.color].join(',')})`);
    }
  }
  await task.destroy();
  return out;
}

/** A plain 2-page Letter PDF with lines of Helvetica text. */
function textPdf() {
  const lines = (page) =>
    Array.from({ length: 30 }, (_, i) => `Page ${page}, line ${i + 1}: the quick brown fox jumps over the lazy dog.`);
  const content = (page) =>
    `BT /F1 12 Tf 72 720 Td 16 TL ${lines(page).map((l) => `(${l}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...[1, 2].map((p) => `<< /Length ${content(p).length} >>\nstream\n${content(p)}\nendstream`),
  ];
  // Line 2 is a binary comment, as in most PDFs; `rewrite` flips a byte in it.
  let pdf = '%PDF-1.7\n%\x81\x81\x81\x81\n';
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const [cmd, file, red] = process.argv.slice(2);
if (cmd === 'fixture') {
  // Page 2, line 1, highlighted purple: a highlight that was already in the file.
  writeFileSync(file, await addHighlights(textPdf(), [{ ...highlight(206, 1, 70, 716, 400), color: [206, 147, 216] }]));
  console.log('fixture:', file);
} else if (cmd === 'list') {
  console.log((await list(readFileSync(file))).join('\n') || '(no highlights)');
} else if (cmd === 'append' || cmd === 'rewrite') {
  const before = readFileSync(file);
  const r = Number(red);
  const out = await addHighlights(before, [highlight(r, 0, 72, 60 + (r % 10) * 14)]);
  if (cmd === 'rewrite') out[10] ^= 1; // a byte of the line-2 comment: same objects, but not an append
  writeFileSync(file, out);
  console.log(`${cmd}: rgb(${r},200,0) on page 1; file is the old one plus more: ${out.subarray(0, before.length).equals(before)}`);
} else {
  console.log('usage: node disk.mjs fixture|list|append|rewrite <file> [red]');
  process.exit(2);
}
