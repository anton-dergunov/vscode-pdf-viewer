/**
 * Deciding which unsaved highlight changes can be added to a newer copy of the file on disk.
 *
 * pdf.js keeps one serialized entry per changed highlight. A new highlight has no `id`; a change
 * to a highlight that was in the loaded file (recolor, removal) has `id`, the reference of its
 * object in that file. Each save from the viewer writes every entry again on top of the loaded
 * bytes, so the entries also hold what earlier saves in this tab already wrote: `saved` is a
 * snapshot of them as of the last save, and only what differs from it is added to the newer file.
 */

import type { PDFDocumentLoadingTask } from 'pdfjs-dist';

/** A serialized highlight change, as `AnnotationStorage.serializable` gives it. */
export interface Change {
  /** Reference ("12R") of the highlight in the loaded file; absent for a new highlight. */
  id?: string | null;
  pageIndex: number;
  deleted?: boolean;
}

/** The serialized changes as of the last save, by key. */
export type Snapshot = ReadonlyMap<string, string>;

export type MergePlan<T extends Change> = { apply: [string, T][] } | { conflict: string };

export function snapshotOf(changes: ReadonlyMap<string, Change>): Map<string, string> {
  return new Map([...changes].map(([key, change]) => [key, JSON.stringify(change)]));
}

/**
 * Picks the changes to write on top of the file on disk.
 *
 * - `appended`: the file on disk is the bytes last loaded or saved with more added at the end, so
 *   the objects that `id` refers to are still the same ones. After a rewrite they may not be.
 * - `pageCount`: pages in the file on disk.
 */
export function planMerge<T extends Change>(
  changes: ReadonlyMap<string, T>,
  saved: Snapshot,
  appended: boolean,
  pageCount: number,
): MergePlan<T> {
  for (const key of saved.keys()) {
    if (!changes.has(key)) {
      return { conflict: 'a highlight saved earlier was changed back since' };
    }
  }
  const apply: [string, T][] = [];
  for (const [key, change] of changes) {
    const before = saved.get(key);
    if (before === JSON.stringify(change)) {
      continue; // Already in the file.
    }
    if (change.id) {
      if (!appended) {
        return { conflict: 'the file was rewritten elsewhere, and a highlight that was in it has changed here' };
      }
    } else if (before !== undefined) {
      // Its place in the saved file isn't known, so the newer file can't be updated to match.
      return { conflict: 'a highlight saved earlier was changed again since' };
    }
    if (!(change.pageIndex >= 0 && change.pageIndex < pageCount)) {
      return { conflict: 'the file now has fewer pages' };
    }
    apply.push([key, change]);
  }
  return { apply };
}

/**
 * Writes the changes since the last save on top of `disk`, opened by `task`, as an incremental
 * update; or says why some change can't be placed safely.
 */
export async function mergeChanges(
  task: PDFDocumentLoadingTask,
  disk: Uint8Array,
  changes: ReadonlyMap<string, Change>,
  saved: Snapshot,
  appended: boolean,
): Promise<{ data: Uint8Array } | { conflict: string }> {
  try {
    const other = await task.promise;
    const plan = planMerge(changes, saved, appended, other.numPages);
    if ('conflict' in plan) {
      return plan;
    }
    if (plan.apply.length === 0) {
      return { data: disk };
    }
    // Plain serialized changes are saved like live highlights (keys keep pdf.js's editor prefix).
    for (const [key, change] of plan.apply) {
      other.annotationStorage.setValue(key, change);
    }
    return { data: await other.saveDocument() };
  } finally {
    await task.destroy();
  }
}
