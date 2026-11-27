// A connected server: terminal tabs + file browser, sharing one SSH link.

import { call } from './api.js';
import { h, icon, clear, shellQuote, initials, fmt } from './dom.js';

const fmtBytes = (n) => fmt.bytes(n);
import { menu, toast, confirmDialog } from './ui.js';
import { TermView } from './terminal.js';
import { FilesView } from './files.js';
import { SystemView } from './system.js';
import { describeError } from './errors.js';
import { AGENTS, cleanTitle, agentMenuItems, agentCommand, openUsagePanel, closeUsagePanel, refreshUsagePanel } from './agents.js';
import { snippetMenuItems } from './snippets.js';

const STATE_LABEL = {
  connecting: 'Ulanmoqda…',
  ready: 'Ulangan',
  reconnecting: 'Qayta ulanmoqda…',
  failed: 'Ulanmadi',
  closed: 'Yopilgan',
};

// A terminal whose foreground program is one of these is just a prompt.
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'mksh', 'tcsh', 'csh', 'ash', 'login', 'tmux']);

/** Claude's Notification message in Uzbek: "Bash uchun ruxsat so‘rayapti", "javobingizni kutyapti". */
function waitText(ev) {
  const m = String(ev?.message || '');
  const tool = m.match(/permission to use (.+?)\.?$/i);
  if (tool) return `${tool[1]} uchun ruxsat so‘rayapti`;
  if (/permission/i.test(m) || ev?.kind === 'permission_prompt') return 'ruxsat so‘rayapti';
  if (/waiting for your input|idle/i.test(m) || ev?.kind === 'idle_prompt') return 'javobingizni kutyapti';
  return m ? m.slice(0, 120) : 'sizni kutyapti';
}

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
    this.agents = null; // AI agents on this server (see src/main/agents.js)
    this.build();
  }

  /* ---------------- DOM ---------------- */

  build() {
    // Top bar: which server, its state, the terminals and the actions. The
    // mode keys (terminal / files / split) live in the app's left rail.
    this.nameEl = h('div', { class: 's-name' });
    this.statusEl = h('div', { class: 's-status' });
    this.shellTabs = h('div', { class: 'shell-tabs', role: 'tablist', 'aria-label': 'Terminallar' });
    this.aiBtn = h(
      'button',
      { class: 'key key-ink shell-ai', type: 'button', hidden: true, 'data-tip': 'AI agent: Claude Code, agy · Ctrl+Shift+A', onclick: () => this.openAgentMenu() },
      icon('spark', 17),
      h('span', null, 'AI agent'),
      icon('chevronDown', 12),
    );
    this.cmdBtn = h(
      'button',
      { class: 'key key-gray shell-cmd', type: 'button', 'data-tip': 'Tez buyruqlar · Alt+1…9', onclick: () => this.openSnippets() },
      icon('bolt', 17),
      h('span', { class: 'key-label' }, 'Buyruqlar'),
      icon('chevronDown', 12),
    );
    this.searchBtn = h(
      'button',
      { class: 'key key-gray key-icon', type: 'button', 'data-tip': 'Terminalda qidirish · Ctrl+Shift+F', 'aria-label': 'Terminalda qidirish', onclick: () => this.active?.openSearch() },
      icon('search', 18),
    );
    this.toolbar = h(
      'div',
      { class: 's-toolbar' },
      h('div', { class: 's-title' }, this.nameEl, this.statusEl),
      h('div', { class: 'tb-divider' }),
      this.shellTabs,
      this.aiBtn,
      this.cmdBtn,
      h('div', { class: 'grow' }),
      h(
        'div',
        { class: 's-actions' },
        this.searchBtn,
        h('button', { class: 'key key-gray key-icon', type: 'button', 'data-tip': 'Server sozlamalari', 'aria-label': 'Server sozlamalari', onclick: () => this.app.editServer(this.server) }, icon('sliders', 18)),
        h('button', { class: 'key key-ink key-icon', type: 'button', 'data-tip': 'Ulanishni yopish', 'aria-label': 'Ulanishni yopish', onclick: () => this.app.closeSession(this) }, icon('power', 18)),
      ),
    );

    // The terminal sits in a black screen with a one-line header.
    this.termHead = h('div', { class: 'term-head' });
    this.termStack = h('div', { class: 'term-stack' });
    // Claude asks for permission in another terminal: answer from here.
    this.waitStack = h('div', { class: 'cl-wait-stack' });
    this.termPane = h('div', { class: 'pane pane-term' }, h('div', { class: 'term-screen' }, this.termHead, this.termStack, this.waitStack));
    this.filesPane = h('div', { class: 'pane pane-files' });
    this.sysPane = h('div', { class: 'pane pane-sys' });
    this.splitter = h('div', { class: 'splitter' });
    this.setupSplitter();
    this.body = h('div', { class: 's-body' }, this.filesPane, this.splitter, this.termPane, this.sysPane);

    this.banner = h('div', { class: 's-banner', hidden: true });
    this.curtain = h('div', { class: 's-curtain' });

    this.el = h('section', { class: 'view session' }, this.toolbar, this.body, this.banner, this.curtain);

    // Entry in the left rail.
    this.tabSub = h('span', { class: 'tab-sub mono' });
    this.tabCode = h('span', { class: 'tab-code', 'aria-hidden': 'true' });
    this.tab = h(
      'div',
      { class: 'tab', role: 'tab', tabindex: '0', onclick: () => this.app.activate(this.id) },
      h('span', { class: 'tab-dot' }),
      h('span', { class: 'tab-text' }, h('span', { class: 'tab-label' }, this.server.name), this.tabSub),
      this.tabCode,
      h('button', {
        class: 'tab-close',
        type: 'button',
        'aria-label': 'Ulanishni yopish',
        'data-tip': 'Ulanishni yopish',
        onclick: (e) => {
          e.stopPropagation();
          this.app.closeSession(this);
        },
      }, icon('x', 12)),
    );
    this.tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) this.app.closeSession(this);
    });
    this.tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.app.activate(this.id);
      }
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
    }).observe(this.termStack);

    this.applyMode();
    this.renderTitle();
    this.renderCurtain();
  }

  /** Server name, connection state and address in the top bar and the rail. */
  renderTitle() {
    const s = this.state;
    const { username, host, port } = this.server;
    const addr = `${username}@${host}${port && port !== 22 ? `:${port}` : ''}`;
    const label = STATE_LABEL[s.state] || s.state;
    this.nameEl.textContent = this.server.name;
    this.tabCode.textContent = initials(this.server.name);
    let tmux = null;
    if (s.state === 'ready') {
      if (this.active?.persistent) tmux = h('span', { 'data-tip': 'tmux: aloqa uzilsa ham sessiya saqlanadi' }, 'tmux saqlanadi');
      else if (s.persist && !s.hasTmux) tmux = h('span', { class: 'warn-text', 'data-tip': 'Serverda tmux yo‘q — aloqa uzilsa sessiya qayta boshlanadi' }, 'tmux yo‘q');
    }
    clear(
      this.statusEl,
      h('span', { class: `s-dot state-${s.state}` }),
      h('span', null, label),
      h('span', { class: 's-sep' }, '·'),
      h('span', { class: 'mono' }, addr),
      tmux && [h('span', { class: 's-sep' }, '·'), tmux],
    );
    this.tabSub.textContent = s.state === 'ready' || s.state === 'connecting' ? addr : label.toLowerCase();
    this.tab.dataset.tip = `${this.server.name} · ${addr} · ${label}`;
  }

  stateLabel(view) {
    const cs = this.claudeState(view);
    if (!cs) return null;
    const text = cs.state === 'wait' ? waitText(cs) : cs.state === 'done' ? 'tugadi' : 'ishlayapti';
    return h('span', { class: 'th-state' }, ` · ${text}`);
  }

  /** "Terminal 2 · Claude Code · <task>" above the terminal screen. */
  renderTermHead() {
    const v = this.active;
    if (!v) {
      clear(this.termHead);
      return;
    }
    const i = this.shells.indexOf(v);
    const agent = this.agentOf(v);
    const pane = v.attach ? this.agents?.panes?.[v.attach] : null;
    const task = cleanTitle(agent ? pane?.title : v.title);
    const meta = [v.attach, v.persistent ? 'tmux' : null].filter(Boolean).join(' · ');
    const asks = this.claudeAsks(v);
    clear(
      this.termHead,
      h('span', { class: 'th-title' }, `Terminal ${i + 1}`),
      agent && h('span', { class: `th-agent ${this.claudeState(v) ? `th-${this.claudeState(v).state}` : ''}` }, icon(AGENTS[agent].icon, 12), AGENTS[agent].label, this.stateLabel(v)),
      asks && this.answerKeys(v),
      !asks && task && !/^(claude code|agy|antigravity)$/i.test(task) && h('span', { class: 'th-task' }, task),
      h('span', { class: 'grow' }),
      meta && h('span', { class: 'th-meta mono' }, meta),
    );
    this.renderWaiting();
  }

  /** Claude waits for a permission answer in this terminal (and it is not answered yet). */
  claudeAsks(view) {
    const cs = this.claudeState(view);
    if (!cs || cs.state !== 'wait') return null;
    if (cs.kind !== 'permission_prompt' && !/permission/i.test(cs.message || '')) return null;
    if (view.answeredAt === cs.t) return null;
    return cs;
  }

  /** "Ruxsat berish" = Enter on Claude's highlighted "Yes"; "Rad etish" = Esc ("No"). */
  answerClaude(view, yes) {
    const cs = this.claudeState(view);
    view.write(yes ? '\r' : '\x1b');
    view.answeredAt = cs?.t ?? Date.now();
    view.attention = false;
    this.renderShellTabs();
    this.updateAttention();
  }

  answerKeys(view) {
    return h(
      'span',
      { class: 'th-answer' },
      h('button', { class: 'th-key yes', type: 'button', 'data-tip': 'Claude’ning taklifiga rozilik (Enter)', onclick: () => this.answerClaude(view, true) }, icon('check', 13), 'Ruxsat berish'),
      h('button', { class: 'th-key no', type: 'button', 'data-tip': 'Rad etish (Esc) — Claude boshqa yo‘l izlaydi', onclick: () => this.answerClaude(view, false) }, icon('x', 13), 'Rad etish'),
    );
  }

  /** Cards for the other terminals where Claude waits for permission. */
  renderWaiting() {
    const cards = [];
    for (const [i, v] of this.shells.entries()) {
      if (v === this.active) continue;
      const cs = this.claudeAsks(v);
      if (!cs) continue;
      const preview = v.lastLines?.(4) || [];
      cards.push(
        h(
          'div',
          { class: 'cl-wait' },
          h('div', { class: 'cl-wait-top' }, icon('claude', 13), h('b', null, `Terminal ${i + 1}`), h('span', null, waitText(cs))),
          preview.length > 0 && h('pre', { class: 'cl-wait-pre' }, preview.join('\n')),
          h(
            'div',
            { class: 'cl-wait-actions' },
            h('button', { class: 'th-key yes', type: 'button', onclick: () => this.answerClaude(v, true) }, icon('check', 13), 'Ruxsat berish'),
            h('button', { class: 'th-key no', type: 'button', onclick: () => this.answerClaude(v, false) }, icon('x', 13), 'Rad etish'),
            h('button', { class: 'th-key', type: 'button', onclick: () => this.select(v) }, 'Ko‘rish'),
          ),
        ),
      );
    }
    clear(this.waitStack, cards);
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
    if (s.state !== prev) this.system?.onState(s.state);

    this.el.dataset.state = s.state;
    this.renderTitle();
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
    if (this.mode === 'files' || this.mode === 'split') this.ensureFiles();
    if (this.mode === 'system') this.ensureSystem().show();
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
    if (mode !== 'system') this.app.saveLayout({ mode }); // "Tizim" is a visit, not a layout
    this.applyMode();
    if (mode === 'files' || mode === 'split') this.ensureFiles();
    if (mode === 'system') this.ensureSystem().show();
    requestAnimationFrame(() => {
      this.fitActive();
      if (mode === 'files') this.files?.list.focus();
      else if (mode !== 'system') this.active?.focus();
    });
  }

  /** "Tizim": services, Docker, logs, disk (src/renderer/system.js). */
  ensureSystem() {
    if (!this.system) {
      this.system = new SystemView(this);
      this.sysPane.append(this.system.el);
    }
    return this.system;
  }

  openSystem(tab, opts = {}) {
    this.app.activate(this.id);
    if (this.mode !== 'system') this.setMode('system');
    this.ensureSystem().show(tab, opts);
  }

  /**
   * Server alerts (Settings → Server ogohlantirishlari): the disk nearly full,
   * the memory nearly used up for a minute. A Windows notification at most
   * every 6 hours per kind; clicking it opens the matching panel.
   */
  checkAlerts(st) {
    if (this.app.settings.serverAlerts === false || !st) return;
    const now = Date.now();
    const disk = st.diskTotal ? st.diskUsed / st.diskTotal : null;
    const mem = st.memTotal ? st.memUsed / st.memTotal : null;
    this.alertedAt ??= {};
    const fire = (key, title, body) => {
      if (now - (this.alertedAt[key] || 0) < 6 * 3600 * 1000) return;
      this.alertedAt[key] = now;
      call('notify', { title, body, tag: `${this.id}/@${key}` }).catch(() => {});
    };
    if (disk != null && disk >= 0.9) {
      fire('disk', `${this.server.name}: disk ${Math.round(disk * 100)}% to‘lgan`, `Bo‘sh joy ${fmtBytes(st.diskTotal - st.diskUsed)} qoldi. Bosing — joy nimaga ketganini ko‘rsataman.`);
    }
    if (mem != null && mem >= 0.95) {
      this.memHighSince ??= now;
      if (now - this.memHighSince > 60 * 1000) fire('mem', `${this.server.name}: RAM ${Math.round(mem * 100)}% band`, 'Bir daqiqadan beri deyarli to‘lgan. Bosing — eng ko‘p xotira olayotgan jarayonlar.');
    } else {
      this.memHighSince = null;
    }
  }

  /** Show a folder in Fayllar (and select a file in it). */
  async openFilesAt(dir, select = null) {
    if (this.mode !== 'files' && this.mode !== 'split') this.setMode('files');
    this.ensureFiles();
    await this.files?.go(dir);
    if (select) this.files?.select(select);
  }

  applyMode() {
    this.el.dataset.mode = this.mode;
    this.body.style.setProperty('--split', `${this.split * 100}%`);
    const noTerm = this.mode === 'files' || this.mode === 'system';
    this.shellTabs.hidden = noTerm;
    this.searchBtn.hidden = noTerm;
    this.cmdBtn.hidden = noTerm;
    this.renderAiButton();
    if (this.app.activeId === this.id) this.app.renderModes();
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
    this.termStack.append(view.host);
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
    if (this.app.activeId === this.id) view.attention = false;
    this.showOnly(view);
    this.renderShellTabs();
    this.renderTitle();
    this.updateAttention();
    if (this.mode !== 'files') requestAnimationFrame(() => view.focus());
    if (this.app.activeId === this.id) this.app.renderStatus();
  }

  async closeShell(view, { confirm = true } = {}) {
    if (!view) return;
    if (confirm && !(await this.confirmCloseShell(view))) return;
    if (!this.shells.includes(view)) return;
    this.removeShell(view);
    await call('shell:close', this.id, view.id, { kill: true }).catch(() => {});
    if (!this.shells.length && this.state.state === 'ready') {
      if (this.mode === 'files') return;
      await this.addShell();
    }
  }

  /** Closing kills the tmux session: ask first if a program (Claude Code, vim, a build…) runs in it. */
  async confirmCloseShell(view) {
    if (view.exited || !view.persistent || !view.attach) return true;
    const pane = this.agents?.panes?.[view.attach];
    const cmd = String(pane?.command || '').replace(/^-/, '').trim();
    if (!cmd || SHELLS.has(cmd)) return true;
    const what = pane.agent ? AGENTS[pane.agent].label : cmd;
    const n = this.shells.indexOf(view) + 1;
    return confirmDialog({
      title: `Terminal ${n} yopilsinmi?`,
      message: `Unda hozir ${what} ishlayapti. Terminal yopilsa, u to‘xtaydi va serverdagi sessiya ham o‘chadi.`,
      confirm: 'Yopish',
      danger: true,
    });
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
      const agent = this.agentOf(s);
      const pill = h(
        'div',
        {
          class: `shell-pill ${s === this.active ? 'on' : ''} ${s.exited ? 'exited' : ''} ${agent ? `agent agent-${agent}` : ''} ${s.attention ? 'attn' : ''}`,
          role: 'tab',
          'data-tip': this.shellTip(s, i),
          onclick: () => this.select(s),
        },
        agent && h('span', { class: 'pill-agent' }, icon(AGENTS[agent].icon, 13)),
        h('span', { class: 'pill-num' }, String(i + 1)),
        this.pillState(s),
        h('button', {
          class: 'pill-close',
          type: 'button',
          'aria-label': 'Yopish',
          onclick: (e) => {
            e.stopPropagation();
            this.closeShell(s);
          },
        }, icon('x', 10)),
      );
      pill.addEventListener('auxclick', (e) => {
        if (e.button === 1) this.closeShell(s);
      });
      pill.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY, [
          { label: 'Yangi terminal', icon: 'plus', hint: 'Ctrl+Shift+T', onClick: () => this.addShell() },
          ...(this.hasAgents() ? ['-', ...agentMenuItems(this, { resume: false })] : []),
          '-',
          { label: 'Qidirish', icon: 'search', hint: 'Ctrl+Shift+F', onClick: () => (this.select(s), s.openSearch()) },
          { label: 'Ekranni tozalash', icon: 'refresh', onClick: () => s.term.clear() },
          '-',
          { label: 'Yopish', icon: 'x', hint: 'Ctrl+Shift+W', danger: true, onClick: () => this.closeShell(s) },
        ]);
      });
      this.shellTabs.append(pill);
    });
    this.shellTabs.append(
      h('button', { class: 'key key-gray key-icon shell-add', type: 'button', 'data-tip': 'Yangi terminal · Ctrl+Shift+T', 'aria-label': 'Yangi terminal', onclick: () => this.addShell() }, icon('plus', 17)),
    );
    this.renderTermHead();
  }

  /* ---------------- quick commands ---------------- */

  openSnippets() {
    const r = this.cmdBtn.getBoundingClientRect();
    menu(r.left, r.bottom + 6, snippetMenuItems(this));
  }

  runSnippet(sn) {
    if (this.state.state !== 'ready' || !this.active) {
      toast('Server bilan aloqa yo‘q', 'err');
      return;
    }
    if (this.mode === 'files') this.setMode('split');
    const view = this.active;
    view.write(`${sn.cmd}${sn.run !== false ? '\r' : ''}`);
    requestAnimationFrame(() => view.focus());
  }

  /** Small mark on a terminal key: Claude is working (spinner), waits for you (!), or is done (✓). */
  pillState(view) {
    const cs = this.claudeState(view);
    if (!cs) return null;
    if (cs.state === 'work') return h('span', { class: 'pill-state ps-work', 'aria-label': 'ishlayapti' });
    if (cs.state === 'wait') return h('span', { class: 'pill-state ps-wait', 'aria-label': 'sizni kutyapti' }, '!');
    return h('span', { class: 'pill-state ps-done', 'aria-label': 'tugadi' }, icon('check', 10));
  }

  cdInTerminal(path) {
    if (this.mode === 'files') this.setMode('split');
    const view = this.active;
    if (!view) return;
    view.write(`cd -- ${shellQuote(path)}\r`);
    requestAnimationFrame(() => view.focus());
  }

  /* ---------------- AI agents (Claude Code, agy) ---------------- */

  onAgents(st) {
    const before = JSON.stringify(this.agents?.panes || {});
    const prevEvents = this.agents?.claude?.events || {};
    const beforeEvents = JSON.stringify(prevEvents);
    this.agents = st;
    const events = st.claude?.events || {};
    if (JSON.stringify(st.panes || {}) !== before || JSON.stringify(events) !== beforeEvents) this.renderShellTabs();
    this.checkClaudeEvents(prevEvents, events);
    this.renderAiButton();
    refreshUsagePanel(this);
    if (this.app.activeId === this.id) this.app.renderStatus();
  }

  hasAgents() {
    const st = this.agents;
    return !!(st && (st.claude?.path || st.agy?.path || Object.values(st.panes || {}).some((p) => p.agent)));
  }

  /**
   * What Claude Code is doing in this terminal, from its hooks:
   * { state: 'work' | 'wait' | 'done', message, t } or null.
   */
  claudeState(view) {
    const ev = view?.attach ? this.agents?.claude?.events?.[view.attach] : null;
    if (!ev || ev.e === 'end' || this.agentOf(view) !== 'claude') return null;
    const state = ev.e === 'wait' ? 'wait' : ev.e === 'done' ? 'done' : 'work';
    return { state, message: ev.message, kind: ev.kind, t: ev.t };
  }

  /** 'claude' | 'agy' | null — what runs in this terminal right now. */
  agentOf(view) {
    return (view?.attach && this.agents?.panes?.[view.attach]?.agent) || null;
  }

  shellTip(view, i) {
    const pane = view.attach ? this.agents?.panes?.[view.attach] : null;
    const agent = pane?.agent;
    if (!agent) return view.title || `Terminal ${i + 1}${view.persistent ? ' · tmux' : ''}`;
    const parts = [AGENTS[agent].label];
    const title = cleanTitle(pane.title);
    if (title && !/^(claude code|agy|antigravity)/i.test(title)) parts.push(title);
    const cs = agent === 'claude' ? this.claudeState(view) : null;
    if (cs) parts.push(cs.state === 'wait' ? waitText(cs) : cs.state === 'done' ? 'tugadi' : 'ishlayapti');
    const snap = agent === 'claude' ? this.agents?.claude?.sessions?.[view.attach] : null;
    if (snap?.ctx != null) parts.push(`kontekst ${Math.round(snap.ctx)}%`);
    return parts.join(' · ');
  }

  renderAiButton() {
    if (!this.aiBtn) return;
    this.aiBtn.hidden = this.mode === 'files' || !this.hasAgents();
  }

  openAgentMenu() {
    const r = (this.aiBtn.hidden ? this.shellTabs : this.aiBtn).getBoundingClientRect();
    menu(r.left, r.bottom + 4, [
      ...agentMenuItems(this),
      '-',
      { label: 'Limitlar', icon: 'gauge', onClick: () => openUsagePanel(this, document.querySelector('.sb-agent') || this.aiBtn) },
    ]);
  }

  /**
   * Start an agent in a new terminal tab. Without `dir` it starts where the
   * current terminal is (its working directory), so "AI → Claude Code" from a
   * project folder works on that project.
   */
  async launchAgent(kind, { dir = null, resume = false } = {}) {
    if (this.state.state !== 'ready') {
      toast('Server bilan aloqa yo‘q', 'err');
      return;
    }
    if (!dir) dir = (this.active?.attach && this.agents?.panes?.[this.active.attach]?.cwd) || null;
    if (this.mode === 'files') this.setMode('split');
    const view = await this.addShell();
    if (!view) return;
    const cmd = agentCommand(this.app, kind, { resume });
    view.write(`${dir ? `cd -- ${shellQuote(dir)} && ` : ''}${cmd}\r`);
    requestAnimationFrame(() => view.focus());
  }

  /** Claude finished or waits for you in some terminal: mark it and notify (precise text from the hooks). */
  checkClaudeEvents(prev, next) {
    const primed = this.eventsPrimed;
    this.eventsPrimed = true;
    if (!primed) return; // the first scan only shows old news
    for (const [session, ev] of Object.entries(next)) {
      const old = prev[session];
      if (old && old.t === ev.t && old.e === ev.e) continue;
      if (ev.e !== 'wait' && ev.e !== 'done') continue;
      const view = this.shells.find((v) => v.attach === session);
      if (view) this.alertAgent(view, ev);
    }
  }

  alertAgent(view, ev) {
    const looking = this.app.activeId === this.id && this.active === view && this.mode !== 'files' && document.hasFocus() && !document.hidden;
    if (looking) return;
    if (!view.attention) {
      view.attention = true;
      this.renderShellTabs();
      this.updateAttention();
    }
    if (!this.app.settings.agentNotify) return;
    const now = Date.now();
    if (now - (view.notifiedAt || 0) < 4000) return;
    view.notifiedAt = now;
    const n = this.shells.indexOf(view) + 1;
    const task = cleanTitle(this.agents?.panes?.[view.attach]?.title);
    const named = task && !/^(claude code|claude)$/i.test(task) ? `${task}: ` : '';
    const body = ev.e === 'wait' ? `${named}${waitText(ev)}` : `${named}ish tugadi`;
    call('notify', { title: `${this.server.name} · Claude Code · terminal ${n}`, body, tag: `${this.id}/${view.id}` }).catch(() => {});
  }

  /** A terminal rang its bell (Claude finished, asks for permission…). */
  onBell(view) {
    // With hooks on, Claude's own events say exactly what happened (see alertAgent).
    if (this.agents?.claude?.hooks && this.agentOf(view) === 'claude') return;
    const looking = this.app.activeId === this.id && this.active === view && this.mode !== 'files' && document.hasFocus() && !document.hidden;
    if (looking) return;
    if (!view.attention) {
      view.attention = true;
      this.renderShellTabs();
      this.updateAttention();
    }
    if (!this.app.settings.agentNotify) return;
    const now = Date.now();
    if (now - (view.notifiedAt || 0) < 15000) return;
    view.notifiedAt = now;
    const pane = view.attach ? this.agents?.panes?.[view.attach] : null;
    const agent = pane?.agent;
    const n = this.shells.indexOf(view) + 1;
    const title = `${this.server.name} · ${agent ? AGENTS[agent].label : `Terminal ${n}`}`;
    const what = cleanTitle(pane?.title);
    const body = agent
      ? `${what && !/^(claude code|agy)$/i.test(what) ? `${what}: ` : ''}ish tugadi yoki ruxsat so‘rayapti`
      : 'Terminal signal berdi';
    call('notify', { title, body, tag: `${this.id}/${view.id}` }).catch(() => {});
  }

  clearAttention() {
    const view = this.active;
    if (!view?.attention || this.mode === 'files') return;
    view.attention = false;
    this.renderShellTabs();
    this.updateAttention();
  }

  updateAttention() {
    this.tab.classList.toggle('attn', this.shells.some((s) => s.attention));
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
    this.clearAttention();
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
    closeUsagePanel(this);
    this.system?.dispose();
    for (const s of this.shells) {
      this.app.unregisterShell(s);
      s.dispose();
    }
    this.shells = [];
    await call('conn:close', this.id).catch(() => {});
  }
}
