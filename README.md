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
- **Reloads when the file changes.** If the PDF changes on disk, for example when highlights made on another device sync back, the open tab reloads and keeps your place. A tab with unsaved highlights is left alone, with a warning.
- **Links to a place in a PDF.** A link like the ones below opens the PDF here, at a section, table, figure or page, and reuses its tab if it is already open. Clicking one in the Claude Code chat opens the paper next to the chat.

## Paper links

```
http://pdf.invalid/<path>?dest=<destination>&page=<n>&search=<text>
```

| Part | Meaning |
|---|---|
| `<path>` | The PDF, relative to the `pdfViewer.pdfRoot` setting (default `~/Yandex.Disk.localized/Papers`). Percent-encode it: spaces as `%20`, and `#`, `?` and `%` too. `&` and `+` can stay as they are. For an absolute path, use `http://pdf.invalid/open?file=<absolute path>&…`. |
| `dest` | A named destination in the PDF. LaTeX papers built with hyperref (most of arXiv) have `section.4`, `subsection.4.3`, `subsubsection.2.2.3`, `table.2`, `figure.3`, `equation.5`. |
| `page` | Page number. Used when `dest` is missing or not found in the PDF. |
| `search` | A phrase to find, starting from that page. |

Example: `[Zep, p. 7, Table 2](http://pdf.invalid/llm/memory/agent/Zep.%20A%20Temporal%20Knowledge%20Graph%20Architecture%20for%20Agent%20Memory.pdf?dest=table.2&page=7)`

Links open the paper as a regular tab (another link never replaces it), next to the chat when the chat is shown as an editor tab.

`pdf.invalid` is a reserved name that never resolves, so if the viewer is not running, a click fails harmlessly in the browser.

The same links also work as `vscode://anton.vscode-pdf-viewer/<path>?…`, for example in notes outside VS Code; the first time, VS Code asks whether to let the extension open it (tick "Do not ask me again"). The **PDF Viewer: Open PDF at a Page or Section** command asks for a file and a page or destination.

### One-time setup for `http` links

Claiming `http` links uses a VS Code API that is still in preview, so it has to be switched on for this extension. Run **Preferences: Configure Runtime Arguments**, add this line to `argv.json`, and restart VS Code:

```jsonc
"enable-proposed-api": ["anton.vscode-pdf-viewer"]
```

Without it, everything else works, and `http://pdf.invalid` links open in the browser instead.

## Development

```bash
npm install
npm run build     # or: npm run watch
npm run check     # type-check the extension and the webview
```

Press F5 in VS Code ("Run Extension") to start an Extension Development Host with the viewer loaded, then open any PDF.

## Install locally

Install the package and do the [one-time setup](#one-time-setup-for-http-links).

```bash
npm run package
code --install-extension vscode-pdf-viewer-0.3.0.vsix
```
