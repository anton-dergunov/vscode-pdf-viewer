import type { NoticeKind } from '../shared/messages';
import { postToHost } from './host';
import type { Layout } from './layout';

/** How long a note stays before it fades. */
const NOTE_MS: Partial<Record<NoticeKind, number>> = { reloaded: 4000, merged: 5000 };
const FADE_MS = 300;

const UNDO_LOST = ' Earlier highlight changes can no longer be undone.';

/**
 * The bar along the top of the viewer. "Changed on disk" and "can't be added" stay until the reader
 * saves, reloads or dismisses them; the notes after a reload or a merged save fade on their own.
 */
export function setupNotice(ui: Layout) {
  const { notice, noticeText, noticeReload, noticeOverwrite, noticeClose } = ui;
  let kind: NoticeKind = 'clear';
  let timer: number | undefined;

  // The find bar sits below the notice.
  new ResizeObserver(() => {
    document.body.style.setProperty('--notice-height', `${notice.hidden ? 0 : notice.offsetHeight}px`);
  }).observe(notice);

  const hide = () => {
    clearTimeout(timer);
    kind = 'clear';
    notice.hidden = true;
    notice.classList.remove('fading');
  };

  const show = (next: NoticeKind, name: string, undoLost = false, reason = '') => {
    hide();
    if (next === 'clear') {
      return;
    }
    kind = next;
    const file = `<strong>${escapeHtml(name)}</strong>`;
    const undo = undoLost ? UNDO_LOST : '';
    noticeText.innerHTML = {
      changed: `${file} changed on disk. Your unsaved highlights are kept and will be added to it when you save.`,
      conflict: `Not saved: ${file} changed on disk, and your highlights can't be added to it (${escapeHtml(reason)}).`,
      reloaded: `Reloaded: ${file} changed on disk.${undo}`,
      merged: `Saved. Highlights added to ${file} elsewhere are kept too.${undo}`,
    }[next];
    noticeReload.hidden = next !== 'changed' && next !== 'conflict';
    noticeOverwrite.hidden = next !== 'conflict';
    notice.hidden = false;
    const duration = NOTE_MS[next];
    if (duration) {
      timer = window.setTimeout(() => {
        notice.classList.add('fading');
        timer = window.setTimeout(hide, FADE_MS);
      }, duration);
    }
  };

  noticeReload.addEventListener('click', () => postToHost({ type: 'revert' }));
  noticeOverwrite.addEventListener('click', () => postToHost({ type: 'overwrite' }));
  noticeClose.addEventListener('click', hide);

  return {
    show,
    /** A reload shows the file as it is now, so "changed on disk" no longer applies. */
    onLoad: () => {
      if (kind === 'changed' || kind === 'conflict') {
        hide();
      }
    },
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
