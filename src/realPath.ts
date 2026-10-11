import { realpath } from 'node:fs/promises';

/**
 * The path with symlinks resolved, so one file reached by two paths (a symlinked folder and its
 * target) compares equal. NFC, because macOS can return a name in decomposed form. A path that
 * cannot be resolved is returned as given.
 */
export async function canonicalPath(fsPath: string): Promise<string> {
  try {
    return (await realpath(fsPath)).normalize('NFC');
  } catch {
    return fsPath.normalize('NFC');
  }
}
