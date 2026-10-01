// Prints the CHANGELOG.md section for one version, for use as GitHub release notes.
// Usage: node scripts/release-notes.mjs 0.3.0
import { readFileSync } from 'node:fs';

const version = process.argv[2];
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const lines = changelog.split('\n');
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
const end = lines.findIndex((line, i) => i > start && /^## |^\[[^\]]+\]: /.test(line));
console.log(lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim());
