import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class PdfCustomDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfCustomDocument> {
  public static readonly viewType = 'vscode-pdf-viewer.pdfEditor';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken
  ): Promise<PdfCustomDocument> {
    return new PdfCustomDocument(uri);
  }

  async resolveCustomEditor(
    document: PdfCustomDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    const pdfUri = document.uri;
    const extensionUri = this.context.extensionUri;

    // Configure Webview security options & resource roots
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'dist'),
        vscode.Uri.joinPath(extensionUri, 'media'),
        vscode.Uri.file(path.dirname(pdfUri.fsPath)),
      ],
    };

    // Construct local resource URIs for webview resources
    const pdfJsUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'media', 'pdfjs', 'pdf.min.js')
    );
    const pdfLibUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'media', 'pdfjs', 'pdf-lib.min.js')
    );
    const pdfWorkerUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'media', 'pdfjs', 'pdf.worker.min.js')
    );
    const viewerCssUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'viewer.css')
    );
    const viewerJsUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'viewer.js')
    );
    const pdfDocWebviewUri = webviewPanel.webview.asWebviewUri(pdfUri).toString();

    // Set Webview HTML Content
    const htmlPath = path.join(this.context.extensionPath, 'dist', 'webview', 'viewer.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    const nonce = getNonce();
    htmlContent = htmlContent
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{cspSource}}/g, webviewPanel.webview.cspSource)
      .replace(/{{pdfJsUri}}/g, pdfJsUri.toString())
      .replace(/{{pdfLibUri}}/g, pdfLibUri.toString())
      .replace(/{{pdfWorkerUri}}/g, pdfWorkerUri.toString())
      .replace(/{{viewerCssUri}}/g, viewerCssUri.toString())
      .replace(/{{viewerJsUri}}/g, viewerJsUri.toString());

    webviewPanel.webview.html = htmlContent;

    // Handle incoming Webview Messages
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'ready': {
          webviewPanel.webview.postMessage({
            command: 'loadPdf',
            url: pdfDocWebviewUri,
            title: path.basename(pdfUri.fsPath),
          });
          break;
        }

        case 'savePdfBytes': {
          // Save the modified PDF (with embedded highlight annotations) directly to the PDF file
          try {
            const buf = Buffer.from(message.data);
            fs.writeFileSync(pdfUri.fsPath, buf);
            vscode.window.showInformationMessage(
              `Saved PDF: ${path.basename(pdfUri.fsPath)}`
            );
            webviewPanel.webview.postMessage({ command: 'saveCompleted' });
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to save PDF: ${err.message}`);
            webviewPanel.webview.postMessage({ command: 'saveFailed', error: err.message });
          }
          break;
        }

        case 'showError': {
          vscode.window.showErrorMessage(`PDF Viewer: ${message.text}`);
          break;
        }
      }
    });
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

