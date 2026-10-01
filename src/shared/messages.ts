/** Where to go in a document. A named destination wins over a page when the PDF has it. */
export interface NavTarget {
  page?: number;
  dest?: string;
  search?: string;
}

/** Messages the extension host sends to the webview. */
export type HostMessage =
  | { type: 'load'; data: Uint8Array; dirty: boolean; target?: NavTarget }
  | { type: 'navigate'; target: NavTarget }
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
