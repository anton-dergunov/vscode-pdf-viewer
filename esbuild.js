const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

async function main() {
  // Ensure dist directories exist
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(__dirname, 'dist', 'media'), { recursive: true });
  fs.mkdirSync(path.join(__dirname, 'dist', 'webview'), { recursive: true });

  // 1. Build Extension Host entry point
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: true,
  });

  // 2. Build Webview JS
  const webviewCtx = await esbuild.context({
    entryPoints: ['src/webview/viewer.js'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile: 'dist/webview/viewer.js',
    sourcemap: true,
  });

  // Copy static assets (HTML, CSS, PDF.js assets)
  function copyStaticAssets() {
    fs.copyFileSync(
      path.join(__dirname, 'src/webview/viewer.html'),
      path.join(__dirname, 'dist/webview/viewer.html')
    );
    fs.copyFileSync(
      path.join(__dirname, 'src/webview/viewer.css'),
      path.join(__dirname, 'dist/webview/viewer.css')
    );

    const pdfjsDistDir = path.join(__dirname, 'dist/media/pdfjs');
    fs.mkdirSync(pdfjsDistDir, { recursive: true });
    
    fs.copyFileSync(
      path.join(__dirname, 'media/pdfjs/pdf.min.js'),
      path.join(pdfjsDistDir, 'pdf.min.js')
    );
    fs.copyFileSync(
      path.join(__dirname, 'media/pdfjs/pdf.worker.min.js'),
      path.join(pdfjsDistDir, 'pdf.worker.min.js')
    );
    fs.copyFileSync(
      path.join(__dirname, 'media/pdfjs/pdf-lib.min.js'),
      path.join(pdfjsDistDir, 'pdf-lib.min.js')
    );

    console.log('[esbuild] Copied webview static assets & pdfjs runtime.');
  }

  copyStaticAssets();

  if (isWatch) {
    await extensionCtx.watch();
    await webviewCtx.watch();
    console.log('[esbuild] Watching for changes...');
  } else {
    await extensionCtx.rebuild();
    await extensionCtx.dispose();
    await webviewCtx.rebuild();
    await webviewCtx.dispose();
    console.log('[esbuild] Build complete.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
