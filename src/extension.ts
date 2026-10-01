import * as vscode from 'vscode';
import { PdfEditorProvider } from './pdfEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  console.log('PDF Viewer Pro extension activated.');

  // Register Custom Editor Provider for *.pdf files
  const provider = new PdfEditorProvider(context);
  const providerRegistration = vscode.window.registerCustomEditorProvider(
    PdfEditorProvider.viewType,
    provider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: true,
    }
  );
  context.subscriptions.push(providerRegistration);

  // Register Command to Open PDF via file picker
  const openCommand = vscode.commands.registerCommand(
    'vscode-pdf-viewer.open',
    async (uri?: vscode.Uri) => {
      let targetUri = uri;
      if (!targetUri) {
        const fileUris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Open PDF File',
          filters: { 'PDF Documents': ['pdf'] },
        });
        if (fileUris && fileUris.length > 0) {
          targetUri = fileUris[0];
        }
      }

      if (targetUri) {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          targetUri,
          PdfEditorProvider.viewType
        );
      }
    }
  );
  context.subscriptions.push(openCommand);
}

export function deactivate() {}
