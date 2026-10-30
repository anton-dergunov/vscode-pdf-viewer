# A calm notice when the PDF changes on disk

Status: to do. Small.

## The problem

When the open PDF changes on disk (a highlight made on the iPad in carrel syncs back, or another app writes it), the viewer does one of two things (`reloadFromDisk` in `src/pdfEditor.ts`):

- **No unsaved highlights:** it reloads in place, keeping the page, and says nothing.
- **Unsaved highlights:** it keeps them and shows a VS Code warning toast: "… changed on disk. Your unsaved highlights are kept; saving will overwrite the file." The toast fades, and the next Save then writes over the other device's change with no further word.

What is wanted:

1. **A calm notice in the viewer** that the file was changed elsewhere. It should be informative, not alarming: a quiet line or bar in the viewer rather than a warning popup, and it stays until it is dealt with or dismissed.
2. **A second message when the reader acts on it**, above all on Save: the file on disk is newer than what the viewer holds, so saving would drop the other change. Offer the choices there, as VS Code does for a text file saved over a newer one:
   - **Overwrite**: save anyway.
   - **Reload**: take the file from disk and drop the unsaved highlights. VS Code's Revert already does this (`revertCustomDocument`).

## Open questions

- Should a silent reload (no unsaved highlights) also get a brief, self-dismissing note such as "Reloaded: changed on disk"? A highlight appearing out of nowhere can be confusing, but most of these reloads are the reader's own syncs.
- Where should the notice sit: the viewer's own toolbar or a thin bar under it (like carrel's `#pdf-notice`), or VS Code's notification area at information level?
- Could Save compare the file's bytes and merge instead of choosing? Both sides' highlights are incremental updates on the same base, so applying the viewer's new annotations on top of the newer file might be possible. That is probably a separate, larger task.

## Notes for whoever picks it up

- The host already knows when the file on disk differs from `document.data` (`sameBytes` in `reloadFromDisk`); keep a "changed on disk" flag on `PdfDocument`, clear it on save, revert and reload, and post it to the webview for the notice.
- The check on Save belongs in `saveCustomDocumentAs`, before `writeFile`: read the file, compare it with `document.data` (the bytes last loaded or saved), and ask with a modal `showWarningMessage` and its two choices. Cancelling must reject the save, so the document stays unsaved.
- Related limit: after a reload, VS Code keeps the edit steps from before it, and undoing past the reload marks the document unsaved without changing anything. A notice that a reload happened is a good place to say nothing earlier can be undone.
- Release notes (`CHANGELOG.md`): describe only what the reader sees.
