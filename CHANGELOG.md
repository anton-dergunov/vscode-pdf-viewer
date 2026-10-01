# Changelog

All notable changes to PDF Viewer are listed here.

## [0.3.0] - 2026-10-01

Open a paper at the exact place being discussed: a section, a table, a figure or a page.

### Added

- **Links to a place in a PDF.** A link like
  `http://pdf.invalid/<path>.pdf?dest=section.4.3&page=6` opens the PDF in VS Code and jumps to
  that section, table, figure or page. Clicked in the Claude Code chat, it opens the paper next to
  the chat instead of in a browser. This needs a one-time setup; see the README.
- **A link can mark a phrase.** Add `search=<phrase>` to find and mark it on that page.
- **One tab per paper.** A link to a paper that is already open moves its tab to the new place
  instead of opening a second copy. Papers opened from links stay open when you open another one.
- **`vscode://` links** of the same form, for notes kept outside VS Code.
- **Open PDF at a Page or Section** command, which asks for a file and a page or section.
- **`pdfViewer.pdfRoot` setting:** the folder that relative paths in links are resolved against.
- **Reload on change.** When the PDF changes on disk, for example after highlights sync from
  another device, the open tab reloads and keeps your place. If you have unsaved highlights, the
  tab is left alone and you get a warning instead.

### Fixed

- Following a link inside a PDF (a reference, a "see Section 4") to a distant page no longer
  lands half a page away from the target.
- Jumping to a section or table keeps the heading or caption in view instead of just above the
  top edge.

## [0.2.0] - 2026-10-01

A rewrite of the first prototype. It works the same way but is faster and more precise.

### Added

- **Page turning by swipe.** A horizontal trackpad swipe or tilt-wheel turns exactly one page.
- **Pinch and Ctrl+scroll zoom** around the pointer.
- **Undo and redo** for highlight changes, including removed highlights.
- **Recolor or delete a single highlight.** In highlight mode, click it.
- **Links inside the PDF** (references, table of contents, cross-references) now work.

### Changed

- Highlights follow the selected text exactly, without spilling into spaces or neighboring words.
- Search marks every match and makes the current one stand out. Match boxes cover just the word.
- Zooming keeps your place instead of jumping to another page, and 100% now means actual size.
- Saving works like any other file in VS Code: the tab shows unsaved changes, Ctrl/Cmd+S saves,
  closing asks first, and unsaved highlights survive a restart.
- Highlights are added to the PDF without rewriting the rest of the file. Highlights made in other
  apps keep their notes and dates.
- Clearer icons for the text selection and eraser tools. The color picker shows its colors.
- PDFs open in this viewer by default.

## [0.1.0] - 2026-10-01

First prototype:

- PDFs open in VS Code in the editor's color theme.
- An auto-hiding toolbar holds page navigation, zoom and text search.
- Highlights come in six colors, are saved into the PDF, and can be removed with an eraser.

[0.3.0]: https://github.com/anton-dergunov/vscode-pdf-viewer/releases/tag/v0.3.0
[0.2.0]: https://github.com/anton-dergunov/vscode-pdf-viewer/tree/v0.2.0
[0.1.0]: https://github.com/anton-dergunov/vscode-pdf-viewer/tree/v0.1.0
