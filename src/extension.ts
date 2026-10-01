import * as vscode from 'vscode';
import { LINK_HOST, parseTarget, type PdfTarget } from './links';
import { PdfEditorProvider } from './pdfEditor';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PdfEditorProvider(context);

  const openLink = (uri: vscode.Uri) => {
    const target = parseTarget(uri);
    if (target) {
      void provider.open(target);
    } else {
      void vscode.window.showErrorMessage(`PDF Viewer: not a valid PDF link: ${uri.toString(true)}`);
    }
  };

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(PdfEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('pdfViewer.open', (target?: PdfTarget) => openFromCommand(provider, target)),
    // vscode://anton.vscode-pdf-viewer/open?file=…: the same links, for places outside the Claude panel.
    vscode.window.registerUriHandler({ handleUri: openLink }),
  );

  registerPaperLinkOpener(context, openLink);
}

export function deactivate(): void {}

/**
 * Claims `http://pdf.localhost/…` links so clicking one, for example in the Claude Code chat,
 * opens the PDF here instead of in a browser.
 *
 * `registerExternalUriOpener` is a proposed API. It only exists when VS Code is started with this
 * extension in `enable-proposed-api` (see README); without it the rest of the extension still works.
 */
function registerPaperLinkOpener(context: vscode.ExtensionContext, openLink: (uri: vscode.Uri) => void): void {
  try {
    context.subscriptions.push(
      vscode.window.registerExternalUriOpener(
        'vscode-pdf-viewer.paperLink',
        {
          canOpenExternalUri: (uri) =>
            uri.authority === LINK_HOST
              ? vscode.ExternalUriOpenerPriority.Preferred
              : vscode.ExternalUriOpenerPriority.None,
          openExternalUri: (uri) => openLink(uri),
        },
        { schemes: ['http', 'https'], label: 'Open in PDF Viewer' },
      ),
    );
  } catch (error) {
    console.warn('PDF Viewer: paper links are disabled because the proposed API is not enabled.', error);
  }
}

async function openFromCommand(provider: PdfEditorProvider, target?: PdfTarget): Promise<void> {
  if (target?.file) {
    return provider.open(target);
  }
  const [file] =
    (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { PDF: ['pdf'] }, openLabel: 'Open' })) ?? [];
  if (!file) {
    return;
  }
  const where = await vscode.window.showInputBox({
    prompt: 'Page number or named destination (e.g. 7, section.4.3, table.2). Leave empty for the first page.',
  });
  if (where === undefined) {
    return;
  }
  const page = Number.parseInt(where, 10);
  await provider.open({
    file: file.fsPath,
    ...(String(page) === where.trim() ? { page } : where.trim() ? { dest: where.trim() } : {}),
  });
}
