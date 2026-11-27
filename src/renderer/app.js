// App shell: title bar tabs, views, status bar, global shortcuts and IPC routing.

import { call, on, send } from './api.js';
import { h, icon, clear, fmt } from './dom.js';
import { toast, confirmDialog, modal } from './ui.js';
import { Home, serverForm } from './home.js';
import { Session } from './session.js';
import { handlePrompt } from './prompts.js';
import { openSettings } from './settings.js';
import { Transfers } from './xfer.js';
import { onThemeChange } from './terminal.js';
import { usageChips, closeUsagePanel } from './agents.js';
import { recordStats, openStatsPanel, refreshStatsPanel, closeStatsPanel } from './stats.js';
import { openTunnelPanel, refreshTunnelPanel, closeTunnelPanel } from './tunnels.js';

const LAYOUT_KEY = 'pult.layout';

// Rail mode keys: [mode, icon, label, tooltip].
const MODES = [
  ['terminal', 'terminal', 'Terminal', 'Terminal · Ctrl+Shift+1'],
  ['files', 'folder', 'Fayllar', 'Fayllar · Ctrl+Shift+2'],
  ['split', 'split', 'Yonma-yon', 'Yonma-yon · Ctrl+Shift+3'],
];

/** "1.5 GB" → ["1.5", "GB"]: the number goes in the dot-matrix face. */
const splitUnit = (text) => {
  const i = String(text).lastIndexOf(' ');
  return i > 0 ? [text.slice(0, i), text.slice(i + 1)] : [String(text), ''];
};

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
    this.applyLook();

    this.views = document.getElementById('views');
    this.statusbar = document.getElementById('statusbar');

    this.buildRail();
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
    this.restoreOpen();
    // A newer Pult on GitHub? Checked a little after start, then twice a day.
    setTimeout(() => this.checkUpdate(), 8000);
    setInterval(() => this.checkUpdate(), 12 * 3600e3);
  }

  async checkUpdate({ manual = false } = {}) {
    if (!manual && this.settings.checkUpdates === false) return null;
    let r;
    try {
      r = await call('update:check');
    } catch (err) {
      if (manual) toast(`Tekshirib bo‘lmadi: ${err.message}`, 'err', 5000);
      return null;
    }
    let skipped = null;
    try {
      skipped = localStorage.getItem('pult.update.skip');
    } catch {
      // Non-essential.
    }
    this.update = r.available && (manual || skipped !== r.release.version) ? r : null;
    this.renderStatus();
    if (manual) {
      if (this.update) this.showUpdate();
      else toast(`Pult ${r.current} — eng so‘nggi versiya`, 'ok', 3000);
    }
    return r;
  }

  async showUpdate() {
    const u = this.update;
    if (!u) return;
    const notes = u.release.notes.trim();
    const bar = h('div', { class: 'up-bar', hidden: true }, h('span'));
    const status = h('div', { class: 'up-status' });
    const choice = await modal({
      title: `Pult ${u.release.version} chiqdi`,
      icon: 'download',
      width: 560,
      body: h(
        'div',
        { class: 'up' },
        h('p', { class: 'm-text' }, `Sizda ${u.current} turibdi. ${u.portable ? 'Bu ko‘chma (portable) versiya: yangisini release sahifasidan yuklab oling.' : 'Yangi versiya yuklab olinadi va o‘rnatiladi; Pult o‘zi qayta ochiladi, terminallaringiz (tmux) saqlanib qoladi.'}`),
        notes && h('div', { class: 'up-notes' }, notes),
        bar,
        status,
      ),
      actions: [
        { label: 'Keyinroq', value: 'later' },
        { label: 'Bu versiyani o‘tkazib yuborish', value: 'skip' },
        u.portable || !u.release.installer
          ? { label: 'Sahifani ochish', kind: 'primary', onClick: () => (call('update:page'), 'page') }
          : {
              label: 'O‘rnatish',
              kind: 'primary',
              onClick: async () => {
                bar.hidden = false;
                status.textContent = 'Yuklanmoqda…';
                const off = on('update:progress', (done, total) => {
                  bar.firstChild.style.width = total ? `${Math.round((done / total) * 100)}%` : '30%';
                  status.textContent = `Yuklanmoqda… ${fmt.bytes(done)}${total ? ` / ${fmt.bytes(total)}` : ''}`;
                });
                try {
                  await call('update:install');
                  status.textContent = 'O‘rnatuvchi ishga tushdi — Pult yopiladi';
                  return false;
                } catch (err) {
                  status.textContent = `Bo‘lmadi: ${err.message}`;
                  return false;
                } finally {
                  off();
                }
              },
            },
      ],
    }).promise;
    if (choice === 'skip') {
      try {
        localStorage.setItem('pult.update.skip', u.release.version);
      } catch {
        // Non-essential.
      }
      this.update = null;
      this.renderStatus();
    }
  }

  /** Reconnect to the servers that were open when Pult was closed (their tmux sessions are still there). */
  restoreOpen() {
    const saved = Array.isArray(this.layout.open) ? this.layout.open : [];
    if (this.settings.restoreSessions === false || !saved.length) return;
    this.restoring = true;
    for (const id of saved) {
      const server = this.servers.find((x) => x.id === id);
      if (server && !this.sessionFor(id)) this.openServer(server);
    }
    this.restoring = false;
    const active = this.layout.active && this.sessionFor(this.layout.active);
    if (active) this.activate(active.id);
    this.saveOpen();
  }

  /** Which servers are open and which one is in front, for the next start. */
  saveOpen() {
    if (this.restoring) return;
    const active = this.activeSession();
    this.saveLayout({ open: [...this.sessions.values()].map((s) => s.server.id), active: active ? active.server.id : null });
  }

  /* ---------------- rail (left control column) ---------------- */

  buildRail() {
    this.rail = document.getElementById('rail');
    this.tabsEl = h('div', { class: 'rail-servers', role: 'tablist', 'aria-label': 'Ochiq ulanishlar' });
    this.homeTab = h(
      'button',
      { class: 'key rail-home', type: 'button', 'data-tip': 'Barcha serverlar', onclick: () => this.activate('home') },
      icon('grid', 17),
      h('span', { class: 'key-label' }, 'Serverlar'),
    );
    this.modeKeys = MODES.map(([mode, ic, label, tip]) =>
      h(
        'button',
        { class: 'key mode-key', type: 'button', dataset: { mode }, 'data-tip': tip, onclick: () => this.activeSession()?.setMode(mode) },
        icon(ic, 18),
        h('span', { class: 'key-label' }, label),
      ),
    );
    this.modesEl = h('div', { class: 'rail-modes', role: 'group', 'aria-label': 'Rejim' }, h('div', { class: 'rail-label' }, 'Rejim'), this.modeKeys);
    this.railToggle = h('button', { class: 'key key-gray key-xs rail-collapse', type: 'button', onclick: () => this.toggleRail() });
    clear(
      this.rail,
      h('div', { class: 'rail-top' }, h('span', { class: 'logo' }, 'pult'), h('span', { class: 'logo-led' }), h('span', { class: 'grow' }), this.railToggle),
      h('div', { class: 'rail-label' }, 'Serverlar'),
      this.tabsEl,
      h(
        'div',
        { class: 'rail-row' },
        this.homeTab,
        h('button', { class: 'key key-gray key-icon rail-add', type: 'button', 'data-tip': 'Yangi server · Ctrl+Shift+N', 'aria-label': 'Yangi server', onclick: () => this.editServer() }, icon('plus', 17)),
      ),
      h('div', { class: 'grow' }),
      this.modesEl,
      h('div', { class: 'rail-sep' }),
      h(
        'button',
        { class: 'key key-gray tb-settings', type: 'button', 'data-tip': 'Sozlamalar · Ctrl+,', onclick: () => openSettings(this) },
        icon('sliders', 17),
        h('span', { class: 'key-label' }, 'Sozlamalar'),
        h('span', { class: 'key-hint' }, 'Ctrl+,'),
      ),
    );
    this.applyRail();
  }

  /** Narrow rail: only icons and two-letter server badges. */
  toggleRail() {
    this.saveLayout({ railMini: !this.layout.railMini });
    this.applyRail();
  }

  applyRail() {
    const mini = !!this.layout.railMini;
    document.getElementById('app').classList.toggle('rail-mini', mini);
    this.railToggle.dataset.tip = mini ? 'Panelni yoyish' : 'Panelni yig‘ish';
    this.railToggle.setAttribute('aria-label', this.railToggle.dataset.tip);
    this.railToggle.replaceChildren(icon(mini ? 'chevronRight' : 'chevronLeft', 14));
  }

  renderTabs() {
    this.homeTab.classList.toggle('on', this.activeId === 'home');
    for (const s of this.sessions.values()) s.tab.classList.toggle('on', s.id === this.activeId);
    this.renderModes();
  }

  renderModes() {
    const s = this.activeSession();
    this.modesEl.hidden = !s;
    for (const b of this.modeKeys) b.classList.toggle('on', !!s && b.dataset.mode === s.mode);
  }

  /** Signal colour and chassis colour from the settings, as CSS variables. */
  applyLook() {
    const root = document.documentElement;
    root.dataset.signal = this.settings.signal || 'orange';
    root.dataset.body = this.settings.body || 'gray';
  }

  /* ---------------- status bar ---------------- */

  buildStatusbar() {
    this.sbLeft = h('div', { class: 'sb-left' });
    this.sbRight = h('div', { class: 'sb-right' });
    clear(this.statusbar, this.sbLeft, h('div', { class: 'grow' }), this.sbRight, this.transfers.chip);
  }

  renderStatus() {
    const chip = (label, value, unit, { cls = '', tip = null, onclick = null } = {}) =>
      h(
        onclick ? 'button' : 'span',
        { class: `sb-chip ${cls} ${onclick ? 'sb-stat' : ''}`, type: onclick ? 'button' : null, 'data-tip': tip, onclick },
        h('span', { class: 'sb-label' }, label),
        h('span', { class: 'sb-num' }, value),
        unit && h('span', { class: 'sb-unit' }, unit),
      );
    const update = this.update && chip('Yangi', this.update.release.version, null, { cls: 'sb-update', tip: 'Pult’ning yangi versiyasi — bosing', onclick: () => this.showUpdate() });
    const s = this.sessions.get(this.activeId);
    if (!s) {
      this.statusbar.classList.remove('has-agents');
      const open = this.sessions.size;
      clear(this.sbLeft, chip('Pult', this.info.version || '', null, { cls: 'sb-brand' }), update, open > 0 && chip('Ochiq', String(open), 'ta ulanish'));
      clear(this.sbRight);
      return;
    }
    const st = s.state;
    const agents = st.state === 'ready' ? usageChips(s) : [];
    this.statusbar.classList.toggle('has-agents', agents.length > 0);
    clear(this.sbLeft, agents, update);

    const m = s.stats;
    if (st.state !== 'ready' || !m) {
      clear(this.sbRight);
      return;
    }
    const tone = (r) => (r > 0.9 ? 'crit' : r > 0.75 ? 'warn' : '');
    const mem = m.memTotal ? m.memUsed / m.memTotal : null;
    const disk = m.diskTotal ? m.diskUsed / m.diskTotal : null;
    let ram = null;
    if (mem != null) {
      const [uv, uu] = splitUnit(fmt.bytes(m.memUsed));
      const [tv, tu] = splitUnit(fmt.bytes(m.memTotal));
      ram = chip('RAM', uv, `${uu === tu ? '' : `${uu} `}/ ${tv} ${tu}`, { cls: `sb-ram ${tone(mem)}`, tip: `Operativ xotira — ${Math.round(mem * 100)}% band · bosing: grafiklar`, onclick: () => openStatsPanel(s) });
    }
    const [upv, upu] = splitUnit(fmt.uptime(m.uptime));
    const open = () => openStatsPanel(s);
    const ports = (s.tunnels || []).length;
    clear(
      this.sbRight,
      chip('Port', String(ports), ports ? 'ochiq' : '', { cls: 'sb-tun sb-gray', tip: 'Serverdagi portni shu kompyuterda ochish (SSH tunnel)', onclick: () => openTunnelPanel(s) }),
      m.rtt != null && chip('Ping', String(m.rtt), 'ms', { cls: m.rtt > 250 ? 'warn' : '', tip: 'Kechikish — bosing: grafiklar va jarayonlar', onclick: open }),
      m.cpu != null && chip('CPU', String(Math.round(m.cpu * 100)), '%', { cls: tone(m.cpu), tip: 'Protsessor — bosing: grafiklar va jarayonlar', onclick: open }),
      ram,
      disk != null && chip('Disk', String(Math.round(disk * 100)), '%', { cls: `sb-disk ${tone(disk)}`, tip: `/ — ${fmt.bytes(m.diskUsed)} / ${fmt.bytes(m.diskTotal)}` }),
      m.uptime && chip('Uptime', upv, upu, { cls: 'sb-uptime sb-gray', tip: 'Server ishlab turgan vaqt' }),
    );
  }

  /* ---------------- navigation ---------------- */

  activate(id) {
    if (id !== 'home' && !this.sessions.has(id)) id = 'home';
    if (id !== this.activeId) {
      closeUsagePanel();
      closeStatsPanel();
      closeTunnelPanel();
    }
    this.activeId = id;
    this.home.el.classList.toggle('on', id === 'home');
    for (const s of this.sessions.values()) s.el.classList.toggle('on', s.id === id);
    this.renderTabs();
    this.renderStatus();
    this.saveOpen();
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
    this.saveOpen();
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
        s.renderTitle();
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
    if ('signal' in patch || 'body' in patch) {
      this.applyLook();
      for (const view of this.shells.values()) view.applyTheme();
    }
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
      recordStats(s, stats);
      refreshStatsPanel(s);
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
      if (s.shells.length > 1) s.closeShell(v, { confirm: false });
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
    // "Open on this computer": saves there are copied back to the server.
    on('edit:synced', (item) => {
      toast(`Serverga saqlandi: ${item.name}`, 'ok', 2200);
      const files = this.sessions.get(item.connId)?.files;
      if (files && item.remote.slice(0, item.remote.lastIndexOf('/')) === files.cwd) files.refresh();
    });
    on('edit:failed', (item, message) => toast(`${item.name} serverga saqlanmadi: ${message}`, 'err', 6000));
    on('edit:conflict', async (item) => {
      const ok = await confirmDialog({
        title: 'Serverdagi fayl o‘zgargan',
        message: `“${item.name}” siz ochganingizdan keyin serverda o‘zgartirilgan. Kompyuterdagi nusxangiz bilan ustidan yozilsinmi?`,
        confirm: 'Ustidan yozish',
        danger: true,
      });
      if (ok) call('edit:force', item.local);
    });
    on('tun:update', (connId, list) => {
      const s = this.sessions.get(connId);
      if (!s) return;
      s.tunnels = list;
      refreshTunnelPanel(s);
      if (connId === this.activeId) this.renderStatus();
    });
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
    else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code) && s && (this.settings.snippets || [])[Number(e.code.slice(5)) - 1]) {
      s.runSnippet(this.settings.snippets[Number(e.code.slice(5)) - 1]);
    } else handled = false;
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
