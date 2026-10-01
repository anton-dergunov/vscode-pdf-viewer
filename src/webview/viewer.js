(function () {
  const vscode = acquireVsCodeApi();

  let pdfDoc = null;
  let pdfScale = 1.0;
  let pdfUrl = '';
  let currentPage = 1;
  let currentTool = 'select'; // 'select', 'highlight', 'eraser'
  let currentColor = '#ffeb3b'; // default yellow
  let storedHighlights = {}; // pageNum -> array of highlight rects

  // Search state
  let searchMatches = []; // { pageNum, matchIndex, text }
  let currentMatchIndex = -1;

  // DOM Elements
  const container = document.getElementById('pages-container');
  const loadingOverlay = document.getElementById('loading');
  const pageNumInput = document.getElementById('page-num-input');
  const pageCountEl = document.getElementById('page-count');
  const zoomSelect = document.getElementById('zoom-select');
  const docTitleEl = document.getElementById('doc-title');

  // Search Elements
  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input');
  const searchCountEl = document.getElementById('search-results-count');

  // Initialize PDF.js worker
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = getPdfWorkerUri();
  }

  function getPdfWorkerUri() {
    const scripts = document.getElementsByTagName('script');
    for (let s of scripts) {
      if (s.src && s.src.includes('pdf.min.js')) {
        return s.src.replace('pdf.min.js', 'pdf.worker.min.js');
      }
    }
    return 'dist/media/pdfjs/pdf.worker.min.js';
  }

  // Handle messages from VS Code Extension Host
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
      case 'loadPdf':
        pdfUrl = message.url;
        if (message.title) {
          docTitleEl.innerText = message.title;
        }
        if (Array.isArray(message.highlights)) {
          // Convert array of highlights to map by page
          storedHighlights = {};
          message.highlights.forEach((h) => {
            if (!storedHighlights[h.pageNum]) {
              storedHighlights[h.pageNum] = [];
            }
            storedHighlights[h.pageNum].push(h);
          });
        }
        renderPdf();
        break;
    }
  });

  // Signal ready to provider
  window.onload = () => {
    vscode.postMessage({ command: 'ready' });
  };

  // Main Render PDF Function
  async function renderPdf() {
    try {
      loadingOverlay.style.display = 'flex';
      container.innerHTML = '';

      pdfDoc = await pdfjsLib.getDocument({ url: pdfUrl }).promise;
      pageCountEl.innerText = pdfDoc.numPages;
      pageNumInput.max = pdfDoc.numPages;

      for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const pageWrapper = createPageDOM(pageNum);
        container.appendChild(pageWrapper);
        await renderPage(pageNum);
      }

      setupIntersectionObserver();
      loadingOverlay.style.display = 'none';
    } catch (err) {
      console.error('Error rendering PDF:', err);
      loadingOverlay.style.display = 'none';
      vscode.postMessage({ command: 'showError', text: 'Failed to load PDF: ' + err.message });
    }
  }

  // Create DOM nodes for a PDF page
  function createPageDOM(pageNum) {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.id = `page-wrapper-${pageNum}`;
    wrapper.dataset.pageNum = pageNum;

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.id = `canvas-${pageNum}`;

    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.id = `text-layer-${pageNum}`;

    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';
    highlightLayer.id = `highlight-layer-${pageNum}`;

    wrapper.appendChild(canvas);
    wrapper.appendChild(textLayer);
    wrapper.appendChild(highlightLayer);

    return wrapper;
  }

  // Render an individual page with HiDPI/Retina support
  async function renderPage(pageNum) {
    const page = await pdfDoc.getPage(pageNum);
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: pdfScale * 1.5 });

    // Logical (CSS) dimensions
    const logicalWidth = viewport.width;
    const logicalHeight = viewport.height;

    // Physical pixel dimensions (canvas buffer size)
    const physicalWidth = Math.floor(logicalWidth * dpr);
    const physicalHeight = Math.floor(logicalHeight * dpr);

    const wrapper = document.getElementById(`page-wrapper-${pageNum}`);
    const canvas = document.getElementById(`canvas-${pageNum}`);
    const textLayer = document.getElementById(`text-layer-${pageNum}`);
    const highlightLayer = document.getElementById(`highlight-layer-${pageNum}`);

    // Wrapper and overlay layers use logical (CSS) dimensions
    wrapper.style.width = `${logicalWidth}px`;
    wrapper.style.height = `${logicalHeight}px`;

    // Canvas buffer is at full physical resolution
    canvas.width = physicalWidth;
    canvas.height = physicalHeight;
    // But CSS display size is logical — browser scales it down for sharpness
    canvas.style.width = `${logicalWidth}px`;
    canvas.style.height = `${logicalHeight}px`;

    textLayer.style.width = `${logicalWidth}px`;
    textLayer.style.height = `${logicalHeight}px`;

    highlightLayer.style.width = `${logicalWidth}px`;
    highlightLayer.style.height = `${logicalHeight}px`;

    // Scale the 2D context by DPR so PDF.js draws at full physical resolution
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Render Text Layer for text selection (uses logical viewport)
    textLayer.innerHTML = '';
    const textContent = await page.getTextContent();
    if (pdfjsLib.renderTextLayer) {
      const renderTask = pdfjsLib.renderTextLayer({
        textContent: textContent,
        container: textLayer,
        viewport: viewport,
        textDivs: [],
      });
      await renderTask.promise;
    }

    // Render existing highlights for this page
    renderHighlightsForPage(pageNum);
  }

  // Render highlights onto page's highlight layer
  function renderHighlightsForPage(pageNum) {
    const highlightLayer = document.getElementById(`highlight-layer-${pageNum}`);
    if (!highlightLayer) return;
    highlightLayer.innerHTML = '';

    const pageHighlights = storedHighlights[pageNum] || [];
    pageHighlights.forEach((h) => {
      const rect = document.createElement('div');
      rect.className = 'highlight-rect';
      rect.dataset.id = h.id;
      rect.style.left = `${h.x}px`;
      rect.style.top = `${h.y}px`;
      rect.style.width = `${h.w}px`;
      rect.style.height = `${h.h}px`;
      rect.style.backgroundColor = h.color;

      rect.addEventListener('click', (e) => {
        if (currentTool === 'eraser') {
          e.stopPropagation();
          deleteHighlight(pageNum, h.id);
        }
      });

      highlightLayer.appendChild(rect);
    });
  }

  // Highlighting Selection Listener
  document.addEventListener('mouseup', () => {
    if (currentTool !== 'highlight') return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;

    const range = sel.getRangeAt(0);
    const startNode = range.startContainer;
    const textLayer = startNode.parentElement ? startNode.parentElement.closest('.textLayer') : null;
    if (!textLayer) return;

    const wrapper = textLayer.closest('.page-wrapper');
    if (!wrapper) return;

    const pageNum = parseInt(wrapper.dataset.pageNum);
    const wrapRect = wrapper.getBoundingClientRect();
    const rects = range.getClientRects();

    if (!storedHighlights[pageNum]) {
      storedHighlights[pageNum] = [];
    }

    let addedAny = false;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.width < 2 || r.h < 2) continue;

      const hObj = {
        id: 'hl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        pageNum: pageNum,
        x: r.left - wrapRect.left,
        y: r.top - wrapRect.top,
        w: r.width,
        h: r.height,
        color: currentColor,
      };

      storedHighlights[pageNum].push(hObj);
      addedAny = true;
    }

    if (addedAny) {
      renderHighlightsForPage(pageNum);
      saveHighlights(false);
    }

    sel.removeAllRanges();
  });

  // Delete a highlight
  function deleteHighlight(pageNum, highlightId) {
    if (!storedHighlights[pageNum]) return;
    storedHighlights[pageNum] = storedHighlights[pageNum].filter((h) => h.id !== highlightId);
    renderHighlightsForPage(pageNum);
    saveHighlights(false);
  }

  // Save highlights payload to extension host
  function saveHighlights(notify = false) {
    const allHighlights = [];
    Object.keys(storedHighlights).forEach((p) => {
      allHighlights.push(...storedHighlights[p]);
    });
    vscode.postMessage({
      command: 'saveHighlights',
      highlights: allHighlights,
      notify: notify,
    });
  }

  // Toolbar Tool Buttons
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;

      document.body.classList.remove('eraser-mode');
      if (currentTool === 'eraser') {
        document.body.classList.add('eraser-mode');
      }
    });
  });

  // Color Selector Dots
  document.querySelectorAll('.color-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      currentColor = dot.dataset.color;

      // Switch to highlight tool automatically if in select mode
      if (currentTool === 'select') {
        document.querySelector('[data-tool="highlight"]').click();
      }
    });
  });

  // Zoom Controls
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    pdfScale = Math.min(pdfScale + 0.25, 3.0);
    updateZoom();
  });

  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    pdfScale = Math.max(pdfScale - 0.25, 0.5);
    updateZoom();
  });

  zoomSelect.addEventListener('change', () => {
    const val = zoomSelect.value;
    if (val === 'auto' || val === 'page-fit' || val === 'page-width') {
      pdfScale = 1.0;
    } else {
      pdfScale = parseFloat(val);
    }
    updateZoom();
  });

  async function updateZoom() {
    if (!pdfDoc) return;
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      await renderPage(pageNum);
    }
  }

  // Page Navigation Controls
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (currentPage > 1) {
      jumpToPage(currentPage - 1);
    }
  });

  document.getElementById('btn-next').addEventListener('click', () => {
    if (pdfDoc && currentPage < pdfDoc.numPages) {
      jumpToPage(currentPage + 1);
    }
  });

  pageNumInput.addEventListener('change', () => {
    const val = parseInt(pageNumInput.value);
    if (!isNaN(val) && val >= 1 && val <= (pdfDoc ? pdfDoc.numPages : 1)) {
      jumpToPage(val);
    }
  });

  function jumpToPage(pageNum) {
    const el = document.getElementById(`page-wrapper-${pageNum}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
      currentPage = pageNum;
      pageNumInput.value = pageNum;
    }
  }

  // IntersectionObserver to update current page indicator on scroll
  function setupIntersectionObserver() {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const pageNum = parseInt(entry.target.dataset.pageNum);
            currentPage = pageNum;
            pageNumInput.value = pageNum;
          }
        });
      },
      { threshold: 0.5 }
    );

    document.querySelectorAll('.page-wrapper').forEach((el) => observer.observe(el));
  }

  // Theme Toggle
  document.getElementById('btn-theme').addEventListener('click', () => {
    document.body.classList.toggle('theme-dark');
  });

  // Manual Save Button
  document.getElementById('btn-save').addEventListener('click', () => {
    saveHighlights(true);
  });

  // Search Functionality
  const searchToggleBtn = document.getElementById('btn-search-toggle');
  const searchCloseBtn = document.getElementById('btn-search-close');
  const searchPrevBtn = document.getElementById('btn-search-prev');
  const searchNextBtn = document.getElementById('btn-search-next');

  searchToggleBtn.addEventListener('click', () => {
    searchBar.classList.toggle('hidden');
    if (!searchBar.classList.contains('hidden')) {
      searchInput.focus();
    }
  });

  searchCloseBtn.addEventListener('click', () => {
    searchBar.classList.add('hidden');
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      searchBar.classList.remove('hidden');
      searchInput.focus();
    }
  });

  searchInput.addEventListener('input', async () => {
    const query = searchInput.value.trim().toLowerCase();
    searchMatches = [];
    currentMatchIndex = -1;

    if (!query || !pdfDoc) {
      searchCountEl.innerText = '0 / 0';
      return;
    }

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item) => item.str).join(' ').toLowerCase();

      if (pageText.includes(query)) {
        searchMatches.push({ pageNum, query });
      }
    }

    searchCountEl.innerText = searchMatches.length > 0 ? `1 / ${searchMatches.length}` : '0 / 0';
    if (searchMatches.length > 0) {
      currentMatchIndex = 0;
      jumpToPage(searchMatches[0].pageNum);
    }
  });

  searchNextBtn.addEventListener('click', () => {
    if (searchMatches.length === 0) return;
    currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
    searchCountEl.innerText = `${currentMatchIndex + 1} / ${searchMatches.length}`;
    jumpToPage(searchMatches[currentMatchIndex].pageNum);
  });

  searchPrevBtn.addEventListener('click', () => {
    if (searchMatches.length === 0) return;
    currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
    searchCountEl.innerText = `${currentMatchIndex + 1} / ${searchMatches.length}`;
    jumpToPage(searchMatches[currentMatchIndex].pageNum);
  });
})();
