---
name: run-vscode-pdf-viewer
description: Build, launch and drive the PDF Viewer extension in a real VS Code window (Extension Development Host) to see a change working - open a PDF, make or erase highlights, save, simulate another device changing the file on disk, read the viewer's state and take screenshots. Use when asked to run, start, debug, try out, verify or screenshot the extension.
---

The extension runs in an Extension Development Host: the installed VS Code, started with a
throwaway profile and a Chrome DevTools Protocol port. Three scripts in this folder drive it:

- `launch.sh start|stop`: builds, launches, opens a PDF and waits until the viewer has loaded it.
- `drive.mjs <command>`: one action or query per run, over CDP. It has no dependencies (Node 22+).
- `disk.mjs`: acts as another device that changes the PDF on disk, using the repo's own pdf.js.
  It also generates the test PDF.

All paths are relative to the repository root. Verified on macOS with VS Code 1.144 and Node 24.
The window opens on the real screen (not headless), so don't type into it while driving.

## Prerequisites

- VS Code at `/Applications/Visual Studio Code.app`. Set `CODE_BIN` (the Electron binary) and
  `CODE_CLI` (its `bin/code`) for another install. Linux is untested; it would also need `xvfb-run`.
- `npm install` has been run, since `disk.mjs` and the build use `node_modules`.

## Run (agent path)

```bash
D=.claude/skills/run-vscode-pdf-viewer
F=/tmp/pdfv/ws/paper.pdf
$D/launch.sh start                 # build, launch, open a generated 2-page PDF; prints "ready: …"
node $D/drive.mjs state            # JSON: notice bar text and buttons, unsaved tab, page, dialog, notifications
node $D/drive.mjs ss 01-start      # screenshot -> /tmp/pdfv/shots/01-start.png (look at it)
$D/launch.sh stop
```

`launch.sh start my.pdf` opens another PDF instead. The generated one has 30 text lines a page and
one purple highlight on page 2 that is already in the file.

### drive.mjs commands

| command | does |
|---|---|
| `state` | viewer and VS Code state as JSON (start here) |
| `ss <name>` | screenshot of the whole window -> `/tmp/pdfv/shots/<name>.png` |
| `goto <page>` | go to a page |
| `tool select\|highlight\|eraser` | pick a toolbar tool |
| `spans <page> [regex]` | list text spans with their indices |
| `select <page> <from> [to]` | drag across spans; with the highlight tool, makes a highlight |
| `click-highlight <page> [n]` | click a highlight; with the eraser, removes it |
| `click <css>` | DOM click in the viewer: `#save`, `#notice-reload`, `#notice-overwrite`, `#notice-close`, `#find-toggle` |
| `toolbar show\|hide` | the toolbar auto-hides; this shows it |
| `key <combo>` | key press to the focused element: `Meta+z`, `Meta+Shift+z`, `Meta+s`, `Escape`, `Enter` |
| `eval <js>` | run JS in the viewer (`d` = document, `w` = window), `return` a value |
| `wb-eval <js>` | run JS in the VS Code workbench page |
| `dialog <label>` | click a VS Code dialog button (launch.sh makes dialogs DOM-based) |

### disk.mjs ("another device")

```bash
node $D/disk.mjs list $F           # highlights in the file: page, object ref, color
node $D/disk.mjs append $F 210     # add highlight rgb(210,200,0) to page 1 as an appended update
node $D/disk.mjs rewrite $F 230    # same, then change an earlier byte, so the file is no longer an append
node $D/disk.mjs fixture $F        # regenerate the test PDF
```

### Example: changed on disk, merge on Save, conflict bar

```bash
node $D/drive.mjs tool highlight && node $D/drive.mjs select 1 2   # unsaved highlight
node $D/disk.mjs append $F 220 && sleep 1.5                       # other device adds one
node $D/drive.mjs state            # notice: "… changed on disk …", buttons [Reload]
node $D/drive.mjs click '#save' && sleep 2
node $D/disk.mjs list $F           # both highlights are in the file
node $D/drive.mjs goto 2 && node $D/drive.mjs tool eraser && node $D/drive.mjs click-highlight 2
node $D/disk.mjs rewrite $F 230 && sleep 1.5
node $D/drive.mjs click '#save' && sleep 2
node $D/drive.mjs state            # notice: "Not saved: …", buttons [Reload, Overwrite], tab unsaved
```

Allow about 1.5 s after a disk change: the viewer waits 500 ms for the file to settle.

## Run (human path)

Press F5 in VS Code ("Run Extension" in `.vscode/launch.json`).

## Test

```bash
npm run check    # type-check host and webview
npm test         # unit tests, plus test/merge.test.ts, which merges through real pdf.js in Node
```

For merge logic, `test/merge.test.ts` is the fastest place to try a case. It calls `mergeChanges`
from `src/webview/mergePlan.ts` without VS Code.

## Gotchas

- **Launching from a shell inside VS Code** (e.g. Claude Code's extension) inherits
  `ELECTRON_RUN_AS_NODE=1`. Code then starts as plain Node and prints
  `bad option: --user-data-dir=…`. `launch.sh` unsets it and the other `VSCODE_*` variables.
- **The profile path must be short.** VS Code puts its IPC socket in `--user-data-dir`, and macOS
  caps socket paths at 103 characters. A long path (e.g. a scratchpad folder) fails with
  `listen EINVAL … 1.14-main.sock`. Hence `/tmp/pdfv` (override: `PDFV_DIR`).
- **A PDF passed at launch can open as plain text.** It may open before the extension's custom
  editor is registered. `launch.sh` opens the folder first, then hands the PDF to the running
  instance with `code --reuse-window`.
- **Each start wipes the profile.** Otherwise VS Code restores the last run's tabs, including any
  plain-text tab of the PDF.
- **`pkill` without `-9` may not quit it.** A window with unsaved editors waits on a "save
  changes?" prompt, keeps the CDP port, and the next launch connects to the old browser.
  `launch.sh stop` uses `-9`.
- **The viewer is an out-of-process iframe.** Playwright's `connectOverCDP` lists only the
  workbench frame, so `drive.mjs` connects to the webview's own CDP target (type `iframe`, URL
  `vscode-webview://…`). The viewer's document is that page's `#active-frame` iframe.
- **Mouse input** goes to the workbench target in page coordinates: the webview iframe's offset
  plus the element's box in the viewer. `select` and `click-highlight` do this.
- **pdf.js in Node** (`disk.mjs`, `test/merge.test.ts`) needs `Uint8Array.prototype.toHex`,
  `Math.sumPrecise` and `Map.prototype.getOrInsertComputed`, which Node 24 lacks. Both files
  define them. pdf.js also warns to use the legacy build; that warning is harmless.
- **Dialogs** are native on macOS and can't be clicked through CDP. `launch.sh` sets
  `window.dialogStyle: custom`, so `dialog <label>` can click them.

## Troubleshooting

- `ERROR: target not found`: VS Code isn't running on the port, or the PDF opened as text (no
  webview). Check `state` and a screenshot, then run `launch.sh start` again.
- `timed out; see /tmp/pdfv/code.log`: read the log. A `bad option` line means
  `ELECTRON_RUN_AS_NODE` leaked; an `EINVAL` line means the profile path is too long.
- The viewer shows old behavior: the webview loads `dist/`. Run `launch.sh start` again; it
  rebuilds.
