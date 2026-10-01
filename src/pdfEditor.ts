import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolvePdfFile, type PdfTarget } from './links';
import type { HostMessage, NavTarget, WebviewMessage } from './shared/messages';

/** A PDF file opened in the viewer. The webview owns the live state; this side owns file I/O. */
class PdfDocument implements vscode.CustomDocument {
  panel: vscode.WebviewPanel | undefined;
  /** Set once the webview has asked for the document; until then navigation waits for `load`. */
  private loaded = false;
  private pendingTarget: NavTarget | undefined;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<
    number,
    { resolve: (data: Uint8Array) => void; reject: (error: Error) => void }
  >();

  constructor(
    readonly uri: vscode.Uri,
    /** The bytes the webview should show next time it (re)loads. */
    public data: Uint8Array,
    /** Whether the viewer holds unsaved changes. */
    public dirty: boolean,
    private readonly onDispose: () => void,
  ) {}

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

  /** Asks the webview for the current PDF bytes, including unsaved highlight changes. */
  requestBytes(): Promise<Uint8Array> {
    if (!this.panel) {
      return Promise.resolve(this.data);
    }
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      this.post({ type: 'getBytes', requestId });
    });
  }

  settleRequest(requestId: number, result: { data: Uint8Array } | { error: string }): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(requestId);
    if ('data' in result) {
      pending.resolve(result.data);
    } else {
      pending.reject(new Error(result.error));
    }
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

/**
 * Reads a file as a plain Uint8Array. `workspace.fs.readFile` returns a Node Buffer, which webview
 * messaging does not recognize as binary data and would serialize as a huge JSON array.
 */
async function readFile(uri: vscode.Uri): Promise<Uint8Array> {
  const data = await vscode.workspace.fs.readFile(uri);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export class PdfEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
  static readonly viewType = 'vscode-pdf-viewer.pdfEditor';

  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<PdfDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  /** Open documents by URI, so a link to an open file navigates its tab instead of opening another. */
  private readonly documents = new Map<string, PdfDocument>();
  /** Navigation for a document that `open()` is about to create. */
  private readonly pendingTargets = new Map<string, NavTarget>();

  constructor(private readonly context: vscode.ExtensionContext) {}

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
    const document = this.documents.get(uri.toString());
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
    const document = new PdfDocument(uri, await readFile(source), !!openContext.backupId, () =>
      this.documents.delete(key),
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
        case 'edited':
          document.dirty = true;
          this.changeEmitter.fire({ document });
          break;
        case 'save':
          void vscode.commands.executeCommand('workbench.action.files.save');
          break;
        case 'bytes':
          document.settleRequest(message.requestId, { data: message.data });
          break;
        case 'bytesError':
          document.settleRequest(message.requestId, { error: message.message });
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
    const data = await document.requestBytes();
    if (destination.toString() === document.uri.toString()) {
      // Set before writing, so the file watcher recognizes the change as our own.
      document.data = data;
      document.dirty = false;
    }
    await vscode.workspace.fs.writeFile(destination, data);
    document.post({ type: 'saved' });
  }

  async revertCustomDocument(document: PdfDocument): Promise<void> {
    document.data = await readFile(document.uri);
    document.dirty = false;
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
   * sync back. Unsaved highlights are never discarded: a dirty viewer is left as it is.
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
    if (sameBytes(data, document.data)) {
      return;
    }
    if (document.dirty) {
      void vscode.window.showWarningMessage(
        `${path.basename(document.uri.fsPath)} changed on disk. Your unsaved highlights are kept; saving will overwrite the file.`,
      );
      return;
    }
    document.data = data;
    document.load();
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
