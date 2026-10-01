/** Messages the extension host sends to the webview. */
export type HostMessage =
  | { type: 'load'; data: Uint8Array; dirty: boolean }
  | { type: 'getBytes'; requestId: number }
  | { type: 'saved' };

/** Messages the webview sends to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edited' }
  | { type: 'save' }
  | { type: 'bytes'; requestId: number; data: Uint8Array }
  | { type: 'bytesError'; requestId: number; message: string }
  | { type: 'error'; message: string };
