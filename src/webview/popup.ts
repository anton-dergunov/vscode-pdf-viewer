const WINDOW_MARGIN_PX = 12;

/** Shifts an open toolbar popup sideways so that it stays inside a narrow window. */
export function keepInWindow(popup: HTMLElement): void {
  if (popup.hidden) {
    return;
  }
  // Not removed: the color picker can sit inside the More popup and would inherit its shift.
  popup.style.setProperty('--nudge', '0px');
  const { left, right } = popup.getBoundingClientRect();
  const nudge = Math.max(WINDOW_MARGIN_PX - left, 0) || Math.min(window.innerWidth - WINDOW_MARGIN_PX - right, 0);
  popup.style.setProperty('--nudge', `${nudge}px`);
}
