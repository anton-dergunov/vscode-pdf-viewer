import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolvePdfFile, type PdfTarget } from './links';
import { canonicalPath } from './realPath';
import type { HostMessage, NavTarget, NoticeKind, WebviewMessage } from './shared/messages';

/** What the webview answers a request with: PDF bytes, or why highlights couldn't be merged. */
type RequestResult = { data: Uint8Array } | { conflict: string };

/** A PDF file opened in the viewer. The webview owns the live state; this side owns file I/O. */
class PdfDocument implements vscode.CustomDocument {
  panel: vscode.WebviewPanel | undefined;
  /** The file on disk differs from `data` while the viewer holds unsaved highlights. */
  changedOnDisk = false;
  /** The reader chose Overwrite: the next save replaces the file on disk without merging. */
  overwriteNext = false;
  /**
   * Highlights were changed in this tab. VS Code keeps those edit steps across a reload, but the
   * reloaded viewer can't undo them any more.
   */
  hadEdits = false;
  /** Set once the webview has asked for the document; until then navigation waits for `load`. */
  private loaded = false;
  private pendingTarget: NavTarget | undefined;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<
    number,
    { resolve: (result: RequestResult) => void; reject: (error: Error) => void }
  >();

  constructor(
    readonly uri: vscode.Uri,
    /** The file with symlinks resolved: a link may reach it by another path than the one it was opened by. */
    readonly realPath: string,
    /** The bytes the webview should show next time it (re)loads. */
    public data: Uint8Array,
    private readonly onDispose: () => void,
  ) {}

  /**
   * Whether the viewer holds unsaved changes, as VS Code's tab shows it: VS Code keeps the edits,
   * so it knows when undoing has brought the PDF back to the file, and that a document restored
   * from a backup is not the file.
   */
  get dirty(): boolean {
    return vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.isDirty && isTabOf(tab, this.uri)));
  }

  attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.rejectPending(new Error('The PDF viewer was closed.'));
    });
  }

  post(message: HostMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  /** Sends the current bytes to the webview, along with any navigation requested before it loaded. */
  load(): void {
    this.loaded = true;
    this.post({ type: 'load', data: this.data, dirty: this.dirty, target: this.pendingTarget });
    this.pendingTarget = undefined;
  }

  navigate(target: NavTarget): void {
    if (this.loaded) {
      this.post({ type: 'navigate', target });
    } else {
      this.pendingTarget = target;
    }
  }

  get name(): string {
    return path.basename(this.uri.fsPath);
  }

  notice(kind: NoticeKind, reason?: string): void {
    this.post({ type: 'notice', kind, name: this.name, undoLost: this.hadEdits, reason });
  }

  /**
   * Asks the webview for the current PDF bytes, including unsaved highlight changes. `forSave`:
   * they are about to be written to this PDF's own file.
   */
  async requestBytes(forSave = false): Promise<Uint8Array> {
    if (!this.panel) {
      return this.data;
    }
    const result = await this.request((requestId) => ({ type: 'getBytes', requestId, forSave }));
    if (!('data' in result)) {
      throw new Error(result.conflict);
    }
    return result.data;
  }

  /**
   * Asks the webview to add its unsaved highlight changes to `disk`, the newer file. `appended`:
   * `disk` is the bytes last loaded or saved with more added at the end, so it keeps their objects.
   */
  requestMerge(disk: Uint8Array, appended: boolean): Promise<RequestResult> {
    if (!this.panel) {
      return Promise.resolve({ conflict: 'the viewer is closed' });
    }
    return this.request((requestId) => ({ type: 'merge', requestId, data: disk, appended }));
  }

  settleRequest(requestId: number, result: RequestResult | { error: string }): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(requestId);
    if ('error' in result) {
      pending.reject(new Error(result.error));
    } else {
      pending.resolve(result);
    }
  }

  private request(message: (requestId: number) => HostMessage): Promise<RequestResult> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      this.post(message(requestId));
    });
  }

  dispose(): void {
    this.rejectPending(new Error('The PDF document was closed.'));
    this.onDispose();
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pendingRequests.values()) {
      reject(error);
    }
    this.pendingRequests.clear();
  }
}

function isTabOf(tab: vscode.Tab, uri: vscode.Uri): boolean {
  return (
    tab.input instanceof vscode.TabInputCustom &&
    tab.input.viewType === PdfEditorProvider.viewType &&
    tab.input.uri.toString() === uri.toString()
  );
}

function buffer(a: Uint8Array): Buffer {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return buffer(a).equals(buffer(b));
}

/** Whether `a` is `prefix` with more bytes after it, as when another app appends an update to a PDF. */
function startsWith(a: Uint8Array, prefix: Uint8Array): boolean {
  return a.byteLength > prefix.byteLength && buffer(a).subarray(0, prefix.byteLength).equals(buffer(prefix));
}

/**
 * Reads a file as a plain Uint8Array. `workspace.fs.readFile` returns a Node Buffer, which webview
 * messaging does not recognize as binary data and would serialize as a huge JSON array.
 */
async function readFile(uri: vscode.Uri): Promise<Uint8Array> {
  const data = await vscode.workspace.fs.readFile(uri);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** What two URIs of one file have in common: its real path. Only a `file:` URI has one. */
function documentPath(uri: vscode.Uri): Promise<string> {
  return uri.scheme === 'file' ? canonicalPath(uri.fsPath) : Promise.resolve(uri.toString());
}

export class PdfEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
  static readonly viewType = 'vscode-pdf-viewer.pdfEditor';

  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  /** Open documents by URI. A link to an open file navigates its tab instead of opening another. */
  private readonly documents = new Map<string, PdfDocument>();
  /** Navigation for a document that `open()` is about to create. */
  private readonly pendingTargets = new Map<string, NavTarget>();

  constructor(private readonly context: vscode.ExtensionContext) {
    // The toolbar's Save button follows the tab's unsaved-changes dot.
    context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(({ changed }) => {
        for (const tab of changed) {
          const document = [...this.documents.values()].find((open) => isTabOf(tab, open.uri));
          document?.post({ type: 'dirty', dirty: tab.isDirty });
          // Undoing every unsaved change leaves a clean viewer, which shows the file as it is now.
          if (document?.changedOnDisk && !tab.isDirty) {
            void this.reloadFromDisk(document);
          }
        }
      }),
    );
  }

  /** Opens a PDF in the viewer (or reveals its tab) and goes to the requested place. */
  async open({ file, ...target }: PdfTarget): Promise<void> {
    const uri = resolvePdfFile(file);
    if (!uri) {
      const action = 'Open Settings';
      const choice = await vscode.window.showErrorMessage(
        `PDF Viewer: can't resolve "${file}". Set "pdfViewer.pdfRoot" to the folder that link paths are relative to.`,
        action,
      );
      if (choice === action) {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'pdfViewer.pdfRoot');
      }
      return;
    }
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      void vscode.window.showErrorMessage(`PDF Viewer: no file at ${uri.fsPath}`);
      return;
    }
    const realPath = await documentPath(uri);
    const document = [...this.documents.values()].find((open) => open.panel && open.realPath === realPath);
    if (document?.panel) {
      document.panel.reveal(document.panel.viewColumn);
      document.navigate(target);
      return;
    }
    this.pendingTargets.set(uri.toString(), target);
    // When the link was clicked in a panel shown as an editor tab (e.g. the Claude chat), open the
    // PDF next to it instead of covering it. Not a preview tab: opening another paper must not
    // replace this one.
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const options: vscode.TextDocumentShowOptions = {
      preview: false,
      viewColumn: activeTab?.input instanceof vscode.TabInputWebview ? vscode.ViewColumn.Beside : undefined,
    };
    await vscode.commands.executeCommand('vscode.openWith', uri, PdfEditorProvider.viewType, options);
  }

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<PdfDocument> {
    const key = uri.toString();
    const source = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
    const document = new PdfDocument(
      uri,
      await documentPath(uri),
      await readFile(source),
      () => this.documents.delete(key),
    );
    this.documents.set(key, document);
    const target = this.pendingTargets.get(key);
    if (target) {
      this.pendingTargets.delete(key);
      document.navigate(target);
    }
    return document;
  }

  resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): void {
    const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    panel.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    panel.webview.html = this.getHtml(panel.webview, distUri);
    document.attach(panel);
    this.watchFile(document, panel);

    panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      switch (message.type) {
        case 'ready':
          document.load();
          break;
        case 'edit':
          document.hadEdits = true;
          // VS Code's Undo and Redo hand the step back to the webview, whose history it is.
          this.changeEmitter.fire({
            document,
            label: 'Highlight',
            undo: () => document.post({ type: 'undo' }),
            redo: () => document.post({ type: 'redo' }),
          });
          break;
        case 'save':
          void vscode.commands.executeCommand('workbench.action.files.save');
          break;
        case 'revert':
          void vscode.commands.executeCommand('workbench.action.files.revert');
          break;
        case 'overwrite':
          document.overwriteNext = true;
          void vscode.commands.executeCommand('workbench.action.files.save');
          break;
        case 'bytes':
          document.settleRequest(message.requestId, { data: message.data });
          break;
        case 'bytesError':
          document.settleRequest(message.requestId, { error: message.message });
          break;
        case 'mergeConflict':
          document.settleRequest(message.requestId, { conflict: message.reason });
          break;
        case 'error':
          void vscode.window.showErrorMessage(`PDF Viewer: ${message.message}`);
          break;
      }
    });
  }

  saveCustomDocument(document: PdfDocument): Promise<void> {
    return this.saveCustomDocumentAs(document, document.uri);
  }

  async saveCustomDocumentAs(document: PdfDocument, destination: vscode.Uri): Promise<void> {
    if (destination.toString() !== document.uri.toString()) {
      await vscode.workspace.fs.writeFile(destination, await document.requestBytes());
      return;
    }
    const overwrite = document.overwriteNext;
    document.overwriteNext = false;
    const disk = await readFile(document.uri).catch(() => undefined);
    if (overwrite || !disk || sameBytes(disk, document.data)) {
      return this.writeOwnFile(document);
    }

    // The file changed on disk since it was loaded or saved: add the highlights to it.
    const merged = await document
      .requestMerge(disk, startsWith(disk, document.data))
      .catch((error: Error): RequestResult => ({ conflict: `merging failed (${error.message})` }));
    if ('data' in merged) {
      // Set before writing, so the file watcher recognizes the change as our own.
      document.data = merged.data;
      await vscode.workspace.fs.writeFile(document.uri, merged.data);
      document.changedOnDisk = false;
      // The viewer takes the merged file as what its next changes are added to.
      document.load();
      document.notice('merged');
      return;
    }

    // The bar offers Overwrite and Reload. There is no modal, so no key picks one by accident.
    document.notice('conflict', merged.conflict);
    throw new vscode.CancellationError();
  }

  private async writeOwnFile(document: PdfDocument): Promise<void> {
    const data = await document.requestBytes(true);
    // Set before writing, so the file watcher recognizes the change as our own.
    document.data = data;
    await vscode.workspace.fs.writeFile(document.uri, data);
    document.post({ type: 'saved' });
    if (document.changedOnDisk) {
      document.changedOnDisk = false;
      document.notice('clear');
    }
  }

  async revertCustomDocument(document: PdfDocument): Promise<void> {
    // Cleared first: VS Code marks the tab clean before this finishes, and a clean tab with the
    // file changed on disk would reload it a second time.
    document.changedOnDisk = false;
    document.data = await readFile(document.uri);
    document.load();
  }

  async backupCustomDocument(
    document: PdfDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    await vscode.workspace.fs.writeFile(context.destination, await document.requestBytes());
    return {
      id: context.destination.toString(),
      delete: () => vscode.workspace.fs.delete(context.destination).then(undefined, () => undefined),
    };
  }

  /**
   * Reloads the viewer when the file changes on disk, e.g. when highlights made on another device
   * sync back. Unsaved highlights are never discarded: a dirty viewer is left as it is, with a
   * notice, and Save adds them to the newer file.
   */
  private watchFile(document: PdfDocument, panel: vscode.WebviewPanel): void {
    const folder = vscode.Uri.file(path.dirname(document.uri.fsPath));
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, path.basename(document.uri.fsPath)),
    );
    let timer: NodeJS.Timeout | undefined;
    // Sync tools often write a file in several steps; wait for it to settle.
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void this.reloadFromDisk(document), 500);
    };
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    panel.onDidDispose(() => {
      clearTimeout(timer);
      watcher.dispose();
    });
  }

  private async reloadFromDisk(document: PdfDocument): Promise<void> {
    let data: Uint8Array;
    try {
      data = await readFile(document.uri);
    } catch {
      return; // Deleted or mid-replace; a following create event retries.
    }
    document.overwriteNext = false;
    if (sameBytes(data, document.data)) {
      // Our own save, or the file is back as the viewer has it.
      if (document.changedOnDisk) {
        document.changedOnDisk = false;
        document.notice('clear');
      }
      return;
    }
    if (document.dirty) {
      document.changedOnDisk = true;
      document.notice('changed');
      return;
    }
    document.data = data;
    document.changedOnDisk = false;
    document.load();
    document.notice('reloaded');
  }

  private getHtml(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const asset = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(distUri, ...path)).toString();
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource} data: blob:`,
      `connect-src ${webview.cspSource}`,
      'worker-src blob:',
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('webview', 'style.css')}">
</head>
<body data-pdfjs-root="${asset('pdfjs')}/">
  <script type="module" nonce="${nonce}" src="${asset('webview', 'main.js')}"></script>
</body>
</html>`;
  }
}
