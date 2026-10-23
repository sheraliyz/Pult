// A connected server: terminal tabs + file browser, sharing one SSH link.

import { call } from './api.js';
import { h, icon, clear, shellQuote } from './dom.js';
import { menu, toast } from './ui.js';
import { TermView } from './terminal.js';
import { FilesView } from './files.js';
import { describeError } from './errors.js';

let seq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

export class Session {
  constructor(app, server) {
    this.app = app;
    this.server = server;
    this.id = uid('c');
    this.state = { state: 'connecting' };
    this.stats = null;
    this.shells = [];
    this.active = null;
    this.mode = app.layout.mode || 'terminal';
    this.split = app.layout.split || 0.42;
    this.files = null;
    this.editor = null;
    this.everReady = false;
    this.dropped = false;
    this.build();
  }

  /* ---------------- DOM ---------------- */

  build() {
    const modeBtn = (mode, ic, label, tip) =>
      h('button', { class: 'seg-btn', type: 'button', dataset: { mode }, 'data-tip': tip, onclick: () => this.setMode(mode) }, icon(ic, 15), label);
    this.modeSeg = h(
      'div',
      { class: 'mode-seg' },
      modeBtn('terminal', 'terminal', 'Terminal', 'Ctrl+Shift+1'),
      modeBtn('files', 'folder', 'Fayllar', 'Ctrl+Shift+2'),
      modeBtn('split', 'split', null, 'Yonma-yon · Ctrl+Shift+3'),
    );
    this.shellTabs = h('div', { class: 'shell-tabs' });
    this.toolbar = h(
      'div',
      { class: 's-toolbar' },
      this.modeSeg,
      h('div', { class: 'tb-divider' }),
      this.shellTabs,
      h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', type: 'button', 'data-tip': 'Terminalda qidirish · Ctrl+Shift+F', onclick: () => this.active?.openSearch() }, icon('search', 16)),
      h('button', { class: 'icon-btn', type: 'button', 'data-tip': 'Server sozlamalari', onclick: () => this.app.editServer(this.server) }, icon('sliders', 16)),
      h('button', { class: 'icon-btn', type: 'button', 'data-tip': 'Ulanishni yopish', onclick: () => this.app.closeSession(this) }, icon('power', 16)),
    );

    this.termPane = h('div', { class: 'pane pane-term' });
    this.filesPane = h('div', { class: 'pane pane-files' });
    this.splitter = h('div', { class: 'splitter' });
    this.setupSplitter();
    this.body = h('div', { class: 's-body' }, this.filesPane, this.splitter, this.termPane);

    this.banner = h('div', { class: 's-banner', hidden: true });
    this.curtain = h('div', { class: 's-curtain' });

    this.el = h('section', { class: 'view session' }, this.toolbar, this.body, this.banner, this.curtain);

    this.tab = h(
      'div',
      { class: 'tab', role: 'tab', tabindex: '0', onclick: () => this.app.activate(this.id) },
      h('span', { class: 'tab-dot' }),
      h('span', { class: 'tab-label' }, this.server.name),
      h('button', {
        class: 'tab-close',
        type: 'button',
        'aria-label': 'Yopish',
        onclick: (e) => {
          e.stopPropagation();
          this.app.closeSession(this);
        },
      }, icon('x', 13)),
    );
    this.tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) this.app.closeSession(this);
    });

    // Every shell tracks the pane size, visible or not, so switching is instant.
    let pending = false;
    new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (!this.body.classList.contains('resizing')) for (const s of this.shells) s.fitNow();
      });
    }).observe(this.termPane);

    this.applyMode();
    this.renderCurtain();
  }

  setupSplitter() {
    this.splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.splitter.setPointerCapture(e.pointerId);
      const rect = this.body.getBoundingClientRect();
      this.body.classList.add('resizing');
      const move = (ev) => {
        this.split = Math.max(0.2, Math.min(0.75, (ev.clientX - rect.left) / rect.width));
        this.body.style.setProperty('--split', `${this.split * 100}%`);
      };
      const up = () => {
        this.splitter.removeEventListener('pointermove', move);
        this.body.classList.remove('resizing');
        this.app.saveLayout({ split: this.split });
        this.fitActive();
      };
      this.splitter.addEventListener('pointermove', move);
      this.splitter.addEventListener('pointerup', up, { once: true });
    });
    this.splitter.addEventListener('dblclick', () => {
      this.split = 0.42;
      this.body.style.setProperty('--split', '42%');
      this.fitActive();
    });
  }

  /* ---------------- connection ---------------- */

  async start() {
    try {
      await call('conn:open', this.id, this.server.id);
    } catch (err) {
      this.onState({ state: 'failed', error: { message: err.message } });
    }
  }

  onState(s) {
    const prev = this.state.state;
    this.state = { ...this.state, ...s };
    this.tab.dataset.state = s.state;

    if (s.state === 'ready') {
      const first = !this.everReady;
      this.everReady = true;
      if (first) this.onFirstReady();
      else if (prev !== 'ready') {
        this.files?.refresh();
      }
      this.dropped = false;
    } else if (s.state === 'reconnecting' && prev === 'ready') {
      this.dropped = true;
    }

    clearInterval(this.countdown);
    if (s.state === 'reconnecting') this.countdown = setInterval(() => this.renderBanner(), 500);

    this.el.dataset.state = s.state;
    this.renderBanner();
    this.renderCurtain();
    this.app.renderStatus();
  }

  async onFirstReady() {
    // Re-attach every tmux session left from last time: work continues 1:1.
    const sessions = this.state.persist && this.state.hasTmux ? this.state.sessions || [] : [];
    if (sessions.length) {
      for (const name of sessions) await this.addShell(name, false);
    } else {
      await this.addShell(null, false);
    }
    this.select(this.shells[0]);
    if (this.mode !== 'terminal') this.ensureFiles();
    if (this.state.persist && !this.state.hasTmux) {
      toast('Serverda tmux topilmadi — aloqa uzilsa terminal sessiyasi qayta boshlanadi', 'info', 5000);
    }
  }

  retry() {
    call('conn:retry', this.id).catch(() => {});
  }

  renderBanner() {
    const s = this.state;
    if (s.state !== 'reconnecting' || !this.everReady) {
      this.banner.hidden = true;
      return;
    }
    const secs = Math.max(0, Math.ceil((s.retryAt - Date.now()) / 1000));
    const text = s.retryAt && secs > 0 ? `Aloqa uzildi · ${secs} soniyadan so‘ng qayta ulanadi` : 'Aloqa uzildi · qayta ulanmoqda…';
    clear(
      this.banner,
      h('span', { class: 'spinner' }),
      h('span', null, text),
      s.retryAt && secs > 0 && h('button', { class: 'link-btn', type: 'button', onclick: () => this.retry() }, 'Hozir ulash'),
    );
    this.banner.hidden = false;
  }

  renderCurtain() {
    const s = this.state;
    const show = !this.everReady || s.state === 'failed';
    this.curtain.hidden = !show;
    if (!show) return;
    const { username, host, port } = this.server;
    const addr = `${username}@${host}${port && port !== 22 ? `:${port}` : ''}`;
    if (s.state === 'failed') {
      const info = describeError(s.error);
      clear(
        this.curtain,
        h(
          'div',
          { class: 'curtain-card' },
          h('div', { class: 'curtain-ic tone-danger' }, icon('alert', 20)),
          h('div', { class: 'curtain-title' }, info.title),
          h('div', { class: 'curtain-text' }, info.text),
          h('div', { class: 'curtain-addr mono' }, addr),
          h(
            'div',
            { class: 'curtain-actions' },
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => this.retry() }, icon('refresh', 15), 'Qayta urinish'),
            h('button', { class: 'btn', type: 'button', onclick: () => this.app.editServer(this.server) }, 'Sozlamalar'),
            h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => this.app.closeSession(this) }, 'Yopish'),
          ),
        ),
      );
    } else {
      const label = s.state === 'reconnecting' ? 'Qayta ulanmoqda' : 'Ulanmoqda';
      clear(
        this.curtain,
        h(
          'div',
          { class: 'curtain-card' },
          h('div', { class: 'curtain-spinner' }, h('span', { class: 'spinner lg' })),
          h('div', { class: 'curtain-title' }, `${label}…`),
          h('div', { class: 'curtain-addr mono' }, addr),
          h('div', { class: 'curtain-actions' }, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => this.app.closeSession(this) }, 'Bekor qilish')),
        ),
      );
    }
  }

  /* ---------------- modes ---------------- */

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.app.saveLayout({ mode });
    this.applyMode();
    if (mode !== 'terminal') this.ensureFiles();
    requestAnimationFrame(() => {
      this.fitActive();
      if (mode === 'files') this.files?.list.focus();
      else this.active?.focus();
    });
  }

  applyMode() {
    this.el.dataset.mode = this.mode;
    this.body.style.setProperty('--split', `${this.split * 100}%`);
    for (const b of this.modeSeg.children) b.classList.toggle('on', b.dataset.mode === this.mode);
    this.shellTabs.hidden = this.mode === 'files';
  }

  ensureFiles() {
    if (!this.files) {
      this.files = new FilesView(this);
      this.filesPane.append(this.files.el);
    }
    if (this.state.state === 'ready') this.files.init();
  }

  /* ---------------- shells ---------------- */

  async addShell(attach = null, focus = true) {
    if (this.state.state !== 'ready') {
      toast('Server bilan aloqa yo‘q', 'err');
      return null;
    }
    const view = new TermView(this, uid('s'), this.app.settings);
    this.shells.push(view);
    this.app.registerShell(view);
    this.termPane.append(view.host);
    this.renderShellTabs();
    // xterm needs a measurable element to compute rows/cols.
    const wasActive = this.active;
    this.showOnly(view);
    try {
      await view.start(attach);
    } catch (err) {
      toast(`Terminal ochilmadi: ${err.message}`, 'err');
      this.removeShell(view);
      return null;
    }
    if (focus) this.select(view);
    else if (wasActive) this.showOnly(wasActive);
    this.renderShellTabs();
    return view;
  }

  showOnly(view) {
    for (const s of this.shells) s.host.classList.toggle('on', s === view);
    view.open();
    view.fitNow();
  }

  select(view) {
    if (!view) return;
    this.active = view;
    this.showOnly(view);
    this.renderShellTabs();
    if (this.mode !== 'files') requestAnimationFrame(() => view.focus());
  }

  async closeShell(view) {
    if (!view) return;
    this.removeShell(view);
    await call('shell:close', this.id, view.id, { kill: true }).catch(() => {});
    if (!this.shells.length && this.state.state === 'ready') {
      if (this.mode === 'files') return;
      await this.addShell();
    }
  }

  removeShell(view) {
    const i = this.shells.indexOf(view);
    if (i < 0) return;
    this.shells.splice(i, 1);
    this.app.unregisterShell(view);
    view.dispose();
    if (this.active === view) {
      this.active = null;
      this.select(this.shells[Math.min(i, this.shells.length - 1)]);
    }
    this.renderShellTabs();
  }

  cycleShell(delta) {
    if (this.shells.length < 2) return;
    const i = this.shells.indexOf(this.active);
    this.select(this.shells[(i + delta + this.shells.length) % this.shells.length]);
  }

  renderShellTabs() {
    clear(this.shellTabs);
    this.shells.forEach((s, i) => {
      const pill = h(
        'div',
        {
          class: `shell-pill ${s === this.active ? 'on' : ''} ${s.exited ? 'exited' : ''}`,
          role: 'tab',
          'data-tip': s.title || `Terminal ${i + 1}${s.persistent ? ' · tmux' : ''}`,
          onclick: () => this.select(s),
        },
        h('span', { class: 'pill-num' }, String(i + 1)),
        h('button', {
          class: 'pill-close',
          type: 'button',
          'aria-label': 'Yopish',
          onclick: (e) => {
            e.stopPropagation();
            this.closeShell(s);
          },
        }, icon('x', 11)),
      );
      pill.addEventListener('auxclick', (e) => {
        if (e.button === 1) this.closeShell(s);
      });
      pill.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY, [
          { label: 'Yangi terminal', icon: 'plus', hint: 'Ctrl+Shift+T', onClick: () => this.addShell() },
          { label: 'Qidirish', icon: 'search', hint: 'Ctrl+Shift+F', onClick: () => (this.select(s), s.openSearch()) },
          { label: 'Ekranni tozalash', icon: 'refresh', onClick: () => s.term.clear() },
          '-',
          { label: 'Yopish', icon: 'x', hint: 'Ctrl+Shift+W', danger: true, onClick: () => this.closeShell(s) },
        ]);
      });
      this.shellTabs.append(pill);
    });
    this.shellTabs.append(
      h('button', { class: 'shell-add', type: 'button', 'data-tip': 'Yangi terminal · Ctrl+Shift+T', onclick: () => this.addShell() }, icon('plus', 14)),
    );
  }

  cdInTerminal(path) {
    if (this.mode === 'files') this.setMode('split');
    const view = this.active;
    if (!view) return;
    view.write(`cd -- ${shellQuote(path)}\r`);
    requestAnimationFrame(() => view.focus());
  }

  /* ---------------- misc ---------------- */

  fitActive() {
    for (const s of this.shells) s.fitNow();
  }

  focusActive() {
    if (this.editor) return;
    if (this.mode === 'files') this.files?.list.focus();
    else this.active?.focus();
  }

  onShow() {
    requestAnimationFrame(() => {
      this.fitActive();
      this.focusActive();
    });
  }

  onTransferDone(job) {
    this.files?.onTransferDone(job);
  }

  async close() {
    clearInterval(this.countdown);
    for (const s of this.shells) {
      this.app.unregisterShell(s);
      s.dispose();
    }
    this.shells = [];
    await call('conn:close', this.id).catch(() => {});
  }
}
