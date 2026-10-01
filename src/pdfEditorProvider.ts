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

    const sidecarPath = pdfUri.fsPath + '.highlights.json';

    // Set Webview HTML Content
    const htmlPath = path.join(this.context.extensionPath, 'dist', 'webview', 'viewer.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    const nonce = getNonce();
    htmlContent = htmlContent
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{cspSource}}/g, webviewPanel.webview.cspSource)
      .replace(/{{pdfJsUri}}/g, pdfJsUri.toString())
      .replace(/{{pdfWorkerUri}}/g, pdfWorkerUri.toString())
      .replace(/{{viewerCssUri}}/g, viewerCssUri.toString())
      .replace(/{{viewerJsUri}}/g, viewerJsUri.toString());

    webviewPanel.webview.html = htmlContent;

    // Handle incoming Webview Messages
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'ready': {
          let savedHighlights: any = [];
          try {
            if (fs.existsSync(sidecarPath)) {
              const raw = fs.readFileSync(sidecarPath, 'utf8');
              savedHighlights = JSON.parse(raw);
            }
          } catch (err) {
            console.error('Error loading highlights sidecar:', err);
          }

          webviewPanel.webview.postMessage({
            command: 'loadPdf',
            url: pdfDocWebviewUri,
            title: path.basename(pdfUri.fsPath),
            highlights: savedHighlights,
          });
          break;
        }

        case 'saveHighlights': {
          try {
            const dataStr = JSON.stringify(message.highlights, null, 2);
            fs.writeFileSync(sidecarPath, dataStr, 'utf8');
            if (message.notify) {
              vscode.window.showInformationMessage(
                `Saved highlights for ${path.basename(pdfUri.fsPath)}`
              );
            }
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to save highlights: ${err.message}`);
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
