import { icon } from './icons';

export const HIGHLIGHT_COLORS = [
  { name: 'yellow', label: 'Yellow', value: '#ffeb3b' },
  { name: 'green', label: 'Green', value: '#a5d6a7' },
  { name: 'blue', label: 'Blue', value: '#81d4fa' },
  { name: 'pink', label: 'Pink', value: '#f48fb1' },
  { name: 'orange', label: 'Orange', value: '#ffb74d' },
  { name: 'purple', label: 'Purple', value: '#ce93d8' },
] as const;

const ZOOM_PRESETS = [
  ['page-width', 'Page Width'],
  ['page-fit', 'Page Fit'],
  ['0.5', '50%'],
  ['0.75', '75%'],
  ['1', '100%'],
  ['1.25', '125%'],
  ['1.5', '150%'],
  ['2', '200%'],
  ['3', '300%'],
];

const swatches = HIGHLIGHT_COLORS.map(
  (c) => `<button class="swatch" data-color="${c.value}" title="${c.label}" aria-label="${c.label}"></button>`,
).join('');

const zoomOptions = ZOOM_PRESETS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

const markup = /* html */ `
  <div id="toolbar" class="toolbar" role="toolbar">
    <div class="group">
      <button id="prev-page" class="btn" title="Previous page (←)">${icon('chevronLeft')}</button>
      <input id="page-number" class="page-number" type="number" min="1" value="1" aria-label="Page">
      <span class="page-count">/ <span id="page-count">–</span></span>
      <button id="next-page" class="btn" title="Next page (→)">${icon('chevronRight')}</button>
    </div>
    <div class="divider"></div>
    <div class="group">
      <button id="zoom-out" class="btn" title="Zoom out">${icon('minus')}</button>
      <select id="zoom-select" class="zoom-select" title="Zoom">
        ${zoomOptions}
        <option id="zoom-custom" value="custom" hidden></option>
      </select>
      <button id="zoom-in" class="btn" title="Zoom in">${icon('plus')}</button>
    </div>
    <div class="divider"></div>
    <div class="group">
      <button class="btn tool" data-tool="select" title="Select text">${icon('textCursor')}</button>
      <button class="btn tool" data-tool="highlight" title="Highlight text">${icon('highlighter')}</button>
      <button class="btn tool" data-tool="eraser" title="Remove highlights (click a highlight)">${icon('eraser')}</button>
      <div class="color-picker">
        <button id="color-button" class="color-button" title="Highlight color" aria-haspopup="true" aria-expanded="false">
          <span id="color-preview" class="swatch-preview"></span>${icon('chevronDown')}
        </button>
        <div id="color-popup" class="color-popup" hidden>${swatches}</div>
      </div>
    </div>
    <div class="divider"></div>
    <div class="group">
      <button id="find-toggle" class="btn" title="Find (Ctrl/Cmd+F)">${icon('search')}</button>
      <button id="save" class="btn save" title="Save highlights to the PDF" disabled>${icon('save')}<span>Save</span></button>
    </div>
  </div>

  <div id="findbar" class="findbar" hidden>
    <input id="find-input" type="text" placeholder="Find in document…" autocomplete="off" spellcheck="false">
    <span id="find-count" class="find-count"></span>
    <button id="find-prev" class="btn small" title="Previous match (Shift+Enter)">${icon('chevronUp')}</button>
    <button id="find-next" class="btn small" title="Next match (Enter)">${icon('chevronDown')}</button>
    <button id="find-close" class="btn small" title="Close (Esc)">${icon('close')}</button>
  </div>

  <div id="loading" class="loading"><div class="spinner"></div></div>

  <div id="viewer-container" class="viewer-container" tabindex="0">
    <div id="viewer" class="pdfViewer"></div>
  </div>
`;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

/** Builds the page skeleton and returns the elements the controllers need. */
export function createLayout() {
  document.body.insertAdjacentHTML('afterbegin', markup);
  return {
    toolbar: byId<HTMLDivElement>('toolbar'),
    prevPage: byId<HTMLButtonElement>('prev-page'),
    nextPage: byId<HTMLButtonElement>('next-page'),
    pageNumber: byId<HTMLInputElement>('page-number'),
    pageCount: byId<HTMLSpanElement>('page-count'),
    zoomOut: byId<HTMLButtonElement>('zoom-out'),
    zoomIn: byId<HTMLButtonElement>('zoom-in'),
    zoomSelect: byId<HTMLSelectElement>('zoom-select'),
    zoomCustom: byId<HTMLOptionElement>('zoom-custom'),
    toolButtons: [...document.querySelectorAll<HTMLButtonElement>('.tool')],
    colorButton: byId<HTMLButtonElement>('color-button'),
    colorPreview: byId<HTMLSpanElement>('color-preview'),
    colorPopup: byId<HTMLDivElement>('color-popup'),
    swatches: [...document.querySelectorAll<HTMLButtonElement>('.swatch')],
    findToggle: byId<HTMLButtonElement>('find-toggle'),
    save: byId<HTMLButtonElement>('save'),
    findbar: byId<HTMLDivElement>('findbar'),
    findInput: byId<HTMLInputElement>('find-input'),
    findCount: byId<HTMLSpanElement>('find-count'),
    findPrev: byId<HTMLButtonElement>('find-prev'),
    findNext: byId<HTMLButtonElement>('find-next'),
    findClose: byId<HTMLButtonElement>('find-close'),
    loading: byId<HTMLDivElement>('loading'),
    container: byId<HTMLDivElement>('viewer-container'),
  };
}

export type Layout = ReturnType<typeof createLayout>;
