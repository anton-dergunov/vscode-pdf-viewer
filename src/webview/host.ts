import type { HostMessage, WebviewMessage } from '../shared/messages';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

export function postToHost(message: WebviewMessage): void {
  vscode.postMessage(message);
}

export function onHostMessage(handler: (message: HostMessage) => void): void {
  window.addEventListener('message', (event: MessageEvent<HostMessage>) => handler(event.data));
}

export function reportError(message: string): void {
  postToHost({ type: 'error', message });
}
