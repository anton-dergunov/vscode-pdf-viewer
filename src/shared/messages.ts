/** Where to go in a document. A named destination wins over a page when the PDF has it. */
export interface NavTarget {
  page?: number;
  dest?: string;
  search?: string;
}

/**
 * What the viewer's bar says: the file changed on disk while there are unsaved highlights, or Save
 * couldn't add them to it (both stay until dealt with); or a brief note that the file was reloaded
 * or saved together with that change.
 */
export type NoticeKind = 'changed' | 'conflict' | 'reloaded' | 'merged' | 'clear';

/** Messages the extension host sends to the webview. */
export type HostMessage =
  | { type: 'load'; data: Uint8Array; dirty: boolean; target?: NavTarget }
  | { type: 'navigate'; target: NavTarget }
  /** `forSave`: the bytes are written to the PDF's own file, and `saved` follows once they are. */
  | { type: 'getBytes'; requestId: number; forSave?: boolean }
  | { type: 'saved' }
  /** Adds the unsaved highlight changes to `data`, the newer file on disk. */
  | { type: 'merge'; requestId: number; data: Uint8Array; appended: boolean }
  /** `reason`: for `conflict`, why the highlights can't be added to the file on disk. */
  | { type: 'notice'; kind: NoticeKind; name: string; undoLost?: boolean; reason?: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'dirty'; dirty: boolean };

/** Messages the webview sends to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit' }
  | { type: 'save' }
  | { type: 'revert' }
  /** Save, replacing the newer file on disk with this version. */
  | { type: 'overwrite' }
  | { type: 'bytes'; requestId: number; data: Uint8Array }
  | { type: 'bytesError'; requestId: number; message: string }
  | { type: 'mergeConflict'; requestId: number; reason: string }
  | { type: 'error'; message: string };
