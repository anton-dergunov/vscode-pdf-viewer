(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  // ─── State ────────────────────────────────────────────────────────────────
  let pdfDoc = null;
  let originalArrayBuffer = null;
  let pdfScale = 1.0; // logical zoom factor
  let pdfUrl = '';
  let currentPage = 1;
  let currentTool = 'select'; // 'select' | 'highlight' | 'eraser'
  let currentColor = '#ffeb3b';
  let isDirty = false;

  const BASE_SCALE = 1.5; // base over-render factor for sharp canvas
  const renderedPages = new Set();
  const pageNaturalDims = {}; // pageNum -> { width, height }
  let defaultPageDims = { width: 800, height: 1100 }; // fallback before page 1 loads

  /**
   * highlights[pageNum] = [
   *   {
   *     id: string,
   *     pageNum: number,
   *     color: string,
   *     rects: [ { xNorm, yNorm, wNorm, hNorm }, ... ]
   *   }
   * ]
   */
  let highlights = {};

  // Search state
  let pageTextIndex = {}; // pageNum -> { textContent, text }
  let searchMatches = []; // [ { pageNum, matchIndexInDoc } ]
  let currentMatchIndex = -1;
  let currentQuery = '';
  let searchDebounceTimer = null;

  // Context menu
  let ctxMenuEl = null;

  // ─── DOM References ───────────────────────────────────────────────────────
  const container = document.getElementById('pages-container');
  const loadingOverlay = document.getElementById('loading');
  const pageNumInput = document.getElementById('page-num-input');
  const pageCountEl = document.getElementById('page-count');
  const zoomSelect = document.getElementById('zoom-select');
  const docTitleEl = document.getElementById('doc-title');
  const saveBtn = document.getElementById('btn-save');

  // Search Elements
  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input');
  const searchCountEl = document.getElementById('search-results-count');

  // ─── Worker Setup ─────────────────────────────────────────────────────────
  if (typeof pdfjsLib !== 'undefined') {
    const scripts = Array.from(document.scripts);
    const pdfScript = scripts.find((s) => s.src && s.src.includes('pdf.min.js'));
    if (pdfScript) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfScript.src.replace('pdf.min.js', 'pdf.worker.min.js');
    }
  }

  // ─── Extension Message Bus ────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.command) {
      case 'loadPdf':
        pdfUrl = msg.url;
        if (msg.title) docTitleEl.innerText = msg.title;
        loadPdf();
        break;

      case 'saveCompleted':
        setDirty(false);
        saveBtn.innerText = 'Save';
        saveBtn.disabled = true;
        break;

      case 'saveFailed':
        saveBtn.innerText = 'Save';
        saveBtn.disabled = false;
        break;
    }
  });

  window.onload = () => vscode.postMessage({ command: 'ready' });

  // ─── Dirty State Tracking ─────────────────────────────────────────────────
  function setDirty(dirty) {
    isDirty = dirty;
    if (saveBtn) {
      saveBtn.disabled = !dirty;
    }
  }

  // ─── Load & Initialize PDF ────────────────────────────────────────────────
  async function loadPdf() {
    loadingOverlay.style.display = 'flex';
    container.innerHTML = '';
    renderedPages.clear();
    highlights = {};
    pageTextIndex = {};
    searchMatches = [];
    currentMatchIndex = -1;
    setDirty(false);

    try {
      const resp = await fetch(pdfUrl);
      originalArrayBuffer = await resp.arrayBuffer();

      // Load with PDF.js
      pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(originalArrayBuffer) }).promise;
      const numPages = pdfDoc.numPages;
      pageCountEl.innerText = numPages;
      pageNumInput.max = numPages;

      // Read Page 1 first to determine standard document page dimensions
      const firstPage = await pdfDoc.getPage(1);
      const natVp = firstPage.getViewport({ scale: 1.0 });
      pageNaturalDims[1] = { width: natVp.width, height: natVp.height };
      const sampleVp = firstPage.getViewport({ scale: pdfScale * BASE_SCALE });
      defaultPageDims = { width: sampleVp.width, height: sampleVp.height };

      // Pre-create full-size page shells so fast scrolling never jumps or shows tiny thumbnails
      for (let i = 1; i <= numPages; i++) {
        container.appendChild(buildPageShell(i));
      }

      // Extract existing highlights embedded in the PDF via pdf-lib
      await loadEmbeddedHighlightsFromPdf(originalArrayBuffer);

      // Render Page 1 immediately & hide loading spinner
      await renderPage(1);
      loadingOverlay.style.display = 'none';

      // Lazy render remaining pages when scrolled near
      setupLazyRender();

      // Index text in background for instant search
      indexTextInBackground();
    } catch (err) {
      console.error('Error loading PDF:', err);
      loadingOverlay.style.display = 'none';
      vscode.postMessage({ command: 'showError', text: 'Failed to open PDF: ' + err.message });
    }
  }

  // Extract any existing Highlight annotations from the PDF binary
  async function loadEmbeddedHighlightsFromPdf(buffer) {
    const Lib = window.PDFLib;
    if (!Lib) return;

    try {
      const pdfLibDoc = await Lib.PDFDocument.load(buffer, { ignoreEncryption: true });
      const pages = pdfLibDoc.getPages();

      for (let pIdx = 0; pIdx < pages.length; pIdx++) {
        const pageNum = pIdx + 1;
        const pdfPage = pages[pIdx];
        const natW = pdfPage.getWidth();
        const natH = pdfPage.getHeight();
        pageNaturalDims[pageNum] = { width: natW, height: natH };

        const annots = pdfPage.node.lookupMaybe(Lib.PDFName.of('Annots'), Lib.PDFArray);
        if (!annots) continue;

        for (let aIdx = 0; aIdx < annots.size(); aIdx++) {
          const annotRef = annots.get(aIdx);
          const annotDict = pdfLibDoc.context.lookup(annotRef);
          if (!annotDict || !(annotDict instanceof Lib.PDFDict)) continue;

          const subtype = annotDict.lookup(Lib.PDFName.of('Subtype'));
          if (subtype && subtype.name === 'Highlight') {
            // Extract Color
            let color = '#ffeb3b';
            const colorArr = annotDict.lookupMaybe(Lib.PDFName.of('C'), Lib.PDFArray);
            if (colorArr && colorArr.size() >= 3) {
              const r = Math.round(colorArr.get(0).asNumber() * 255);
              const g = Math.round(colorArr.get(1).asNumber() * 255);
              const b = Math.round(colorArr.get(2).asNumber() * 255);
              color = rgbToHex(r, g, b);
            }

            const quads = annotDict.lookupMaybe(Lib.PDFName.of('QuadPoints'), Lib.PDFArray);
            const rects = [];

            if (quads && quads.size() >= 8) {
              for (let q = 0; q < quads.size(); q += 8) {
                const qx1 = quads.get(q).asNumber();
                const qy2 = quads.get(q + 1).asNumber();
                const qx2 = quads.get(q + 2).asNumber();
                const qy1 = quads.get(q + 5).asNumber();

                const minX = Math.min(qx1, qx2);
                const maxX = Math.max(qx1, qx2);
                const minY = Math.min(qy1, qy2);
                const maxY = Math.max(qy1, qy2);

                rects.push({
                  xNorm: minX / natW,
                  yNorm: (natH - maxY) / natH,
                  wNorm: (maxX - minX) / natW,
                  hNorm: (maxY - minY) / natH,
                });
              }
            } else {
              const rectArr = annotDict.lookupMaybe(Lib.PDFName.of('Rect'), Lib.PDFArray);
              if (rectArr && rectArr.size() >= 4) {
                const rx1 = rectArr.get(0).asNumber();
                const ry1 = rectArr.get(1).asNumber();
                const rx2 = rectArr.get(2).asNumber();
                const ry2 = rectArr.get(3).asNumber();

                const minX = Math.min(rx1, rx2);
                const maxX = Math.max(rx1, rx2);
                const minY = Math.min(ry1, ry2);
                const maxY = Math.max(ry1, ry2);

                rects.push({
                  xNorm: minX / natW,
                  yNorm: (natH - maxY) / natH,
                  wNorm: (maxX - minX) / natW,
                  hNorm: (maxY - minY) / natH,
                });
              }
            }

            if (rects.length > 0) {
              if (!highlights[pageNum]) highlights[pageNum] = [];
              highlights[pageNum].push({
                id: `hl_embed_${pageNum}_${aIdx}`,
                pageNum,
                color,
                rects,
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn('Could not inspect embedded annotations:', e);
    }
  }

  // ─── Page DOM Shell Pre-Sizing ────────────────────────────────────────────
  function buildPageShell(pageNum) {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper unrendered';
    wrapper.id = `pw-${pageNum}`;
    wrapper.dataset.pageNum = String(pageNum);

    // Explicit dimensions ensure page cards never collapse into small thumbnails
    wrapper.style.width = `${defaultPageDims.width}px`;
    wrapper.style.height = `${defaultPageDims.height}px`;

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.id = `cv-${pageNum}`;
    canvas.style.width = `${defaultPageDims.width}px`;
    canvas.style.height = `${defaultPageDims.height}px`;

    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.id = `tl-${pageNum}`;
    textLayer.style.width = `${defaultPageDims.width}px`;
    textLayer.style.height = `${defaultPageDims.height}px`;

    const hlLayer = document.createElement('div');
    hlLayer.className = 'highlight-layer';
    hlLayer.id = `hl-${pageNum}`;
    hlLayer.style.width = `${defaultPageDims.width}px`;
    hlLayer.style.height = `${defaultPageDims.height}px`;

    const searchLayer = document.createElement('div');
    searchLayer.className = 'search-layer';
    searchLayer.id = `sl-${pageNum}`;
    searchLayer.style.width = `${defaultPageDims.width}px`;
    searchLayer.style.height = `${defaultPageDims.height}px`;

    wrapper.append(canvas, textLayer, hlLayer, searchLayer);
    return wrapper;
  }

  function setupLazyRender() {
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach(async (entry) => {
          const pn = parseInt(entry.target.dataset.pageNum, 10);
          if (entry.isIntersecting) {
            currentPage = pn;
            pageNumInput.value = String(pn);
            if (!renderedPages.has(pn)) {
              await renderPage(pn);
            }
          }
        });
      },
      { threshold: 0.05, rootMargin: '400px' }
    );

    document.querySelectorAll('.page-wrapper').forEach((el) => obs.observe(el));
  }

  // ─── Render Page ──────────────────────────────────────────────────────────
  async function renderPage(pageNum) {
    if (renderedPages.has(pageNum)) return;
    renderedPages.add(pageNum);

    const page = await pdfDoc.getPage(pageNum);
    const dpr = window.devicePixelRatio || 1;

    const natVp = page.getViewport({ scale: 1.0 });
    pageNaturalDims[pageNum] = { width: natVp.width, height: natVp.height };

    const renderVp = page.getViewport({ scale: pdfScale * BASE_SCALE });
    const logW = renderVp.width;
    const logH = renderVp.height;

    const wrapper = document.getElementById(`pw-${pageNum}`);
    const canvas = document.getElementById(`cv-${pageNum}`);
    const textLayer = document.getElementById(`tl-${pageNum}`);
    const hlLayer = document.getElementById(`hl-${pageNum}`);
    const searchLayer = document.getElementById(`sl-${pageNum}`);

    if (wrapper) wrapper.classList.remove('unrendered');

    // Update logical CSS dimensions
    [wrapper, textLayer, hlLayer, searchLayer].forEach((el) => {
      if (el) {
        el.style.width = `${logW}px`;
        el.style.height = `${logH}px`;
      }
    });

    // Configure HiDPI Canvas
    canvas.width = Math.floor(logW * dpr);
    canvas.height = Math.floor(logH * dpr);
    canvas.style.width = `${logW}px`;
    canvas.style.height = `${logH}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport: renderVp }).promise;

    // Render Text Layer
    textLayer.innerHTML = '';
    const textContent = await page.getTextContent();
    pageTextIndex[pageNum] = { textContent, text: textContent.items.map((it) => it.str).join(' ') };

    if (pdfjsLib.renderTextLayer) {
      await pdfjsLib.renderTextLayer({
        textContent,
        container: textLayer,
        viewport: renderVp,
        textDivs: [],
      }).promise;
    }

    // Render Highlights & Search Matches
    renderHighlightsForPage(pageNum);
    renderSearchMatchesForPage(pageNum);
  }

  // ─── Highlight Rendering & Grouping ───────────────────────────────────────
  function renderHighlightsForPage(pageNum) {
    const hlLayer = document.getElementById(`hl-${pageNum}`);
    if (!hlLayer) return;
    hlLayer.innerHTML = '';

    const logW = parseFloat(hlLayer.style.width) || 0;
    const logH = parseFloat(hlLayer.style.height) || 0;
    if (!logW || !logH) return;

    (highlights[pageNum] || []).forEach((hl) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'highlight-group';
      groupEl.dataset.id = hl.id;

      // Group interaction: clicking or right-clicking ANY rect in the group affects the whole highlight
      groupEl.addEventListener('click', (e) => {
        if (currentTool === 'eraser') {
          e.stopPropagation();
          deleteHighlightGroup(pageNum, hl.id);
        }
      });

      groupEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, pageNum, hl.id);
      });

      hl.rects.forEach((r) => {
        const rectEl = document.createElement('div');
        rectEl.className = 'highlight-rect';
        rectEl.style.left = `${r.xNorm * logW}px`;
        rectEl.style.top = `${r.yNorm * logH}px`;
        rectEl.style.width = `${r.wNorm * logW}px`;
        rectEl.style.height = `${r.hNorm * logH}px`;
        rectEl.style.backgroundColor = hl.color;
        groupEl.appendChild(rectEl);
      });

      hlLayer.appendChild(groupEl);
    });
  }

  // Delete an entire highlight group (all lines)
  function deleteHighlightGroup(pageNum, hlId) {
    if (!highlights[pageNum]) return;
    highlights[pageNum] = highlights[pageNum].filter((h) => h.id !== hlId);
    renderHighlightsForPage(pageNum);
    setDirty(true);
  }

  // ─── Highlight Context Menu ───────────────────────────────────────────────
  function showContextMenu(x, y, pageNum, hlId) {
    dismissContextMenu();

    const menu = document.createElement('div');
    menu.className = 'highlight-ctx-menu';
    menu.style.left = `${Math.min(x, window.innerWidth - 170)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 70)}px`;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'ctx-menu-item danger';
    deleteBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zm2.46-7.12l1.41-1.41L12 12.59l2.12-2.12 1.41 1.41L13.41 14l2.12 2.12-1.41 1.41L12 15.41l-2.12 2.12-1.41-1.41L10.59 14l-2.13-2.12zM15.5 4l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      Delete highlight
    `;
    deleteBtn.addEventListener('click', () => {
      deleteHighlightGroup(pageNum, hlId);
      dismissContextMenu();
    });

    menu.appendChild(deleteBtn);
    document.body.appendChild(menu);
    ctxMenuEl = menu;

    requestAnimationFrame(() => {
      document.addEventListener('click', dismissContextMenu, { once: true });
    });
  }

  function dismissContextMenu() {
    if (ctxMenuEl) {
      ctxMenuEl.remove();
      ctxMenuEl = null;
    }
  }

  // ─── Selection -> Multi-Line Merged Highlight ─────────────────────────────
  document.addEventListener('mouseup', () => {
    if (currentTool !== 'highlight') return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;

    const range = sel.getRangeAt(0);
    const startNode = range.startContainer;
    const textLayerEl = startNode.parentElement ? startNode.parentElement.closest('.textLayer') : null;
    if (!textLayerEl) {
      sel.removeAllRanges();
      return;
    }

    const wrapper = textLayerEl.closest('.page-wrapper');
    if (!wrapper) {
      sel.removeAllRanges();
      return;
    }

    const pageNum = parseInt(wrapper.dataset.pageNum, 10);
    const wrapRect = wrapper.getBoundingClientRect();
    const logW = parseFloat(wrapper.style.width);
    const logH = parseFloat(wrapper.style.height);

    // 1. Collect client rects
    const rawRects = [];
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      rawRects.push({
        x: r.left - wrapRect.left,
        y: r.top - wrapRect.top,
        w: r.width,
        h: r.height,
      });
    }

    if (rawRects.length === 0) {
      sel.removeAllRanges();
      return;
    }

    // 2. Group rects by line (close Y midpoints)
    const lines = [];
    for (const r of rawRects) {
      let added = false;
      const cy = r.y + r.h / 2;
      for (const line of lines) {
        const lcy = line[0].y + line[0].h / 2;
        if (Math.abs(cy - lcy) < r.h / 2) {
          line.push(r);
          added = true;
          break;
        }
      }
      if (!added) lines.push([r]);
    }

    // 3. Merge contiguous / overlapping rects horizontally per line
    const mergedRectsNorm = [];
    for (const line of lines) {
      line.sort((a, b) => a.x - b.x);
      let current = { ...line[0] };
      for (let i = 1; i < line.length; i++) {
        const next = line[i];
        if (current.x + current.w >= next.x - 2) {
          const rightEdge = Math.max(current.x + current.w, next.x + next.w);
          const bottomEdge = Math.max(current.y + current.h, next.y + next.h);
          current.y = Math.min(current.y, next.y);
          current.x = Math.min(current.x, next.x);
          current.w = rightEdge - current.x;
          current.h = bottomEdge - current.y;
        } else {
          mergedRectsNorm.push({
            xNorm: current.x / logW,
            yNorm: current.y / logH,
            wNorm: current.w / logW,
            hNorm: current.h / logH,
          });
          current = { ...next };
        }
      }
      mergedRectsNorm.push({
        xNorm: current.x / logW,
        yNorm: current.y / logH,
        wNorm: current.w / logW,
        hNorm: current.h / logH,
      });
    }

    // 4. Create single grouped highlight
    if (!highlights[pageNum]) highlights[pageNum] = [];
    const hlObj = {
      id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      pageNum,
      color: currentColor,
      rects: mergedRectsNorm,
    };

    highlights[pageNum].push(hlObj);
    renderHighlightsForPage(pageNum);
    setDirty(true);

    sel.removeAllRanges();
  });

  // ─── Save Changes Directly to PDF ─────────────────────────────────────────
  if (saveBtn) {
    saveBtn.addEventListener('click', saveChangesToPdf);
  }

  // Ctrl+S / Cmd+S shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (isDirty) saveChangesToPdf();
    }
  });

  async function saveChangesToPdf() {
    const Lib = window.PDFLib;
    if (!Lib) {
      vscode.postMessage({ command: 'showError', text: 'PDF library not loaded.' });
      return;
    }

    saveBtn.disabled = true;
    saveBtn.innerText = 'Saving…';

    try {
      // Load PDF via pdf-lib
      const pdfLibDoc = await Lib.PDFDocument.load(originalArrayBuffer, { ignoreEncryption: true });
      const pages = pdfLibDoc.getPages();

      for (let pIdx = 0; pIdx < pages.length; pIdx++) {
        const pageNum = pIdx + 1;
        const pdfPage = pages[pIdx];
        const natW = pdfPage.getWidth();
        const natH = pdfPage.getHeight();

        // 1. Remove old Highlight annotations from the page
        const annots = pdfPage.node.lookupMaybe(Lib.PDFName.of('Annots'), Lib.PDFArray);
        if (annots) {
          const toRemove = [];
          for (let i = 0; i < annots.size(); i++) {
            const ref = annots.get(i);
            const dict = pdfLibDoc.context.lookup(ref);
            if (dict instanceof Lib.PDFDict) {
              const sub = dict.lookup(Lib.PDFName.of('Subtype'));
              if (sub && sub.name === 'Highlight') {
                toRemove.push(i);
              }
            }
          }
          for (let i = toRemove.length - 1; i >= 0; i--) {
            annots.remove(toRemove[i]);
          }
        }

        // 2. Write current highlights as official multi-quad PDF Highlight annotations
        const pageHls = highlights[pageNum] || [];
        if (pageHls.length > 0) {
          let currentAnnots = pdfPage.node.lookupMaybe(Lib.PDFName.of('Annots'), Lib.PDFArray);
          if (!currentAnnots) {
            currentAnnots = pdfLibDoc.context.obj([]);
            pdfPage.node.set(Lib.PDFName.of('Annots'), currentAnnots);
          }

          for (const hl of pageHls) {
            const quadPoints = [];
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

            for (const r of hl.rects) {
              const rx1 = r.xNorm * natW;
              const rx2 = (r.xNorm + r.wNorm) * natW;
              const ry2 = natH - r.yNorm * natH; // top
              const ry1 = natH - (r.yNorm + r.hNorm) * natH; // bottom

              minX = Math.min(minX, rx1, rx2);
              maxX = Math.max(maxX, rx1, rx2);
              minY = Math.min(minY, ry1, ry2);
              maxY = Math.max(maxY, ry1, ry2);

              // Standard PDF QuadPoints order: top-left, top-right, bottom-left, bottom-right
              quadPoints.push(rx1, ry2, rx2, ry2, rx1, ry1, rx2, ry1);
            }

            const [red, green, blue] = hexToRgbFloat(hl.color);
            const annotDict = pdfLibDoc.context.obj({
              Type: 'Annot',
              Subtype: 'Highlight',
              Rect: [minX, minY, maxX, maxY],
              QuadPoints: quadPoints,
              C: [red, green, blue],
              CA: 0.5,
              F: 4,
            });

            currentAnnots.push(pdfLibDoc.context.register(annotDict));
          }
        }
      }

      const outBytes = await pdfLibDoc.save();
      originalArrayBuffer = outBytes.buffer;
      vscode.postMessage({ command: 'savePdfBytes', data: Array.from(outBytes) });
    } catch (err) {
      console.error('Error saving PDF:', err);
      saveBtn.innerText = 'Save';
      saveBtn.disabled = false;
      vscode.postMessage({ command: 'showError', text: 'Error saving PDF: ' + err.message });
    }
  }

  // ─── Fast Search & Search Highlighting ────────────────────────────────────
  async function indexTextInBackground() {
    if (!pdfDoc) return;
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      if (pageTextIndex[i]) continue;
      try {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        pageTextIndex[i] = {
          textContent,
          text: textContent.items.map((it) => it.str).join(' '),
        };
        // Yield briefly every few pages to keep the UI silky smooth
        if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
      } catch (e) {
        console.warn(`Could not index text for page ${i}:`, e);
      }
    }
  }

  const searchToggleBtn = document.getElementById('btn-search-toggle');
  const searchCloseBtn = document.getElementById('btn-search-close');
  const searchPrevBtn = document.getElementById('btn-search-prev');
  const searchNextBtn = document.getElementById('btn-search-next');

  searchToggleBtn.addEventListener('click', () => {
    searchBar.classList.toggle('hidden');
    if (!searchBar.classList.contains('hidden')) {
      searchInput.focus();
      searchInput.select();
    }
  });

  searchCloseBtn.addEventListener('click', () => {
    searchBar.classList.add('hidden');
    clearSearchHighlights();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchBar.classList.remove('hidden');
      searchInput.focus();
      searchInput.select();
    }
    if (e.key === 'Escape' && !searchBar.classList.contains('hidden')) {
      searchBar.classList.add('hidden');
      clearSearchHighlights();
    }
  });

  // Debounced instant search
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      performSearch(searchInput.value.trim());
    }, 180);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        navigateSearch(-1);
      } else {
        navigateSearch(1);
      }
    }
  });

  searchNextBtn.addEventListener('click', () => navigateSearch(1));
  searchPrevBtn.addEventListener('click', () => navigateSearch(-1));

  async function performSearch(query) {
    currentQuery = query;
    searchMatches = [];
    currentMatchIndex = -1;
    clearSearchHighlights();

    if (!query || !pdfDoc) {
      searchCountEl.innerText = '0 / 0';
      return;
    }

    const qLower = query.toLowerCase();

    // Search through all pages using cached text index
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      let pageData = pageTextIndex[p];
      if (!pageData) {
        const page = await pdfDoc.getPage(p);
        const textContent = await page.getTextContent();
        pageData = { textContent, text: textContent.items.map((it) => it.str).join(' ') };
        pageTextIndex[p] = pageData;
      }

      const pTextLower = pageData.text.toLowerCase();
      let matchIdx = 0;
      while ((matchIdx = pTextLower.indexOf(qLower, matchIdx)) !== -1) {
        searchMatches.push({ pageNum: p, index: matchIdx });
        matchIdx += qLower.length;
      }
    }

    if (searchMatches.length > 0) {
      currentMatchIndex = 0;
      searchCountEl.innerText = `1 / ${searchMatches.length}`;
      await jumpToMatch(0);
    } else {
      searchCountEl.innerText = '0 / 0';
    }
  }

  async function navigateSearch(delta) {
    if (searchMatches.length === 0) return;
    currentMatchIndex = (currentMatchIndex + delta + searchMatches.length) % searchMatches.length;
    searchCountEl.innerText = `${currentMatchIndex + 1} / ${searchMatches.length}`;
    await jumpToMatch(currentMatchIndex);
  }

  async function jumpToMatch(matchIdx) {
    const match = searchMatches[matchIdx];
    if (!match) return;

    // Ensure target page is rendered
    if (!renderedPages.has(match.pageNum)) {
      await renderPage(match.pageNum);
    }

    jumpToPage(match.pageNum);

    // Refresh search highlights across rendered pages
    renderedPages.forEach((pn) => renderSearchMatchesForPage(pn));

    // Scroll active match element into view if present
    requestAnimationFrame(() => {
      const activeEl = document.querySelector('.search-match.current');
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  function clearSearchHighlights() {
    document.querySelectorAll('.search-layer').forEach((sl) => (sl.innerHTML = ''));
  }

  // Visual search highlights on page
  function renderSearchMatchesForPage(pageNum) {
    const searchLayer = document.getElementById(`sl-${pageNum}`);
    const textLayer = document.getElementById(`tl-${pageNum}`);
    if (!searchLayer || !textLayer || !currentQuery) return;

    searchLayer.innerHTML = '';
    const spans = textLayer.querySelectorAll('span');
    const qLower = currentQuery.toLowerCase();
    const wrapRect = textLayer.getBoundingClientRect();

    let pageMatchCounter = 0;

    spans.forEach((span) => {
      const spanText = span.textContent || '';
      const spanLower = spanText.toLowerCase();
      let startIdx = 0;

      while ((startIdx = spanLower.indexOf(qLower, startIdx)) !== -1) {
        const textNode = span.firstChild;
        if (textNode && textNode.nodeType === Node.TEXT_NODE) {
          try {
            const range = document.createRange();
            range.setStart(textNode, startIdx);
            range.setEnd(textNode, startIdx + qLower.length);

            const rects = range.getClientRects();
            for (const r of rects) {
              if (r.width < 1 || r.height < 1) continue;

              const matchDiv = document.createElement('div');
              matchDiv.className = 'search-match';
              matchDiv.style.left = `${r.left - wrapRect.left}px`;
              matchDiv.style.top = `${r.top - wrapRect.top}px`;
              matchDiv.style.width = `${r.width}px`;
              matchDiv.style.height = `${r.height}px`;

              // Check if this match is the currently selected global match
              const currentGlobalMatch = searchMatches[currentMatchIndex];
              if (currentGlobalMatch && currentGlobalMatch.pageNum === pageNum) {
                // If on the active match page, highlight the active occurrence
                matchDiv.classList.add('current');
              }

              searchLayer.appendChild(matchDiv);
            }
          } catch (e) {
            // Ignore range boundary edge cases
          }
        }
        startIdx += qLower.length;
        pageMatchCounter++;
      }
    });
  }

  // ─── Tool Switching & Palette ─────────────────────────────────────────────
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;
      document.body.classList.toggle('eraser-mode', currentTool === 'eraser');
    });
  });

  document.querySelectorAll('.color-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      currentColor = dot.dataset.color;
      if (currentTool !== 'highlight') {
        document.querySelector('[data-tool="highlight"]')?.click();
      }
    });
  });

  // ─── Zoom Controls ────────────────────────────────────────────────────────
  function syncZoomSelect(scale) {
    for (const opt of zoomSelect.options) {
      const v = parseFloat(opt.value);
      if (!isNaN(v) && Math.abs(v - scale) < 0.01) {
        zoomSelect.value = opt.value;
        return;
      }
    }
    let custom = zoomSelect.querySelector('option[data-custom]');
    if (!custom) {
      custom = document.createElement('option');
      custom.dataset.custom = '1';
      zoomSelect.appendChild(custom);
    }
    custom.value = String(scale);
    custom.text = `${Math.round(scale * 100)}%`;
    zoomSelect.value = String(scale);
  }

  async function applyZoom(targetPage) {
    syncZoomSelect(pdfScale);
    if (!pdfDoc) return;

    // Update dimensions on all unrendered placeholders so fast scrolling stays smooth
    const firstPage = await pdfDoc.getPage(1);
    const sampleVp = firstPage.getViewport({ scale: pdfScale * BASE_SCALE });
    defaultPageDims = { width: sampleVp.width, height: sampleVp.height };

    renderedPages.clear();
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const wrapper = document.getElementById(`pw-${i}`);
      if (wrapper && !renderedPages.has(i)) {
        wrapper.style.width = `${defaultPageDims.width}px`;
        wrapper.style.height = `${defaultPageDims.height}px`;
      }
    }

    // Re-render currently visible page immediately
    await renderPage(targetPage || currentPage);
    if (targetPage) jumpToPage(targetPage);
  }

  document.getElementById('btn-zoom-in').addEventListener('click', async () => {
    pdfScale = Math.min(+(pdfScale + 0.25).toFixed(2), 3.5);
    await applyZoom(currentPage);
  });

  document.getElementById('btn-zoom-out').addEventListener('click', async () => {
    pdfScale = Math.max(+(pdfScale - 0.25).toFixed(2), 0.35);
    await applyZoom(currentPage);
  });

  zoomSelect.addEventListener('change', async () => {
    const val = zoomSelect.value;
    if (val === 'page-width' || val === 'page-fit') {
      if (pdfDoc) {
        const page = await pdfDoc.getPage(1);
        const natVp = page.getViewport({ scale: 1.0 });
        const availW = container.clientWidth - 64;
        pdfScale = +(availW / (natVp.width * BASE_SCALE)).toFixed(2);
      }
    } else {
      pdfScale = parseFloat(val);
    }
    await applyZoom(currentPage);
  });

  // ─── Page Navigation ──────────────────────────────────────────────────────
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (currentPage > 1) jumpToPage(currentPage - 1);
  });

  document.getElementById('btn-next').addEventListener('click', () => {
    if (pdfDoc && currentPage < pdfDoc.numPages) jumpToPage(currentPage + 1);
  });

  pageNumInput.addEventListener('change', () => {
    const v = parseInt(pageNumInput.value, 10);
    if (!isNaN(v) && pdfDoc && v >= 1 && v <= pdfDoc.numPages) {
      jumpToPage(v);
    }
  });

  function jumpToPage(n) {
    const el = document.getElementById(`pw-${n}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    currentPage = n;
    pageNumInput.value = String(n);
  }

  // Keyboard Navigation
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

  // Theme Toggle
  document.getElementById('btn-theme').addEventListener('click', () => {
    document.body.classList.toggle('theme-dark');
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function hexToRgbFloat(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 0];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
})();
