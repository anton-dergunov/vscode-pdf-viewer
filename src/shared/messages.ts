/** A rectangle on a page: x0, y0, x1, y1 in PDF points from the top-left of its crop box, unrotated. */
export type Rect = [number, number, number, number];

/**
 * Where to go in a document. Rectangles on `page` are marked and decide the scroll; otherwise a
 * named destination wins over a page when the PDF has it.
 */
export interface NavTarget {
  page?: number;
  dest?: string;
  search?: string;
  rect?: Rect[];
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
