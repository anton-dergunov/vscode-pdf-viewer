// Drives the Extension Development Host started by launch.sh, over the Chrome DevTools Protocol.
// No dependencies: Node 22+ (global WebSocket and fetch).
//
//   node drive.mjs <command> [args]      one command per run; prints JSON or a short line
//
// The viewer runs in a webview, which is an out-of-process iframe: it is reached through its own
// CDP target, and its document is the `#active-frame` iframe inside that target's page.
import { writeFileSync } from 'node:fs';

const PORT = process.env.PDFV_PORT || 9333;
const SHOTS = `${process.env.PDFV_DIR || '/tmp/pdfv'}/shots`;
const [cmd, ...args] = process.argv.slice(2);

async function connect(match) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = targets.find(match);
  if (!target) throw new Error('target not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    pending.get(msg.id)?.(msg);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const workbench = () => connect((t) => t.type === 'page' && t.url.includes('workbench'));
const webview = () => connect((t) => t.type === 'iframe' && t.url.startsWith('vscode-webview://'));

/** Runs `body` in the viewer with `d` (its document), `w` (its window) and `arg` in scope. */
async function inViewer(body, arg = null) {
  const v = await webview();
  try {
    return await v.evaluate(`(async () => {
      const f = document.getElementById('active-frame');
      const d = f.contentDocument, w = f.contentWindow, arg = ${JSON.stringify(arg)};
      ${body}
    })()`);
  } finally {
    v.close();
  }
}

/** Runs `body` in the VS Code workbench page. */
async function inWorkbench(body) {
  const p = await workbench();
  try {
    return await p.evaluate(`(async () => { ${body} })()`);
  } finally {
    p.close();
  }
}

/** An element of the viewer, scrolled into view, as a box in workbench page coordinates. */
async function boxOf(selector, index = 0) {
  const o = await inWorkbench(`
    const f = [...document.querySelectorAll('iframe')].find((i) => (i.src || '').startsWith('vscode-webview://') && i.offsetParent);
    const r = f.getBoundingClientRect(); return { x: r.x, y: r.y };`);
  const b = await inViewer(
    `const e = d.querySelectorAll(arg.selector)[arg.index];
     if (!e) return null;
     e.scrollIntoView({ block: 'center' });
     await new Promise((r) => setTimeout(r, 300));
     const b = e.getBoundingClientRect();
     return { x: b.x, y: b.y, width: b.width, height: b.height, text: e.textContent };`,
    { selector, index },
  );
  if (!b) throw new Error(`not found: ${selector} #${index}`);
  return { ...b, x: b.x + o.x, y: b.y + o.y };
}

async function mouse(events) {
  const p = await workbench();
  try {
    for (const [type, x, y] of events) {
      await p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
  } finally {
    p.close();
  }
}

// Innermost spans: a span under a highlight loses its role="presentation", and marked content wraps
// spans in others.
const spansOf = (page) => `.page[data-page-number="${page}"] .textLayer span:not(:has(span))`;

/** pdf.js builds a page's text layer only once the page has been on screen. */
async function ensurePage(page) {
  await inViewer(
    `const ready = () => d.querySelector('.page[data-page-number="' + arg + '"] .textLayer span');
     if (ready()) return;
     const i = d.getElementById('page-number'); i.value = arg; i.dispatchEvent(new Event('change'));
     for (let t = 0; t < 30 && !ready(); t++) await new Promise((r) => setTimeout(r, 100));`,
    String(page),
  );
}

const commands = {
  /** Exits 0 once the viewer has loaded a PDF (launch.sh polls this). */
  async ready() {
    const ok = await inViewer(`return !!d.querySelector('.page') && d.getElementById('loading').hidden;`);
    if (!ok) throw new Error('not ready');
    console.log('ready');
  },

  /** The viewer's notice, toolbar, page and highlights, and VS Code's tabs, dialog and toasts. */
  async state() {
    const viewer = await inViewer(`
      const n = d.getElementById('notice');
      return {
        notice: n.hidden ? null : n.querySelector('.notice-text').innerText,
        noticeButtons: n.hidden ? [] : [...n.querySelectorAll('.notice-action')].filter((b) => !b.hidden).map((b) => b.textContent),
        noticeTop: Math.round(n.getBoundingClientRect().top),
        toolbarShown: d.getElementById('toolbar').classList.contains('visible'),
        findbarTop: d.getElementById('findbar').hidden ? null : Math.round(d.getElementById('findbar').getBoundingClientRect().top),
        saveEnabled: !d.getElementById('save').disabled,
        tool: d.body.dataset.tool,
        page: Number(d.getElementById('page-number').value),
        pages: Number(d.getElementById('page-count').textContent),
        scrollTop: Math.round(d.getElementById('viewer-container').scrollTop),
        highlightsShown: d.querySelectorAll('.highlightEditor, .highlightAnnotation:not([hidden])').length,
      };`);
    const vscode = await inWorkbench(`return {
      tabs: [...document.querySelectorAll('.tabs-container .tab')].map((t) => t.getAttribute('aria-label') + (t.classList.contains('dirty') ? ' [unsaved]' : '')),
      dialog: document.querySelector('.monaco-dialog-box')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
      notifications: [...document.querySelectorAll('.notification-list-item-message')].map((e) => e.innerText),
    };`);
    console.log(JSON.stringify({ ...viewer, ...vscode }, null, 1));
  },

  /** ss <name>: screenshot of the whole VS Code window. */
  async ss(name = `shot-${Date.now()}`) {
    const p = await workbench();
    try {
      const { data } = await p.send('Page.captureScreenshot', { format: 'png' });
      const file = `${SHOTS}/${name}.png`;
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(file);
    } finally {
      p.close();
    }
  },

  /** goto <page> */
  async goto(page) {
    await inViewer(`const i = d.getElementById('page-number'); i.value = arg; i.dispatchEvent(new Event('change'));`, page);
    await new Promise((r) => setTimeout(r, 500));
    console.log('page', page);
  },

  /** tool <select|highlight|eraser> */
  async tool(name) {
    await inViewer(`d.querySelector('.tool[data-tool="' + arg + '"]').click();`, name);
    console.log('tool', name);
  },

  /** spans <page> [regex]: text spans with their indices, for `select`. */
  async spans(page, pattern = '\\S') {
    await ensurePage(page);
    const list = await inViewer(
      `return [...d.querySelectorAll(arg.sel)].map((s, i) => [i, s.textContent]).filter(([, t]) => new RegExp(arg.pattern).test(t));`,
      { sel: spansOf(page), pattern },
    );
    for (const [i, t] of list) console.log(i, t);
  },

  /** select <page> <from> [to]: drags across text spans (with the highlight tool, makes a highlight). */
  async select(page, from, to = from) {
    await ensurePage(page);
    const a = await boxOf(spansOf(page), Number(from));
    const b = await boxOf(spansOf(page), Number(to));
    const y = (box) => box.y + box.height / 2;
    await mouse([
      ['mouseMoved', a.x + 1, y(a)],
      ['mousePressed', a.x + 1, y(a)],
      ['mouseMoved', (a.x + b.x + b.width) / 2, y(b)],
      ['mouseMoved', b.x + b.width - 1, y(b)],
      ['mouseReleased', b.x + b.width - 1, y(b)],
    ]);
    await new Promise((r) => setTimeout(r, 500));
    console.log('selected', JSON.stringify(a.text), '…', JSON.stringify(b.text));
  },

  /** click-highlight <page> [n]: clicks a highlight (with the eraser tool, removes it). */
  async 'click-highlight'(page, n = 0) {
    await ensurePage(page);
    const h = await boxOf(`.page[data-page-number="${page}"] .highlightEditor`, Number(n));
    const x = h.x + h.width / 2, y = h.y + h.height / 2;
    await mouse([['mouseMoved', x, y], ['mousePressed', x, y], ['mouseReleased', x, y]]);
    await new Promise((r) => setTimeout(r, 500));
    console.log('clicked highlight on page', page);
  },

  /** click <css selector>: DOM click in the viewer, e.g. #save, #notice-reload, #find-toggle. */
  async click(selector) {
    console.log(await inViewer(`const e = d.querySelector(arg); if (!e) return 'NOT FOUND'; e.click(); return 'clicked ' + arg;`, selector));
  },

  /** toolbar <show|hide>: the toolbar shows while the pointer is near the top edge. */
  async toolbar(what = 'show') {
    await inViewer(`d.dispatchEvent(new PointerEvent('pointermove', { clientY: arg === 'hide' ? 400 : 5, bubbles: true }));`, what);
    await new Promise((r) => setTimeout(r, 700));
    console.log('toolbar', what);
  },

  /** key <combo>: e.g. Meta+z, Meta+Shift+z, Meta+s, Escape. Goes to the focused element. */
  async key(combo) {
    const parts = combo.split('+');
    const key = parts.pop();
    const bits = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };
    const modifiers = parts.reduce((m, p) => m | (bits[p] ?? 0), 0);
    const single = key.length === 1;
    const code = single ? `Key${key.toUpperCase()}` : key;
    const vk = single ? key.toUpperCase().charCodeAt(0) : { Escape: 27, Enter: 13, Tab: 9 }[key];
    const p = await workbench();
    try {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await p.send('Input.dispatchKeyEvent', { type, modifiers, key, code, windowsVirtualKeyCode: vk });
      }
    } finally {
      p.close();
    }
    await new Promise((r) => setTimeout(r, 300));
    console.log('pressed', combo);
  },

  /** eval <js>: runs in the viewer with d, w in scope; `return` a value. */
  async eval(...js) {
    console.log(JSON.stringify(await inViewer(js.join(' '))));
  },

  /** wb-eval <js>: runs in the VS Code workbench page; `return` a value. */
  async 'wb-eval'(...js) {
    console.log(JSON.stringify(await inWorkbench(js.join(' '))));
  },

  /** dialog <label>: clicks a button of VS Code's dialog (custom dialog style, set by launch.sh). */
  async dialog(...label) {
    const text = label.join(' ');
    console.log(await inWorkbench(`
      const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find((e) => e.textContent.trim() === ${JSON.stringify(text)});
      if (!b) return 'NOT FOUND'; b.click(); return 'clicked';`));
  },
};

if (!commands[cmd]) {
  console.log('commands:', Object.keys(commands).join(', '));
  process.exit(cmd ? 2 : 0);
}
try {
  await commands[cmd](...args);
  process.exit(0);
} catch (error) {
  console.error('ERROR:', error.message);
  process.exit(1);
}
