# PDF Viewer for VS Code

A minimal PDF viewer with highlighting and search that blends in with your VS Code theme.

## Features

- **Opens PDFs directly in VS Code.** Clicking a `.pdf` file opens it in the viewer.
- **Auto-hiding toolbar.** Move the pointer to the top edge to reveal page navigation, zoom, tools, search and save.
- **Highlighting.** Pick the highlighter, choose one of six colors and select text. Highlights follow the text exactly.
- **Eraser.** With the eraser tool, click any highlight to remove it, including highlights made in other apps. Undo with Ctrl/Cmd+Z.
- **Recolor or delete a single highlight.** In highlight mode, click a highlight to change its color or delete it.
- **Saved into the PDF.** Highlights are stored as standard PDF annotations, so other PDF readers show them too. Unsaved changes mark the tab as modified; save with Ctrl/Cmd+S or the Save button.
- **Search.** Ctrl/Cmd+F opens the find bar. All matches are marked and the current one stands out. Enter and Shift+Enter move between matches.
- **Zoom.** Preset levels, page width and page fit, the +/− buttons, or Ctrl+scroll / trackpad pinch. Zooming keeps your place in the document.
- **Page navigation.** Previous/next buttons, a page number field, the Left/Right arrow keys, or a horizontal swipe / tilt-wheel to move one page at a time.
- **Theme-aware.** The toolbar and background follow the current VS Code color theme.

## Development

```bash
npm install
npm run build     # or: npm run watch
npm run check     # type-check the extension and the webview
```

Press F5 in VS Code ("Run Extension") to start an Extension Development Host with the viewer loaded, then open any PDF.

## Install locally

```bash
npm run package
code --install-extension vscode-pdf-viewer-0.2.0.vsix
```
