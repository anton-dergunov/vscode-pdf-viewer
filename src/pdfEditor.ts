import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from './shared/messages';

/** A PDF file opened in the viewer. The webview owns the live state; this side owns file I/O. */
class PdfDocument implements vscode.CustomDocument {
  private panel: vscode.WebviewPanel | undefined;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<
    number,
    { resolve: (data: Uint8Array) => void; reject: (error: Error) => void }
  >();

  constructor(
    readonly uri: vscode.Uri,
    /** The bytes the webview should show next time it (re)loads. */
    public data: Uint8Array,
    /** Whether `data` holds unsaved changes (restored from a hot-exit backup). */
    public dirty: boolean,
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
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pendingRequests.values()) {
      reject(error);
    }
    this.pendingRequests.clear();
  }
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

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<PdfDocument> {
    const source = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
    return new PdfDocument(uri, await readFile(source), !!openContext.backupId);
  }

  resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): void {
    const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    panel.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    panel.webview.html = this.getHtml(panel.webview, distUri);
    document.attach(panel);

    panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      switch (message.type) {
        case 'ready':
          document.post({ type: 'load', data: document.data, dirty: document.dirty });
          break;
        case 'edited':
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
    await vscode.workspace.fs.writeFile(destination, data);
    if (destination.toString() === document.uri.toString()) {
      document.data = data;
      document.dirty = false;
    }
    document.post({ type: 'saved' });
  }

  async revertCustomDocument(document: PdfDocument): Promise<void> {
    document.data = await readFile(document.uri);
    document.dirty = false;
    document.post({ type: 'load', data: document.data, dirty: false });
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
