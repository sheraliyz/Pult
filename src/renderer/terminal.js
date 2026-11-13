// One remote shell rendered with xterm.js.

import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebglAddon } from '../../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';
import { SearchAddon } from '../../node_modules/@xterm/addon-search/lib/addon-search.mjs';
import { Unicode11Addon } from '../../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs';
import { WebLinksAddon } from '../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';
import { call, send, pathForFile } from './api.js';
import { h, icon, posix } from './dom.js';
import { toast, busy } from './ui.js';
import { pathArg } from './agents.js';

const THEMES = {
  dark: {
    background: '#0b0b0c',
    foreground: '#e4e4e7',
    cursor: '#e4e4e7',
    cursorAccent: '#0b0b0c',
    selectionBackground: 'rgba(255,255,255,0.17)',
    selectionInactiveBackground: 'rgba(255,255,255,0.09)',
    scrollbarSliderBackground: 'rgba(255,255,255,0.08)',
    scrollbarSliderHoverBackground: 'rgba(255,255,255,0.16)',
    scrollbarSliderActiveBackground: 'rgba(255,255,255,0.22)',
    black: '#27272a',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#d4d4d8',
    brightBlack: '#63636b',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#fafafa',
  },
  light: {
    background: '#ffffff',
    foreground: '#18181b',
    cursor: '#18181b',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(0,0,0,0.13)',
    selectionInactiveBackground: 'rgba(0,0,0,0.07)',
    scrollbarSliderBackground: 'rgba(0,0,0,0.08)',
    scrollbarSliderHoverBackground: 'rgba(0,0,0,0.16)',
    scrollbarSliderActiveBackground: 'rgba(0,0,0,0.22)',
    black: '#18181b',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#a16207',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0e7490',
    white: '#71717a',
    brightBlack: '#52525b',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#ca8a04',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#0891b2',
    brightWhite: '#a1a1aa',
  },
};

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => (darkQuery.matches ? THEMES.dark : THEMES.light);

const SEARCH_DECORATIONS = {
  matchBackground: '#facc1555',
  matchOverviewRuler: '#facc15',
  activeMatchBackground: '#facc15',
  activeMatchColorOverviewRuler: '#facc15',
};

export class TermView {
  constructor(session, id, settings) {
    this.session = session;
    this.id = id;
    this.settings = settings;
    this.attach = null;
    this.persistent = false;
    this.exited = false;
    this.opened = false;
    this.pendingAck = 0;
    this.ackTimer = null;
    this.title = '';
    this.attention = false; // rang its bell while you were elsewhere
    this.notifiedAt = 0;

    this.host = h('div', { class: 'term-host' });
    this.surface = h('div', { class: 'term-surface' });
    this.host.append(this.surface);

    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: settings.fontSize,
      fontWeight: 400,
      fontWeightBold: 700,
      lineHeight: 1.22,
      letterSpacing: 0,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      cursorInactiveStyle: 'outline',
      cursorWidth: 2,
      scrollback: settings.scrollback,
      allowProposedApi: true,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: darkQuery.matches ? 1 : 4.5,
      rightClickSelectsWord: false,
      smoothScrollDuration: 0,
      theme: currentTheme(),
    });

    this.fit = new FitAddon();
    this.search = new SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey) call('open:external', uri);
        else toast('Havolani ochish uchun Ctrl + bosing');
      }),
    );

    this.term.onData((d) => this.write(d));
    this.term.onBinary((d) => this.write(d, true));
    this.term.onResize(({ cols, rows }) => send('shell:resize', this.session.id, this.id, cols, rows));
    this.term.onTitleChange((t) => {
      this.title = t;
      this.session.renderShellTabs();
    });
    this.term.onSelectionChange(() => {
      if (this.settings.copyOnSelect && this.term.hasSelection()) call('clip:write', this.term.getSelection());
    });
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    // OSC 52: programs (tmux, vim, Claude Code…) put text on the Windows clipboard.
    this.term.parser.registerOscHandler(52, (data) => this.onOsc52(data));
    // Claude Code (and others) ring the bell when done or waiting for you.
    this.term.onBell(() => this.session.onBell(this));

    this.surface.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.term.hasSelection()) {
        call('clip:write', this.term.getSelection());
        this.term.clearSelection();
        toast('Nusxalandi', 'ok', 1200);
      } else {
        this.paste();
      }
    });
    // Capture phase: decide before xterm's own paste handler (text only).
    this.surface.addEventListener('paste', (e) => this.onPasteEvent(e), true);

    this.buildSearch();
    this.buildExitOverlay();
    this.buildDrop();
  }

  /* ---------------- lifecycle ---------------- */

  // Must be called while the host is visible so xterm can measure the font.
  open() {
    if (this.opened) return;
    this.opened = true;
    this.term.open(this.surface);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      // DOM renderer fallback is fine.
    }
    this.fitNow();
  }

  async start(attach) {
    this.open();
    const { cols, rows } = this.term;
    const r = await call('shell:open', this.session.id, this.id, { cols, rows, attach });
    this.persistent = r.persistent;
    this.attach = r.session;
  }

  fitNow() {
    if (!this.opened || !this.host.isConnected || this.host.offsetParent === null) return;
    try {
      this.fit.fit();
    } catch {
      // Host not measurable yet.
    }
  }

  focus() {
    if (this.opened) this.term.focus();
  }

  dispose() {
    clearTimeout(this.ackTimer);
    this.term.dispose();
    this.host.remove();
  }

  /* ---------------- data ---------------- */

  write(data, binary = false) {
    if (this.exited) return;
    if (this.session.state.state !== 'ready') return;
    send('shell:write', this.session.id, this.id, data, binary);
  }

  receive(data) {
    const n = data.length;
    this.term.write(data, () => this.ack(n));
  }

  // Tell main how much output xterm has digested (drives flow control).
  ack(n) {
    this.pendingAck += n;
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      send('shell:ack', this.session.id, this.id, this.pendingAck);
      this.pendingAck = 0;
      this.ackTimer = null;
    }, 8);
  }

  // Called for the first channel and again after every reconnect.
  onChannelOpen() {
    const afterDrop = this.channels > 0 && !this.reopening;
    this.channels = (this.channels || 0) + 1;
    this.reopening = false;
    this.exited = false;
    this.exitOverlay.hidden = true;
    if (afterDrop && !this.persistent) {
      this.term.write('\r\n\x1b[2m── aloqa tiklandi · yangi sessiya ──\x1b[0m\r\n');
    }
  }

  onExit() {
    this.exited = true;
    this.exitOverlay.hidden = false;
  }

  async reopen() {
    this.reopening = true;
    this.exitOverlay.hidden = true;
    this.term.write('\r\n');
    await call('shell:reopen', this.session.id, this.id).catch((e) => toast(e.message, 'err'));
  }

  /* ---------------- clipboard & keys ---------------- */

  async paste() {
    const text = await call('clip:read');
    if (text) this.term.paste(text);
    else if (await call('clip:hasImage').catch(() => false)) await this.pasteImage();
    this.term.focus();
  }

  // Ctrl+V with a screenshot or copied files instead of text: the program on
  // the server cannot see this computer's clipboard, so send them over and
  // type their paths (Claude Code and agy attach images given by path).
  onPasteEvent(e) {
    const dt = e.clipboardData;
    if (!dt || dt.getData('text/plain')) return;
    const paths = [...(dt.files || [])].map((f) => pathForFile(f)).filter(Boolean);
    const image = [...(dt.items || [])].some((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!paths.length && !image) return;
    e.preventDefault();
    e.stopPropagation();
    if (paths.length) this.sendFiles(paths);
    else this.pasteImage();
  }

  async pasteImage() {
    if (this.exited || this.session.state.state !== 'ready') return;
    const done = busy('Rasm serverga yuborilmoqda…');
    try {
      const remote = await call('term:pasteImage', this.session.id);
      if (!remote) return;
      this.term.paste(`${pathArg(remote)} `);
      toast(`Rasm serverda: ${remote}`, 'ok', 2500);
    } catch (err) {
      toast(`Rasmni yuborib bo‘lmadi: ${err.message}`, 'err', 5000);
    } finally {
      done();
      this.term.focus();
    }
  }

  /** Upload local files to ~/.pult/uploads/<time>/ and type their remote paths. */
  async sendFiles(paths) {
    if (!paths.length || this.exited || this.session.state.state !== 'ready') return;
    try {
      const dir = await call('term:uploadDir', this.session.id);
      const jobId = await call('xfer:upload', this.session.id, paths, dir, { quiet: true });
      const remote = paths.map((p) => posix.join(dir, p.split(/[\\/]/).pop()));
      this.session.app.whenUploaded(jobId, () => {
        if (this.exited) return;
        this.term.paste(`${remote.map(pathArg).join(' ')} `);
        toast(remote.length === 1 ? `Serverga yuklandi: ${remote[0]}` : `${remote.length} ta fayl serverga yuklandi`, 'ok', 2500);
        this.term.focus();
      });
    } catch (err) {
      toast(err.message, 'err', 5000);
    }
  }

  // "52;c;<base64>" — write only. Reading ("?") is refused: a remote program
  // must never be able to see what is on this computer's clipboard.
  onOsc52(data) {
    const i = data.indexOf(';');
    const payload = i >= 0 ? data.slice(i + 1) : '';
    if (!payload || payload === '?' || payload.length > 4 * 1024 * 1024) return true;
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      if (text) {
        call('clip:write', text);
        toast('Nusxalandi', 'ok', 1200);
      }
    } catch {
      // Malformed base64: ignore.
    }
    return true;
  }

  copy() {
    if (!this.term.hasSelection()) return false;
    call('clip:write', this.term.getSelection());
    this.term.clearSelection();
    return true;
  }

  onKey(e) {
    if (e.type !== 'keydown') return true;
    // Shift+Enter: a new line in Claude Code / agy (they read LF, i.e. Ctrl+J,
    // as "newline"); shells treat LF like Enter, so nothing else changes.
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && this.settings.shiftEnterNewline !== false) {
      e.preventDefault();
      this.write('\n');
      return false;
    }
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    if (ctrl && e.shiftKey && e.code === 'KeyC') {
      e.preventDefault();
      this.copy();
      return false;
    }
    if (ctrl && e.shiftKey && e.code === 'KeyV') {
      e.preventDefault();
      this.paste();
      return false;
    }
    // Windows-style: Ctrl+C copies only when there is a selection.
    if (ctrl && !e.shiftKey && e.code === 'KeyC' && this.term.hasSelection()) {
      e.preventDefault();
      this.copy();
      return false;
    }
    // Ctrl+V: let the browser deliver a native paste event to xterm.
    if (ctrl && !e.shiftKey && e.code === 'KeyV') return false;
    if (ctrl && e.shiftKey && e.code === 'KeyF') {
      e.preventDefault();
      this.openSearch();
      return false;
    }
    return true;
  }

  /* ---------------- search ---------------- */

  buildSearch() {
    this.searchInput = h('input', { class: 'ts-input', placeholder: 'Qidirish', spellcheck: 'false' });
    this.searchCount = h('span', { class: 'ts-count' });
    const opts = () => ({ decorations: SEARCH_DECORATIONS, incremental: false });
    const next = () => this.search.findNext(this.searchInput.value, opts());
    const prev = () => this.search.findPrevious(this.searchInput.value, opts());
    this.searchInput.addEventListener('input', () => this.search.findNext(this.searchInput.value, { ...opts(), incremental: true }));
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.shiftKey ? prev() : next();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeSearch();
      }
    });
    this.search.onDidChangeResults?.(({ resultIndex, resultCount }) => {
      this.searchCount.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : this.searchInput.value ? '0' : '';
    });
    this.searchBox = h(
      'div',
      { class: 'term-search', hidden: true },
      icon('search', 14),
      this.searchInput,
      this.searchCount,
      h('button', { class: 'icon-btn sm', type: 'button', 'data-tip': 'Oldingi (Shift+Enter)', onclick: prev }, icon('arrowUp', 14)),
      h('button', { class: 'icon-btn sm', type: 'button', 'data-tip': 'Keyingi (Enter)', onclick: next }, icon('arrowDown', 14)),
      h('button', { class: 'icon-btn sm', type: 'button', 'data-tip': 'Yopish (Esc)', onclick: () => this.closeSearch() }, icon('x', 14)),
    );
    this.host.append(this.searchBox);
  }

  openSearch() {
    this.searchBox.hidden = false;
    const sel = this.term.getSelection();
    if (sel && !sel.includes('\n')) this.searchInput.value = sel;
    this.searchInput.focus();
    this.searchInput.select();
  }

  closeSearch() {
    this.searchBox.hidden = true;
    this.search.clearDecorations();
    this.term.focus();
  }

  /* ---------------- drop files on the terminal ---------------- */

  buildDrop() {
    const hint = h('div', { class: 'term-drop' }, h('div', { class: 'f-drop-card' }, icon('upload', 22), h('div', { class: 'f-drop-text' }, 'Serverga yuklash va yo‘lini yozish')));
    this.host.append(hint);
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    let depth = 0;
    this.host.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      this.host.classList.add('dropping');
    });
    this.host.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    this.host.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) this.host.classList.remove('dropping');
    });
    this.host.addEventListener('drop', (e) => {
      depth = 0;
      this.host.classList.remove('dropping');
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      this.sendFiles([...e.dataTransfer.files].map((f) => pathForFile(f)).filter(Boolean));
    });
  }

  /* ---------------- exit overlay ---------------- */

  buildExitOverlay() {
    this.exitOverlay = h(
      'div',
      { class: 'term-exit', hidden: true },
      h('div', { class: 'te-card' },
        h('div', { class: 'te-title' }, 'Sessiya yakunlandi'),
        h('div', { class: 'te-actions' },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => this.reopen() }, icon('refresh', 15), 'Qayta ochish'),
          h('button', { class: 'btn', type: 'button', onclick: () => this.session.closeShell(this) }, 'Yopish'),
        ),
      ),
    );
    this.host.append(this.exitOverlay);
  }

  /* ---------------- settings ---------------- */

  applySettings(s) {
    this.settings = s;
    const o = this.term.options;
    o.fontSize = s.fontSize;
    o.cursorStyle = s.cursorStyle;
    o.cursorBlink = s.cursorBlink;
    o.scrollback = s.scrollback;
    this.fitNow();
  }

  applyTheme() {
    this.term.options.theme = currentTheme();
    this.term.options.minimumContrastRatio = darkQuery.matches ? 1 : 4.5;
  }
}

export function onThemeChange(fn) {
  darkQuery.addEventListener('change', fn);
}
