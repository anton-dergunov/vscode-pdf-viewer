import type { NavTarget } from './messages';

export interface PdfTarget extends NavTarget {
  /** Absolute, or relative to the `pdfViewer.pdfRoot` setting. */
  file: string;
}

const PARAMS = ['file', 'dest', 'page', 'search'] as const;

/**
 * Reads a paper link from the path and query of a `vscode.Uri`, which are already percent-decoded:
 *
 *     http://pdf.invalid/<file path>?dest=table.2&page=7&search=…
 *     http://pdf.invalid/open?file=<file path>&dest=…        (also for absolute paths)
 *
 * Because decoding has already turned `%26` into `&`, the query is split only at an `&` that
 * starts a known parameter, so titles like "Wide & Deep" survive in `file` and `search`.
 */
export function parseTargetParts(path: string, query: string): PdfTarget | undefined {
  const params = new Map<string, string>();
  const names = PARAMS.join('|');
  for (const part of query.split(new RegExp(`&(?=(?:${names})=)`))) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      params.set(part.slice(0, eq), part.slice(eq + 1));
    }
  }
  const file = path === '/open' ? params.get('file') : path.replace(/^\//, '');
  if (!file) {
    return undefined;
  }
  const page = Number.parseInt(params.get('page') ?? '', 10);
  return {
    file,
    page: page > 0 ? page : undefined,
    dest: params.get('dest') || undefined,
    search: params.get('search') || undefined,
  };
}
