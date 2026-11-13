// App shell: title bar tabs, views, status bar, global shortcuts and IPC routing.

import { call, on, send } from './api.js';
import { h, icon, clear, fmt } from './dom.js';
import { toast } from './ui.js';
import { Home, serverForm } from './home.js';
import { Session } from './session.js';
import { handlePrompt } from './prompts.js';
import { openSettings } from './settings.js';
import { Transfers } from './xfer.js';
import { onThemeChange } from './terminal.js';
import { usageChips, closeUsagePanel } from './agents.js';

const STATE_LABEL = {
  connecting: 'Ulanmoqda',
  ready: 'Ulangan',
  reconnecting: 'Qayta ulanmoqda',
  failed: 'Ulanmadi',
  closed: 'Yopilgan',
};

const LAYOUT_KEY = 'pult.layout';

class App {
  constructor() {
    this.servers = [];
    this.settings = {};
    this.info = {};
    this.sessions = new Map();
    this.shells = new Map();
    this.uploadWaiters = new Map(); // transfer job id → callback when it is done
    this.activeId = 'home';
    try {
      this.layout = JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {};
    } catch {
      this.layout = {};
    }
  }

  async init() {
    [this.settings, this.servers, this.info] = await Promise.all([call('settings:get'), call('servers:list'), call('app:info')]);

    this.titlebar = document.getElementById('titlebar');
    this.views = document.getElementById('views');
    this.statusbar = document.getElementById('statusbar');

    this.buildTitlebar();
    this.home = new Home(this);
    this.views.append(this.home.el);
    this.home.render();

    this.transfers = new Transfers(this);
    this.buildStatusbar();

    this.listen();
    this.activate('home');

    // Fonts must be ready before xterm measures cell sizes.
    await Promise.all([
      document.fonts.load(`${this.settings.fontSize}px "JetBrains Mono"`),
      document.fonts.load(`bold ${this.settings.fontSize}px "JetBrains Mono"`),
    ]).catch(() => {});
    document.body.classList.add('ready');
  }

  /* ---------------- title bar ---------------- */

  buildTitlebar() {
    this.homeTab = h(
      'button',
      { class: 'tab tab-home', type: 'button', 'data-tip': 'Serverlar', onclick: () => this.activate('home') },
      icon('grid', 16),
    );
    this.tabsEl = h('div', { class: 'tabs', role: 'tablist' });
    clear(
      this.titlebar,
      h('div', { class: 'brand' }, icon('logo', 18)),
      this.homeTab,
      this.tabsEl,
      h('button', { class: 'tab-new', type: 'button', 'data-tip': 'Yangi ulanish', onclick: () => this.activate('home') }, icon('plus', 15)),
      h('div', { class: 'drag' }),
      h('button', { class: 'icon-btn tb-settings', type: 'button', 'data-tip': 'Sozlamalar · Ctrl+,', onclick: () => openSettings(this) }, icon('sliders', 16)),
    );
  }

  renderTabs() {
    this.homeTab.classList.toggle('on', this.activeId === 'home');
    for (const s of this.sessions.values()) s.tab.classList.toggle('on', s.id === this.activeId);
  }

  /* ---------------- status bar ---------------- */

  buildStatusbar() {
    this.sbLeft = h('div', { class: 'sb-left' });
    this.sbRight = h('div', { class: 'sb-right' });
    clear(this.statusbar, this.sbLeft, this.sbRight, this.transfers.chip);
  }

  renderStatus() {
    const s = this.sessions.get(this.activeId);
    if (!s) {
      this.statusbar.classList.remove('has-agents');
      const open = this.sessions.size;
      clear(
        this.sbLeft,
        h('span', { class: 'sb-item' }, icon('logo', 13), `Pult ${this.info.version || ''}`),
        open > 0 && h('span', { class: 'sb-item muted' }, `${open} ta ochiq ulanish`),
      );
      clear(this.sbRight);
      return;
    }
    const st = s.state;
    const { username, host, port } = s.server;
    const agents = st.state === 'ready' ? usageChips(s) : [];
    this.statusbar.classList.toggle('has-agents', agents.length > 0);
    clear(
      this.sbLeft,
      h('span', { class: `sb-item sb-state state-${st.state}` }, h('span', { class: 'sb-dot' }), STATE_LABEL[st.state] || st.state),
      h('span', { class: 'sb-item sb-addr mono' }, `${username}@${host}${port && port !== 22 ? `:${port}` : ''}`),
      st.state === 'ready' &&
        (s.active?.persistent
          ? h('span', { class: 'sb-badge', 'data-tip': 'tmux: aloqa uzilsa ham sessiya saqlanadi' }, icon('shield', 12), 'saqlanadi')
          : st.persist && !st.hasTmux && h('span', { class: 'sb-badge muted', 'data-tip': 'Serverda tmux yo‘q — sessiya saqlanmaydi' }, 'tmux yo‘q')),
      agents.length > 0 && h('span', { class: 'sb-sep' }),
      agents,
    );

    const m = s.stats;
    if (st.state !== 'ready' || !m) {
      clear(this.sbRight);
      return;
    }
    const meter = (label, ratio, text, tip, cls = '') =>
      ratio == null
        ? null
        : h(
            'span',
            { class: `sb-item sb-metric ${cls}`, 'data-tip': tip },
            h('span', { class: 'sb-label' }, label),
            h('span', { class: `sb-meter ${ratio > 0.9 ? 'crit' : ratio > 0.75 ? 'warn' : ''}` }, h('span', { style: { width: `${Math.max(2, ratio * 100)}%` } })),
            h('span', { class: 'sb-val' }, text),
          );
    const rtt = m.rtt;
    const mem = m.memTotal ? m.memUsed / m.memTotal : null;
    clear(
      this.sbRight,
      rtt != null && h('span', { class: `sb-item sb-rtt ${rtt > 250 ? 'warn' : ''}`, 'data-tip': 'Kechikish (ping)' }, h('span', { class: 'sb-label' }, 'Ping'), h('span', { class: 'sb-val' }, `${rtt} ms`)),
      meter('CPU', m.cpu, `${Math.round((m.cpu || 0) * 100)}%`, 'Protsessor yuklamasi'),
      m.memTotal &&
        meter('RAM', mem, [h('span', { class: 'sb-long' }, `${fmt.bytes(m.memUsed)} / ${fmt.bytes(m.memTotal)}`), h('span', { class: 'sb-short' }, `${Math.round(mem * 100)}%`)], `Operativ xotira — ${fmt.bytes(m.memUsed)} / ${fmt.bytes(m.memTotal)}`),
      m.diskTotal && meter('Disk', m.diskUsed / m.diskTotal, `${Math.round((m.diskUsed / m.diskTotal) * 100)}%`, `/ — ${fmt.bytes(m.diskUsed)} / ${fmt.bytes(m.diskTotal)}`, 'sb-disk'),
      m.uptime && h('span', { class: 'sb-item sb-uptime', 'data-tip': 'Server ishlab turgan vaqt' }, h('span', { class: 'sb-label' }, 'Uptime'), h('span', { class: 'sb-val' }, fmt.uptime(m.uptime))),
    );
  }

  /* ---------------- navigation ---------------- */

  activate(id) {
    if (id !== 'home' && !this.sessions.has(id)) id = 'home';
    if (id !== this.activeId) closeUsagePanel();
    this.activeId = id;
    this.home.el.classList.toggle('on', id === 'home');
    for (const s of this.sessions.values()) s.el.classList.toggle('on', s.id === id);
    this.renderTabs();
    this.renderStatus();
    if (id === 'home') {
      this.home.render();
      document.activeElement?.blur?.();
    } else {
      this.sessions.get(id).onShow();
      const tab = this.sessions.get(id).tab;
      tab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }

  cycle(delta) {
    const ids = ['home', ...this.sessions.keys()];
    const i = ids.indexOf(this.activeId);
    this.activate(ids[(i + delta + ids.length) % ids.length]);
  }

  sessionFor(serverId) {
    for (const s of this.sessions.values()) if (s.server.id === serverId) return s;
    return null;
  }

  openServer(server, fresh = false) {
    const existing = !fresh && this.sessionFor(server.id);
    if (existing) {
      if (existing.state.state === 'failed') existing.retry();
      this.activate(existing.id);
      return;
    }
    const s = new Session(this, server);
    this.sessions.set(s.id, s);
    this.tabsEl.append(s.tab);
    this.views.append(s.el);
    this.activate(s.id);
    s.start();
    // keep "last used" fresh on the home screen
    server.lastUsed = Date.now();
  }

  async closeSession(s) {
    if (!this.sessions.has(s.id)) return;
    const ids = [...this.sessions.keys()];
    const idx = ids.indexOf(s.id);
    this.sessions.delete(s.id);
    s.tab.remove();
    s.el.remove();
    if (this.activeId === s.id) {
      const next = ids[idx + 1] || ids[idx - 1];
      this.activate(next && this.sessions.has(next) ? next : 'home');
    } else {
      this.renderStatus();
    }
    await s.close();
  }

  async editServer(server) {
    const r = await serverForm(server);
    if (!r) return;
    await this.reloadServers();
    const fresh = this.servers.find((x) => x.id === r.server.id) || r.server;
    // Running sessions keep their snapshot; update the display name.
    for (const s of this.sessions.values()) {
      if (s.server.id === fresh.id) {
        s.server = { ...s.server, ...fresh };
        s.tab.querySelector('.tab-label').textContent = fresh.name;
      }
    }
    if (r.connect) {
      const live = this.sessionFor(fresh.id);
      if (live && live.state.state !== 'failed') this.activate(live.id);
      else if (live) {
        await this.closeSession(live);
        this.openServer(fresh);
      } else this.openServer(fresh);
    }
  }

  async reloadServers() {
    this.servers = await call('servers:list');
    if (this.activeId === 'home') this.home.render();
  }

  saveLayout(patch) {
    this.layout = { ...this.layout, ...patch };
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.layout));
    } catch {
      // Non-essential.
    }
  }

  async updateSettings(patch) {
    this.settings = await call('settings:set', patch);
    for (const view of this.shells.values()) view.applySettings(this.settings);
    if ('agentUsage' in patch) this.renderStatus();
  }

  /* ---------------- shells registry ---------------- */

  registerShell(view) {
    this.shells.set(view.id, view);
  }

  unregisterShell(view) {
    this.shells.delete(view.id);
  }

  activeSession() {
    return this.sessions.get(this.activeId) || null;
  }

  /** Run `fn(job)` when transfer `jobId` finishes (instead of the usual toast). */
  whenUploaded(jobId, fn) {
    this.uploadWaiters.set(jobId, fn);
  }

  /* ---------------- events ---------------- */

  listen() {
    on('conn:state', (connId, state) => {
      const s = this.sessions.get(connId);
      if (!s) return;
      s.onState(state);
      if (this.activeId === 'home') this.home.renderList();
    });
    on('conn:stats', (connId, stats) => {
      const s = this.sessions.get(connId);
      if (!s) return;
      s.stats = stats;
      if (connId === this.activeId) this.renderStatus();
    });
    on('shell:data', (shellId, data) => this.shells.get(shellId)?.receive(data));
    on('shell:open', (shellId) => {
      const v = this.shells.get(shellId);
      if (!v) return;
      v.onChannelOpen();
      v.session.renderShellTabs();
    });
    on('shell:exit', (shellId) => {
      const v = this.shells.get(shellId);
      if (!v) return;
      const s = v.session;
      // `exit` in one of several terminals simply closes that tab.
      if (s.shells.length > 1) s.closeShell(v);
      else {
        v.onExit();
        s.renderShellTabs();
      }
    });
    on('prompt', (p) => handlePrompt(p));
    on('xfer:update', (job) => {
      this.transfers.update(job);
      if (['error', 'cancelled'].includes(job.state) && this.uploadWaiters.has(job.id)) {
        this.uploadWaiters.delete(job.id);
        if (job.state === 'error') toast(`Yuklanmadi: ${job.error || job.name}`, 'err', 5000);
      }
    });
    on('xfer:cleared', (jobs) => this.transfers.reset(jobs));
    on('xfer:done', (job) => {
      this.sessions.get(job.connId)?.onTransferDone(job);
      const waiter = this.uploadWaiters.get(job.id);
      this.uploadWaiters.delete(job.id);
      if (waiter) waiter(job);
      else toast(`${job.kind === 'upload' ? 'Yuklandi' : 'Yuklab olindi'}: ${job.name}`, 'ok');
    });
    on('agents', (connId, st) => this.sessions.get(connId)?.onAgents(st));
    on('notify:click', (tag) => {
      const [sid, vid] = String(tag || '').split('/');
      const s = this.sessions.get(sid);
      if (!s) return;
      this.activate(sid);
      const v = s.shells.find((x) => x.id === vid);
      if (!v) return;
      if (s.mode === 'files') s.setMode('split');
      s.select(v);
    });

    addEventListener('online', () => send('net:online'));
    // Back at the window: the terminal in front has been seen.
    addEventListener('focus', () => this.activeSession()?.clearAttention());
    onThemeChange(() => {
      for (const v of this.shells.values()) v.applyTheme();
    });

    // Capture phase: our shortcuts win over xterm and inputs.
    addEventListener('keydown', (e) => this.onShortcut(e), true);

    // Ctrl + wheel = terminal font size
    addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey || !e.target.closest?.('.term-host')) return;
        e.preventDefault();
        const v = Math.max(9, Math.min(24, this.settings.fontSize + (e.deltaY < 0 ? 1 : -1)));
        if (v !== this.settings.fontSize) this.updateSettings({ fontSize: v });
      },
      { passive: false, capture: true },
    );

    // Dropping files outside a file browser must not navigate the window.
    addEventListener('dragover', (e) => e.preventDefault());
    addEventListener('drop', (e) => e.preventDefault());
  }

  onShortcut(e) {
    if (e.defaultPrevented) return;
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const s = this.activeSession();
    let handled = true;
    if (ctrl && e.key === 'Tab') this.cycle(e.shiftKey ? -1 : 1);
    else if (ctrl && e.shiftKey && e.code === 'KeyT' && s) s.addShell();
    else if (ctrl && e.shiftKey && e.code === 'KeyW' && s) s.closeShell(s.active);
    else if (ctrl && e.shiftKey && e.code === 'Digit1' && s) s.setMode('terminal');
    else if (ctrl && e.shiftKey && e.code === 'Digit2' && s) s.setMode('files');
    else if (ctrl && e.shiftKey && e.code === 'Digit3' && s) s.setMode('split');
    else if (ctrl && e.code === 'PageDown' && s) s.cycleShell(1);
    else if (ctrl && e.code === 'PageUp' && s) s.cycleShell(-1);
    else if (ctrl && e.shiftKey && e.code === 'KeyN') this.editServer();
    else if (ctrl && e.shiftKey && e.code === 'KeyA' && s && s.state.state === 'ready') s.openAgentMenu();
    else if (ctrl && !e.shiftKey && e.code === 'Comma') openSettings(this);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

const app = new App();
window.__pult = app;
app.init().catch((err) => {
  document.body.textContent = `Ishga tushirishda xato: ${err.message}`;
});
