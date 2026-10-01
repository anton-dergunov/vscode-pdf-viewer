import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseTargetParts, type PdfTarget } from './shared/linkFormat';

export type { PdfTarget };

/**
 * Paper links look like `http://pdf.invalid/<file path>?dest=table.2&page=7&search=…`.
 *
 * - They have to be http: the Claude Code chat panel strips other schemes.
 * - `.invalid` is reserved and never resolves, so if the extension is not running, a click fails
 *   harmlessly in the browser instead of reaching a real website.
 * - Not `.localhost`: VS Code's integrated browser claims localhost links before any extension.
 */
export const LINK_HOST = 'pdf.invalid';

/** Parses a paper link (`http://pdf.invalid/…`) or a `vscode://` link with the same path and query. */
export function parseTarget(uri: vscode.Uri): PdfTarget | undefined {
  return parseTargetParts(uri.path, uri.query);
}

/** Resolves an absolute path, or one relative to the `pdfViewer.pdfRoot` setting. */
export function resolvePdfFile(file: string): vscode.Uri {
  const expand = (p: string) => (p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p);
  const expanded = expand(file);
  if (path.isAbsolute(expanded)) {
    return vscode.Uri.file(expanded);
  }
  const root = vscode.workspace.getConfiguration('pdfViewer').get<string>('pdfRoot', '');
  return vscode.Uri.file(path.resolve(expand(root), expanded));
}
