import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { canonicalPath } from '../src/realPath';

test('a file reached through a symlinked folder has the path of the file itself', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pdf-viewer-'));
  try {
    await mkdir(path.join(dir, 'papers'));
    await writeFile(path.join(dir, 'papers', 'Zep.pdf'), '');
    await symlink(path.join(dir, 'papers'), path.join(dir, 'pdf'));
    assert.equal(
      await canonicalPath(path.join(dir, 'pdf', 'Zep.pdf')),
      await canonicalPath(path.join(dir, 'papers', 'Zep.pdf')),
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('a path that does not exist comes back as given', async () => {
  const missing = path.join(tmpdir(), 'pdf-viewer-no-such-folder', 'Zep.pdf');
  assert.equal(await canonicalPath(missing), missing);
});
