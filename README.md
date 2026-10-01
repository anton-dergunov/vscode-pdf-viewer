# PDF Viewer for VS Code

A minimal PDF viewer for VS Code. It saves your highlights into the PDF file, and its links can open a paper at
a specific section, table, figure or page, including links in the Claude Code chat.

## Why it exists

I read research papers together with Claude Code in VS Code. I ask a question across several
papers, and the answer cites where each idea comes from: "Zep, §4.3", "p. 7, Table 2". I wanted to
click such a citation and land on that exact spot in the PDF, inside VS Code, next to the chat, not
in a browser or a separate app. I also wanted to choose which citations to open myself, rather than
have the agent open files for me.

The PDF viewers I tried for VS Code didn't fit. Some render text poorly, and some can't save
highlights back into the file. More importantly, none of them could be opened at a given page or
section from a link. So this viewer is built around that one feature and otherwise stays small: a theme-aware
page view, a toolbar that hides while you read, highlighting, search, and nothing else.

## Features

- **Opens PDFs directly in VS Code**, in your color theme. Clicking a `.pdf` file opens it here.
- **Auto-hiding toolbar.** Move the pointer to the top edge to reveal page navigation, zoom, tools,
  search and save.
- **Highlighting** in six colors. Highlights follow the selected text exactly and are saved into
  the PDF as standard annotations, so other PDF readers and tablets show them too.
- **Eraser.** Click any highlight to remove it, including highlights made in other apps.
  In highlight mode, click a highlight to recolor or delete it. Ctrl/Cmd+Z undoes.
- **Saving like any other file.** The tab shows unsaved changes, Ctrl/Cmd+S saves, closing asks
  first, and unsaved highlights survive a restart.
- **Search** with Ctrl/Cmd+F. All matches are marked and the current one stands out.
- **Zoom** with presets, page width or page fit, the +/− buttons, Ctrl+scroll or a trackpad pinch.
  Zooming keeps your place.
- **Page navigation** with the buttons, the page field, the ←/→ keys, or a horizontal swipe that
  turns one page at a time.
- **Reloads when the file changes on disk**, keeping your place. If you have unsaved highlights,
  the tab is left alone and you get a warning.
- **Links to a place in a PDF**, from the Claude Code chat or anywhere else. See below.

## Install

1. Download the `.vsix` file from the latest [release](https://github.com/anton-dergunov/vscode-pdf-viewer/releases).
2. Install it with **Extensions: Install from VSIX…** in the command palette, or from a terminal:

   ```bash
   code --install-extension vscode-pdf-viewer-0.3.0.vsix
   ```

The extension isn't published on the Marketplace, because clickable `http` links rely on a VS Code
API that is still in preview (see the setup below).

## Links to a place in a PDF

```
http://pdf.invalid/<path>?dest=<destination>&page=<n>&search=<text>
```

| Part | Meaning |
|---|---|
| `<path>` | The PDF file, relative to the `pdfViewer.pdfRoot` setting. Percent-encode it: spaces as `%20`, and `#`, `?` and `%` if present; `&` and `+` can stay as they are. For an absolute path, use `http://pdf.invalid/open?file=<absolute path>&…`. |
| `dest` | A named destination in the PDF. Papers written in LaTeX (most of arXiv) have `section.4`, `subsection.4.3`, `subsubsection.2.2.3` and `appendix.A`, and often `table.2` and `figure.3`. |
| `page` | The page number. Used when `dest` is missing or isn't in the PDF, so always include it. |
| `search` | A phrase to find and mark, starting from that page. |

For example, with `pdfViewer.pdfRoot` set to `~/Papers`:

```markdown
[Zep, p. 7, Table 2](http://pdf.invalid/llm/memory/Zep.%20A%20Temporal%20Knowledge%20Graph%20Architecture%20for%20Agent%20Memory.pdf?dest=table.2&page=7)
```

- The paper opens as a regular tab, next to the chat when the chat is an editor tab.
- A link to a paper that's already open moves its tab instead of opening a second copy.
- `pdf.invalid` is a reserved name that never resolves, so if the viewer isn't running, a click
  fails harmlessly in the browser and nothing is sent anywhere.

The same links work as `vscode://anton.vscode-pdf-viewer/<path>?…`, for example in notes kept
outside VS Code. The first time, VS Code asks whether to let the extension open such a link; tick
**Do not ask me again**. The **PDF Viewer: Open PDF at a Page or Section** command asks for a file
and a page or section.

### Setup for clickable links in the Claude Code chat

1. Allow the preview API for this extension: run **Preferences: Configure Runtime Arguments**, add
   this line to `argv.json`, and restart VS Code:

   ```jsonc
   "enable-proposed-api": ["anton.vscode-pdf-viewer"]
   ```

   Without it, everything else works, but `http://pdf.invalid` links open in the browser.

2. Set the folder your PDFs live in, in your user settings:

   ```jsonc
   "pdfViewer.pdfRoot": "~/Papers"
   ```

   When it's empty, relative paths are resolved against the first workspace folder.

3. Tell Claude how to write the links, for example in your project's `CLAUDE.md`:

   > When you point me to a specific place in a paper, make the citation a link:
   > `[p. 7, Table 2](http://pdf.invalid/<path under the PDF folder>?dest=table.2&page=7)`.
   > Percent-encode the path. Always include `page`. Add `dest` for the section (`section.4`,
   > `subsection.4.3`), table or figure, and optionally `search=<exact phrase>`. Never open PDFs
   > yourself.

The chat panel only lets `http(s)` links through. The extension claims links to `pdf.invalid`
before VS Code would hand them to the browser.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `pdfViewer.pdfRoot` | empty | The folder that relative paths in links are resolved against. When empty, the first workspace folder is used. |

## Development

```bash
npm install
npm run build     # or: npm run watch
npm run check     # type-check the extension and the webview
npm test          # unit tests
npm run package   # build the .vsix
```

Press F5 in VS Code ("Run Extension") to start an Extension Development Host with the viewer
loaded and the preview API enabled, so `http` links work there too.

- `src/extension.ts`, `src/pdfEditor.ts`: the extension side. This covers the custom editor, saving,
  backups, file watching, and link handling.
- `src/webview/`: the viewer itself, built on [PDF.js](https://mozilla.github.io/pdf.js/).
- `src/shared/`: the message protocol between the two, and the link format.

### Releasing

1. Update `version` in `package.json` and add a section for it to `CHANGELOG.md`.
2. Commit, then tag and push:

   ```bash
   git tag v0.3.0
   git push origin main v0.3.0
   ```

The Release workflow builds the `.vsix` and publishes a GitHub release with that version's
changelog section as its notes.

## License

MIT; see [LICENSE](LICENSE). The extension bundles PDF.js (Apache 2.0) and icons from Lucide (ISC);
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
