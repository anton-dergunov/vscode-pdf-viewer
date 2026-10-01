import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const pdfjsDir = 'node_modules/pdfjs-dist';

if (production) {
  rmSync('dist', { recursive: true, force: true });
}

/** Copies the pdf.js runtime files the webview loads by URL rather than through the bundle. */
const copyPdfjsAssets = {
  name: 'copy-pdfjs-assets',
  setup(build) {
    build.onEnd(() => {
      mkdirSync('dist/pdfjs', { recursive: true });
      cpSync(`${pdfjsDir}/build/pdf.worker.min.mjs`, 'dist/pdfjs/pdf.worker.min.mjs');
      for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        cpSync(`${pdfjsDir}/${dir}`, `dist/pdfjs/${dir}`, { recursive: true });
      }
    });
  },
};

/** Prints errors in the format the `$esbuild-watch` problem matcher expects. */
const logBuild = {
  name: 'log-build',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const { text, location } of [...result.errors, ...result.warnings]) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
      }
      console.log('[watch] build finished');
    });
  },
};

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: watch ? 'silent' : 'warning',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
    plugins: watch ? [logBuild] : [],
  }),
  esbuild.context({
    ...common,
    entryPoints: { main: 'src/webview/main.ts', style: 'src/webview/main.css' },
    outdir: 'dist/webview',
    format: 'esm',
    platform: 'browser',
    // VS Code webviews run on Electron's Chromium.
    target: 'chrome120',
    loader: { '.svg': 'dataurl', '.gif': 'dataurl' },
    plugins: watch ? [logBuild, copyPdfjsAssets] : [copyPdfjsAssets],
  }),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
