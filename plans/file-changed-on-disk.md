# A calm notice when the PDF changes on disk

Status: done.

## The problem

When the open PDF changed on disk while the viewer held unsaved highlights, a VS Code warning toast said so and faded, and the next Save wrote over the other device's change with no further word.

## What was built

- **A bar at the top of the viewer** (`src/webview/notice.ts`) says the file changed on disk. It stays until the reader saves, reloads (its Reload button runs VS Code's Revert) or dismisses it, and moves below the toolbar while the toolbar is shown.
- **A brief note** that fades after a few seconds when a clean viewer reloads, adding that earlier changes can no longer be undone when highlights were changed in the tab.
- **Save merges** (`src/webview/mergePlan.ts`): the viewer replays its unsaved highlight changes onto the newer file through pdf.js, as an incremental update. After a merge the viewer reloads the merged file, since its next changes must be added to that.
- **When a merge isn't safe**, Save asks Overwrite / Reload in a modal; dismissing it rejects the save.
- Undoing every unsaved change while the file differs on disk reloads the file.

## Decisions

- Placement: a thin bar in the viewer, not a VS Code notification.
- The merge replays pdf.js's serialized changes, not raw bytes. Changes to highlights that were in the loaded file refer to their objects by reference, so they are replayed only when the newer file is the last loaded or saved bytes with more appended; after a full rewrite (e.g. by PDFKit), only new highlights are.
- Each save writes every change since the file was loaded, so the viewer keeps a snapshot of what the last save wrote and replays only the difference. A highlight saved earlier in the tab and changed again since can't be placed in the newer file (its reference there is unknown), so that case asks Overwrite / Reload.
- Per highlight, the later save wins.

## Known limits

- With `files.autoSave: afterDelay`, a conflict brings the dialog back on each auto-save until it is answered.
- After any reload, VS Code keeps the edit steps from before it; undoing past the reload marks the document unsaved without changing anything. The reload and merge notes say so.
