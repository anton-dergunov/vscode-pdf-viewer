(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  // ─── State ────────────────────────────────────────────────────────────────
  let pdfDoc = null;
  let pdfScale = 1.0;       // logical zoom (1.0 = 100%)
  let pdfUrl = '';
  let currentPage = 1;
  let currentTool = 'select';   // 'select' | 'highlight' | 'eraser'
  let currentColor = '#ffeb3b';

  /**
   * highlights[pageNum] = [{ id, pageNum, xNorm, yNorm, wNorm, hNorm, color }, …]
   *
   * All coords are NORMALISED to the page's 1×-scale viewport:
   *   xNorm = screenX_in_logical_px / (pdfScale * BASE_SCALE * pageNaturalWidth)
   *
   * This means highlights are zoom-independent and can be converted to PDF
   * coordinates by multiplying by the natural page dimensions.
   */
  let highlights = {};

  /**
   * pageNaturalDims[pageNum] = { width, height }
   * Page dimensions at scale=1.0 (PDF user units ≈ points at 1px/pt).
   * Used for coordinate normalisation and PDF annotation export.
   */
  let pageNaturalDims = {};

  const renderedPages = new Set();  // pages whose canvas has been drawn
  const BASE_SCALE = 1.5;           // base over-render factor for sharpness

  // Search
  let searchMatches = [];
  let currentMatchIndex = -1;

  // Context menu
  let ctxMenuEl = null;

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  const container      = document.getElementById('pages-container');
  const loadingOverlay = document.getElementById('loading');
  const pageNumInput   = document.getElementById('page-num-input');
  const pageCountEl    = document.getElementById('page-count');
  const zoomSelect     = document.getElementById('zoom-select');
  const docTitleEl     = document.getElementById('doc-title');
  const searchBar      = document.getElementById('search-bar');
  const searchInput    = document.getElementById('search-input');
  const searchCountEl  = document.getElementById('search-results-count');

  // ─── PDF.js worker ────────────────────────────────────────────────────────
  if (typeof pdfjsLib !== 'undefined') {
    const scripts = Array.from(document.scripts);
    const pdfScript = scripts.find((s) => s.src && s.src.includes('pdf.min.js'));
    if (pdfScript) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfScript.src.replace('pdf.min.js', 'pdf.worker.min.js');
    }
  }

  // ─── VS Code message bus ──────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command !== 'loadPdf') return;

    pdfUrl = msg.url;
    if (msg.title) docTitleEl.innerText = msg.title;

    if (Array.isArray(msg.highlights)) {
      highlights = {};
      msg.highlights.forEach((h) => {
        if (!highlights[h.pageNum]) highlights[h.pageNum] = [];
        highlights[h.pageNum].push(h);
      });
    }

    loadPdf();
  });

  window.onload = () => vscode.postMessage({ command: 'ready' });

  // ─── Load & render PDF ────────────────────────────────────────────────────
  async function loadPdf() {
    loadingOverlay.style.display = 'flex';
    container.innerHTML = '';
    renderedPages.clear();

    try {
      pdfDoc = await pdfjsLib.getDocument({ url: pdfUrl }).promise;
      const n = pdfDoc.numPages;
      pageCountEl.innerText = n;
      pageNumInput.max = n;

      // Build all page placeholders so scrollbar is correct from the start
      for (let i = 1; i <= n; i++) container.appendChild(buildPageShell(i));

      // Render page 1 immediately → hide loading overlay ASAP
      await renderPage(1);
      loadingOverlay.style.display = 'none';

      // Lazy-render the rest as they scroll into view
      setupLazyRender();
    } catch (err) {
      console.error(err);
      document.getElementById('loading-text').innerText = 'Failed to open PDF: ' + err.message;
      vscode.postMessage({ command: 'showError', text: err.message });
    }
  }

  function buildPageShell(pageNum) {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.id = `pw-${pageNum}`;
    wrapper.dataset.pageNum = String(pageNum);
    // Rough placeholder height keeps scroll position reasonable before render
    wrapper.style.minHeight = '1000px';

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.id = `cv-${pageNum}`;

    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.id = `tl-${pageNum}`;

    const hlLayer = document.createElement('div');
    hlLayer.className = 'highlight-layer';
    hlLayer.id = `hl-${pageNum}`;

    wrapper.append(canvas, textLayer, hlLayer);
    return wrapper;
  }

  function setupLazyRender() {
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach(async (entry) => {
          const pn = parseInt(entry.target.dataset.pageNum, 10);
          if (entry.isIntersecting) {
            // Update page indicator
            currentPage = pn;
            pageNumInput.value = String(pn);
            // Lazy render
            if (!renderedPages.has(pn)) await renderPage(pn);
          }
        });
      },
      { threshold: 0.05, rootMargin: '300px' }
    );
    document.querySelectorAll('.page-wrapper').forEach((el) => obs.observe(el));
  }

  // ─── Page rendering ───────────────────────────────────────────────────────
  async function renderPage(pageNum) {
    if (renderedPages.has(pageNum)) return;
    renderedPages.add(pageNum);

    const page = await pdfDoc.getPage(pageNum);
    const dpr = window.devicePixelRatio || 1;

    // Natural viewport (scale=1.0) → PDF coordinate space
    const naturalVp = page.getViewport({ scale: 1.0 });
    pageNaturalDims[pageNum] = { width: naturalVp.width, height: naturalVp.height };

    // Render viewport at user-chosen scale + base over-render
    const renderVp = page.getViewport({ scale: pdfScale * BASE_SCALE });
    const logW = renderVp.width;
    const logH = renderVp.height;

    const wrapper  = document.getElementById(`pw-${pageNum}`);
    const canvas   = document.getElementById(`cv-${pageNum}`);
    const textLayer = document.getElementById(`tl-${pageNum}`);
    const hlLayer  = document.getElementById(`hl-${pageNum}`);

    // Wrapper / overlay layers → logical CSS size
    wrapper.style.width  = `${logW}px`;
    wrapper.style.height = `${logH}px`;
    wrapper.style.minHeight = '';

    textLayer.style.width  = `${logW}px`;
    textLayer.style.height = `${logH}px`;
    hlLayer.style.width  = `${logW}px`;
    hlLayer.style.height = `${logH}px`;

    // Canvas buffer → physical pixels (HiDPI)
    canvas.width  = Math.floor(logW * dpr);
    canvas.height = Math.floor(logH * dpr);
    canvas.style.width  = `${logW}px`;
    canvas.style.height = `${logH}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport: renderVp }).promise;

    // Text layer
    textLayer.innerHTML = '';
    const textContent = await page.getTextContent();
    if (pdfjsLib.renderTextLayer) {
      await pdfjsLib.renderTextLayer({
        textContent,
        container: textLayer,
        viewport: renderVp,
        textDivs: [],
      }).promise;
    }

    renderHighlightsForPage(pageNum);
  }

  // Re-render all pages after a zoom change
  async function reRenderAll() {
    if (!pdfDoc) return;
    renderedPages.clear();
    for (let i = 1; i <= pdfDoc.numPages; i++) await renderPage(i);
  }

  // ─── Highlight rendering ──────────────────────────────────────────────────
  /**
   * Paints all highlights for a page onto its highlight layer.
   * Converts from normalised [0,1] → current logical pixel coords.
   */
  function renderHighlightsForPage(pageNum) {
    const hlLayer = document.getElementById(`hl-${pageNum}`);
    if (!hlLayer) return;
    hlLayer.innerHTML = '';

    const logW = parseFloat(hlLayer.style.width)  || 0;
    const logH = parseFloat(hlLayer.style.height) || 0;
    if (!logW || !logH) return;

    (highlights[pageNum] || []).forEach((h) => {
      const el = document.createElement('div');
      el.className = 'highlight-rect';
      el.dataset.id = h.id;
      el.style.left   = `${h.xNorm * logW}px`;
      el.style.top    = `${h.yNorm * logH}px`;
      el.style.width  = `${h.wNorm * logW}px`;
      el.style.height = `${h.hNorm * logH}px`;
      el.style.backgroundColor = h.color;

      // Left-click in eraser mode → delete
      el.addEventListener('click', (e) => {
        if (currentTool === 'eraser') {
          e.stopPropagation();
          removeHighlight(pageNum, h.id);
        }
      });

      // Right-click → context menu with delete option
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, pageNum, h.id);
      });

      hlLayer.appendChild(el);
    });
  }

  // ─── Highlight context menu ───────────────────────────────────────────────
  function showContextMenu(x, y, pageNum, hlId) {
    dismissContextMenu();

    const menu = document.createElement('div');
    menu.className = 'highlight-ctx-menu';
    // Keep menu within viewport
    menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
    menu.style.top  = `${Math.min(y, window.innerHeight - 60)}px`;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'ctx-menu-item danger';
    deleteBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zm2.46-7.12l1.41-1.41L12 12.59l2.12-2.12 1.41 1.41L13.41 14l2.12 2.12-1.41 1.41L12 15.41l-2.12 2.12-1.41-1.41L10.59 14l-2.13-2.12zM15.5 4l-1-1h-5l-1 1H5v2h14V4z"/></svg> Delete highlight`;
    deleteBtn.addEventListener('click', () => {
      removeHighlight(pageNum, hlId);
      dismissContextMenu();
    });

    menu.appendChild(deleteBtn);
    document.body.appendChild(menu);
    ctxMenuEl = menu;

    // Dismiss on any outside click
    requestAnimationFrame(() =>
      document.addEventListener('click', dismissContextMenu, { once: true })
    );
  }

  function dismissContextMenu() {
    if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
  }

  function removeHighlight(pageNum, id) {
    if (!highlights[pageNum]) return;
    highlights[pageNum] = highlights[pageNum].filter((h) => h.id !== id);
    renderHighlightsForPage(pageNum);
    persistHighlights(false);
  }

  // ─── Text selection → highlight creation ─────────────────────────────────
  document.addEventListener('mouseup', () => {
    if (currentTool !== 'highlight') return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;

    const range = sel.getRangeAt(0);
    const textLayerEl = range.startContainer.parentElement?.closest('.textLayer');
    if (!textLayerEl) { sel.removeAllRanges(); return; }

    const wrapper = textLayerEl.closest('.page-wrapper');
    if (!wrapper) { sel.removeAllRanges(); return; }

    const pageNum = parseInt(wrapper.dataset.pageNum, 10);
    const wrapRect = wrapper.getBoundingClientRect();
    const logW = parseFloat(wrapper.style.width);
    const logH = parseFloat(wrapper.style.height);

    if (!highlights[pageNum]) highlights[pageNum] = [];

    let added = false;
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      highlights[pageNum].push({
        id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        pageNum,
        xNorm: (r.left - wrapRect.left) / logW,
        yNorm: (r.top  - wrapRect.top)  / logH,
        wNorm: r.width  / logW,
        hNorm: r.height / logH,
        color: currentColor,
      });
      added = true;
    }

    if (added) {
      renderHighlightsForPage(pageNum);
      persistHighlights(false);
    }
    sel.removeAllRanges();
  });

  // ─── Persist highlights (JSON sidecar) ───────────────────────────────────
  function persistHighlights(notify = false) {
    const all = Object.values(highlights).flat();
    vscode.postMessage({ command: 'saveHighlights', highlights: all, notify });
  }

  // ─── Tool buttons ─────────────────────────────────────────────────────────
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;
      document.body.classList.toggle('eraser-mode', currentTool === 'eraser');
    });
  });

  // ─── Color picker ─────────────────────────────────────────────────────────
  document.querySelectorAll('.color-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      currentColor = dot.dataset.color;
      // Auto-switch to highlight tool when a color is picked
      if (currentTool !== 'highlight') {
        document.querySelector('[data-tool="highlight"]')?.click();
      }
    });
  });

  // ─── Zoom ─────────────────────────────────────────────────────────────────
  function syncZoomSelect(scale) {
    // Try to select an existing option that matches
    for (const opt of zoomSelect.options) {
      const v = parseFloat(opt.value);
      if (!isNaN(v) && Math.abs(v - scale) < 0.01) {
        zoomSelect.value = opt.value;
        return;
      }
    }
    // Inject / reuse a "custom" option
    let custom = zoomSelect.querySelector('option[data-custom]');
    if (!custom) {
      custom = document.createElement('option');
      custom.dataset.custom = '1';
      zoomSelect.appendChild(custom);
    }
    custom.value = String(scale);
    custom.text  = `${Math.round(scale * 100)}%`;
    zoomSelect.value = String(scale);
  }

  async function applyZoom(jumpTo) {
    syncZoomSelect(pdfScale);
    if (!pdfDoc) return;
    renderedPages.clear();
    for (let i = 1; i <= pdfDoc.numPages; i++) await renderPage(i);
    if (jumpTo) jumpToPage(jumpTo);
  }

  document.getElementById('btn-zoom-in').addEventListener('click', async () => {
    pdfScale = Math.min(+(pdfScale + 0.25).toFixed(2), 4.0);
    await applyZoom(currentPage);
  });

  document.getElementById('btn-zoom-out').addEventListener('click', async () => {
    pdfScale = Math.max(+(pdfScale - 0.25).toFixed(2), 0.25);
    await applyZoom(currentPage);
  });

  zoomSelect.addEventListener('change', async () => {
    const val = zoomSelect.value;
    if (val === 'page-fit' || val === 'page-width') {
      if (pdfDoc) {
        const page = await pdfDoc.getPage(1);
        const natVp = page.getViewport({ scale: 1.0 });
        const availW = container.clientWidth - 48;
        pdfScale = +(availW / (natVp.width * BASE_SCALE)).toFixed(3);
      }
    } else {
      pdfScale = parseFloat(val);
    }
    await applyZoom(currentPage);
  });

  // ─── Page navigation ──────────────────────────────────────────────────────
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (currentPage > 1) jumpToPage(currentPage - 1);
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    if (pdfDoc && currentPage < pdfDoc.numPages) jumpToPage(currentPage + 1);
  });
  pageNumInput.addEventListener('change', () => {
    const v = parseInt(pageNumInput.value, 10);
    if (!isNaN(v) && pdfDoc && v >= 1 && v <= pdfDoc.numPages) jumpToPage(v);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target === pageNumInput || e.target === searchInput) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (pdfDoc && currentPage < pdfDoc.numPages) jumpToPage(currentPage + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentPage > 1) jumpToPage(currentPage - 1);
    }
  });

  function jumpToPage(n) {
    const el = document.getElementById(`pw-${n}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    currentPage = n;
    pageNumInput.value = String(n);
  }

  // ─── Theme toggle ─────────────────────────────────────────────────────────
  document.getElementById('btn-theme').addEventListener('click', () => {
    document.body.classList.toggle('theme-dark');
  });

  // ─── Save to PDF (pdf-lib annotations) ───────────────────────────────────
  document.getElementById('btn-save-pdf').addEventListener('click', saveHighlightsToPdf);

  async function saveHighlightsToPdf() {
    const Lib = window.PDFLib;
    if (!Lib) {
      vscode.postMessage({ command: 'showError', text: 'pdf-lib not loaded.' });
      return;
    }

    const allH = Object.values(highlights).flat();
    if (!allH.length) {
      vscode.postMessage({ command: 'showError', text: 'No highlights to save.' });
      return;
    }

    try {
      const resp = await fetch(pdfUrl);
      const buf  = await resp.arrayBuffer();
      const doc  = await Lib.PDFDocument.load(buf);
      const pages = doc.getPages();

      // Group by page
      const byPage = {};
      allH.forEach((h) => { (byPage[h.pageNum] = byPage[h.pageNum] || []).push(h); });

      for (const [pnStr, pHl] of Object.entries(byPage)) {
        const pn  = parseInt(pnStr, 10);
        const pdfPage = pages[pn - 1];
        const dims = pageNaturalDims[pn];
        if (!pdfPage || !dims) continue;

        const { width: natW, height: natH } = dims;

        // Fetch or create Annots array
        const PDFName  = Lib.PDFName;
        const PDFArray = Lib.PDFArray;
        let annots = pdfPage.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
        if (!annots) {
          annots = doc.context.obj([]);
          pdfPage.node.set(PDFName.of('Annots'), annots);
        }

        for (const h of pHl) {
          // Convert normalised [0,1] → PDF coordinates (origin = bottom-left)
          const x1 = h.xNorm * natW;
          const x2 = (h.xNorm + h.wNorm) * natW;
          const y2 = natH - h.yNorm * natH;              // top
          const y1 = natH - (h.yNorm + h.hNorm) * natH; // bottom

          const [r, g, b] = hexToRgbFloat(h.color);

          const annotDict = doc.context.obj({
            Type:       'Annot',
            Subtype:    'Highlight',
            Rect:       [x1, y1, x2, y2],
            // QuadPoints: four corners of each quad (single rect here)
            QuadPoints: [x1, y2, x2, y2, x1, y1, x2, y1],
            C:          [r, g, b],
            CA:         0.5,
            F:          4,   // Print flag
          });
          annots.push(doc.context.register(annotDict));
        }
      }

      const outBytes = await doc.save();
      vscode.postMessage({ command: 'savePdfBytes', data: Array.from(outBytes) });
    } catch (err) {
      console.error(err);
      vscode.postMessage({ command: 'showError', text: 'Error saving PDF: ' + err.message });
    }
  }

  function hexToRgbFloat(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 0];
  }

  // ─── Search ───────────────────────────────────────────────────────────────
  document.getElementById('btn-search-toggle').addEventListener('click', () => {
    searchBar.classList.toggle('hidden');
    if (!searchBar.classList.contains('hidden')) searchInput.focus();
  });
  document.getElementById('btn-search-close').addEventListener('click', () => {
    searchBar.classList.add('hidden');
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      searchBar.classList.remove('hidden');
      searchInput.focus();
    }
    if (e.key === 'Escape' && !searchBar.classList.contains('hidden')) {
      searchBar.classList.add('hidden');
    }
  });

  searchInput.addEventListener('input', async () => {
    const q = searchInput.value.trim().toLowerCase();
    searchMatches = [];
    currentMatchIndex = -1;
    searchCountEl.innerText = '0 / 0';
    if (!q || !pdfDoc) return;

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const tc   = await page.getTextContent();
      const text = tc.items.map((t) => t.str).join(' ').toLowerCase();
      if (text.includes(q)) searchMatches.push({ pageNum: i });
    }

    if (searchMatches.length) {
      currentMatchIndex = 0;
      searchCountEl.innerText = `1 / ${searchMatches.length}`;
      jumpToPage(searchMatches[0].pageNum);
    } else {
      searchCountEl.innerText = '0 / 0';
    }
  });

  document.getElementById('btn-search-next').addEventListener('click', () => {
    if (!searchMatches.length) return;
    currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
    searchCountEl.innerText = `${currentMatchIndex + 1} / ${searchMatches.length}`;
    jumpToPage(searchMatches[currentMatchIndex].pageNum);
  });
  document.getElementById('btn-search-prev').addEventListener('click', () => {
    if (!searchMatches.length) return;
    currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
    searchCountEl.innerText = `${currentMatchIndex + 1} / ${searchMatches.length}`;
    jumpToPage(searchMatches[currentMatchIndex].pageNum);
  });
})();
