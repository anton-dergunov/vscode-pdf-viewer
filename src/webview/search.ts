import { FindState } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { Layout } from './layout';
import type { PdfView } from './viewer';

interface MatchesCount {
  current: number;
  total: number;
}

export interface Search {
  open(): void;
  /** Opens the find bar with `query` and finds its next occurrence from the current page. */
  openWith(query: string): void;
  close(): void;
  isOpen(): boolean;
}

export function setupSearch(ui: Layout, view: PdfView): Search {
  const { eventBus } = view;
  const { findbar, findInput, findCount } = ui;

  let revealPending = false;
  let previousMatch: Element | null | undefined;

  const find = (type: '' | 'again', findPrevious = false) => {
    revealPending = true;
    previousMatch = view.container.querySelector('.textLayer .highlight.selected');
    eventBus.dispatch('find', {
      source: findbar,
      type,
      query: findInput.value,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
    });
  };

  const showCount = ({ current, total }: MatchesCount) => {
    findCount.textContent = findInput.value ? `${total ? current : 0} / ${total}` : '';
  };

  const open = () => {
    findbar.hidden = false;
    findInput.focus();
    findInput.select();
    if (findInput.value) {
      find('');
    }
  };

  const close = () => {
    if (findbar.hidden) {
      return;
    }
    findbar.hidden = true;
    eventBus.dispatch('findbarclose', { source: findbar });
    view.container.focus();
  };

  ui.findToggle.addEventListener('click', () => (findbar.hidden ? open() : close()));
  ui.findClose.addEventListener('click', close);
  ui.findNext.addEventListener('click', () => find('again'));
  ui.findPrev.addEventListener('click', () => find('again', true));

  findInput.addEventListener('input', () => find(''));
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      find('again', event.shiftKey);
    }
  });

  // pdf.js scrolls the current match to just below the top edge, where the find bar covers it.
  // After each navigation, shift it down once pdf.js has drawn the new current match (which may
  // only happen when the page's text layer finishes rendering).
  const revealCurrentMatch = () => {
    const match = view.container.querySelector('.textLayer .highlight.selected');
    if (!match || match === previousMatch || findbar.hidden) {
      return;
    }
    previousMatch = undefined;
    revealPending = false;
    const overlap = findbar.getBoundingClientRect().bottom + 16 - match.getBoundingClientRect().top;
    if (overlap > 0) {
      view.container.scrollTop -= overlap;
    }
  };
  const scheduleReveal = () => {
    if (revealPending) {
      requestAnimationFrame(revealCurrentMatch);
    }
  };
  eventBus.on('updatetextlayermatches', scheduleReveal);
  eventBus.on('textlayerrendered', scheduleReveal);

  eventBus.on('updatefindmatchescount',({ matchesCount }: { matchesCount: MatchesCount }) => showCount(matchesCount));
  eventBus.on(
    'updatefindcontrolstate',
    ({ state, matchesCount }: { state: number; matchesCount: MatchesCount }) => {
      findbar.classList.toggle('not-found', state === FindState.NOT_FOUND && !!findInput.value);
      showCount(matchesCount);
    },
  );

  const openWith = (query: string) => {
    findInput.value = query;
    findbar.hidden = false;
    find('');
  };

  return { open, openWith, close, isOpen: () => !findbar.hidden };
}
