// The viewer component reads the library from `globalThis.pdfjsLib` when its module is evaluated,
// so this module must be imported before `pdfjs-dist/web/pdf_viewer.mjs`.
import * as pdfjsLib from 'pdfjs-dist';

(globalThis as { pdfjsLib?: typeof pdfjsLib }).pdfjsLib = pdfjsLib;
