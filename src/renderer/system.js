// "Tizim" — the server itself, next to Terminal and Fayllar: systemd services,
// Docker containers, live logs and where the disk space went. Everything runs
// over the session's SSH link (src/main/system.js).

import { call, on } from './api.js';
import { h, icon, clear, fmt, debounce } from './dom.js';
import { toast, confirmDialog, inputDialog, menu } from './ui.js';

const TABS = [
  ['services', 'cog', 'Xizmatlar'],
  ['docker', 'box', 'Docker'],
  ['logs', 'logs', 'Loglar'],
  ['disk', 'disk', 'Disk'],
  ['security', 'shield', 'Xavfsizlik'],
  ['updates', 'download', 'Yangilanishlar'],
];

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

// systemd sub-states in Uzbek (the raw one stays in the tooltip).
const SUB = {
  running: 'ishlayapti',
  exited: 'bajarildi',
  dead: 'to‘xtagan',
  failed: 'xato',
  start: 'boshlanmoqda',
  'start-pre': 'boshlanmoqda',
  'start-post': 'boshlanmoqda',
  'auto-restart': 'qayta urinmoqda',
  reload: 'qayta yuklanmoqda',
  stop: 'to‘xtamoqda',
  'stop-sigterm': 'to‘xtamoqda',
  'stop-post': 'to‘xtamoqda',
  waiting: 'kutmoqda',
  listening: 'tinglayapti',
};
const tone = (p) => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : '');

/** A small key with an icon (and an optional label). */
function miniKey(ic, label, onclick, { tip = null, cls = '' } = {}) {
  return h('button', { class: `key key-sm ${cls}`, type: 'button', 'data-tip': tip, onclick }, icon(ic, 14), label && h('span', null, label));
}

function emptyState(ic, title, text, action = null) {
  return h('div', { class: 'sy-empty' }, h('div', { class: 'sy-empty-ic' }, icon(ic, 24)), h('div', { class: 'sy-empty-title' }, title), text && h('div', { class: 'sy-empty-text' }, text), action);
}

function loading(text) {
  return h('div', { class: 'sy-loading' }, h('span', { class: 'spinner' }), h('span', null, text));
}

/* ---------------- live log streams (main → window) ---------------- */

const streams = new Map(); // stream id → { data(text), end(code) }
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  on('logs:data', (id, text) => streams.get(id)?.data(text));
  on('logs:end', (id, code) => {
    const s = streams.get(id);
    streams.delete(id);
    s?.end(code);
  });
}

/* ---------------- the view ---------------- */

export class SystemView {
  constructor(session) {
    this.session = session;
    this.tab = null;
    this.tabKeys = TABS.map(([id, ic, label]) =>
      h('button', { class: 'key sy-tab', type: 'button', dataset: { tab: id }, onclick: () => this.show(id) }, icon(ic, 16), h('span', null, label)),
    );
    this.body = h('div', { class: 'sy-body' });
    this.el = h('div', { class: 'sy' }, h('div', { class: 'sy-head' }, h('div', { class: 'sy-tabs', role: 'tablist' }, this.tabKeys)), this.body);
    this.panes = {
      services: new ServicesPane(this),
      docker: new DockerPane(this),
      logs: new LogsPane(this),
      disk: new DiskPane(this),
      security: new SecurityPane(this),
      updates: new UpdatesPane(this),
    };
  }

  get connId() {
    return this.session.id;
  }

  get ready() {
    return this.session.state.state === 'ready';
  }

  /** Show one part: 'services' | 'docker' | 'logs' | 'disk'. */
  show(tab = this.tab || 'services', opts = {}) {
    const pane = this.panes[tab] || this.panes.services;
    if (this.tab !== tab) {
      this.panes[this.tab]?.hide?.();
      this.tab = tab;
      clear(this.body, pane.el);
      for (const k of this.tabKeys) k.classList.toggle('on', k.dataset.tab === tab);
    }
    pane.show(opts);
  }

  /** The link came back (or dropped): let the visible part catch up. */
  onState(state) {
    if (state === 'ready') this.panes[this.tab]?.onReady?.();
  }

  dispose() {
    for (const p of Object.values(this.panes)) p.dispose?.();
  }
}

/* ---------------- systemd services ---------------- */

class ServicesPane {
  constructor(view) {
    this.view = view;
    this.list = null;
    this.error = null;
    this.busy = new Set(); // units with an action running
    this.filter = 'all';
    this.query = '';
    this.search = h('input', { class: 'input sy-search', placeholder: 'Xizmatni qidirish…', spellcheck: 'false', oninput: debounce(() => ((this.query = this.search.value.trim().toLowerCase()), this.render()), 120) });
    this.filters = h('div', { class: 'sy-filters' });
    this.summary = h('div', { class: 'sy-summary' });
    this.rows = h('div', { class: 'sy-list' });
    this.el = h(
      'div',
      { class: 'sy-pane' },
      h('div', { class: 'sy-bar' }, h('label', { class: 'sy-search-wrap' }, icon('search', 15), this.search), this.filters, h('div', { class: 'grow' }), this.summary, miniKey('refresh', null, () => this.load(), { tip: 'Yangilash', cls: 'key-gray key-icon-sm' })),
      this.rows,
    );
  }

  show() {
    if (!this.list && !this.loading) this.load();
  }

  onReady() {
    if (!this.list) this.load();
  }

  async load() {
    if (!this.view.ready) {
      clear(this.rows, emptyState('alert', 'Server bilan aloqa yo‘q', 'Ulanish tiklanganda ro‘yxat o‘zi yangilanadi.'));
      return;
    }
    this.loading = true;
    if (!this.list) clear(this.rows, loading('Xizmatlar ro‘yxati olinmoqda…'));
    try {
      this.list = await call('sys:services', this.view.connId);
      this.error = null;
    } catch (err) {
      this.error = err;
    } finally {
      this.loading = false;
    }
    this.render();
  }

  render() {
    if (this.error && !this.list) {
      clear(this.rows, emptyState('alert', this.error.code === 'NO_SYSTEMD' ? 'systemd topilmadi' : 'Ro‘yxatni olib bo‘lmadi', this.error.message));
      return;
    }
    if (!this.list) return;
    const counts = { all: this.list.length, running: 0, failed: 0, stopped: 0 };
    for (const s of this.list) counts[s.active === 'failed' ? 'failed' : s.active === 'active' ? 'running' : 'stopped'] += 1;
    const opts = [
      ['all', 'Hammasi'],
      ['running', 'Ishlayapti'],
      ['failed', 'Xato'],
      ['stopped', 'To‘xtagan'],
    ];
    clear(
      this.filters,
      opts.map(([id, label]) =>
        h(
          'button',
          { class: `chip-key ${this.filter === id ? 'on' : ''} ${id === 'failed' && counts.failed ? 'bad' : ''}`, type: 'button', onclick: () => ((this.filter = id), this.render()) },
          label,
          h('span', { class: 'chip-n' }, String(counts[id])),
        ),
      ),
    );
    clear(this.summary, counts.failed ? h('span', { class: 'sy-bad' }, icon('alert', 14), `${counts.failed} ta xizmat xatoda`) : h('span', null, `${counts.running} ta ishlayapti`));
    const shown = this.list.filter((s) => {
      const kind = s.active === 'failed' ? 'failed' : s.active === 'active' ? 'running' : 'stopped';
      if (this.filter !== 'all' && kind !== this.filter) return false;
      return !this.query || s.unit.toLowerCase().includes(this.query) || s.description.toLowerCase().includes(this.query);
    });
    if (!shown.length) {
      clear(this.rows, emptyState('search', 'Hech narsa topilmadi', this.query ? `“${this.query}” bo‘yicha xizmat yo‘q.` : null));
      return;
    }
    clear(this.rows, shown.map((s) => this.row(s)));
  }

  row(s) {
    const name = s.unit.replace(/\.service$/, '');
    const state = s.active === 'failed' ? 'bad' : s.active === 'active' ? 'ok' : s.active === 'activating' || s.active === 'deactivating' ? 'warn' : 'off';
    const busy = this.busy.has(s.unit);
    const running = s.active === 'active' || s.active === 'activating';
    return h(
      'div',
      { class: `sy-row ${state}` },
      h('span', { class: `sy-dot ${state}` }),
      h('div', { class: 'sy-main' }, h('div', { class: 'sy-name mono' }, name), s.description && h('div', { class: 'sy-desc' }, s.description)),
      h('span', { class: `sy-badge ${state}`, 'data-tip': `${s.active} / ${s.sub}` }, SUB[s.sub] || s.sub),
      s.enabled && h('span', { class: 'sy-meta sy-enabled', 'data-tip': 'Server yonganda o‘zi ishga tushadimi' }, s.enabled === 'enabled' ? 'avtomatik' : s.enabled === 'disabled' ? 'qo‘lda' : s.enabled),
      h(
        'div',
        { class: 'sy-actions' },
        busy && h('span', { class: 'spinner' }),
        miniKey('logs', 'Loglar', () => this.view.show('logs', { source: { kind: 'unit', unit: s.unit, label: name } }), { cls: 'key-gray' }),
        miniKey('refresh', null, () => this.act(s, 'restart'), { tip: 'Qayta ishga tushirish', cls: 'key-icon-sm' }),
        running ? miniKey('stop', null, () => this.act(s, 'stop'), { tip: 'To‘xtatish', cls: 'key-icon-sm' }) : miniKey('play', null, () => this.act(s, 'start'), { tip: 'Ishga tushirish', cls: 'key-icon-sm key-signal' }),
      ),
    );
  }

  async act(s, action) {
    const name = s.unit.replace(/\.service$/, '');
    if (action !== 'start') {
      const ssh = /^(ssh|sshd|openssh-server)\.service$/.test(s.unit);
      const ok = await confirmDialog({
        title: action === 'stop' ? `${name} to‘xtatilsinmi?` : `${name} qayta ishga tushirilsinmi?`,
        message: ssh
          ? 'Bu SSH xizmati — Pult aynan u orqali ulangan. To‘xtatilsa yoki ishga tushmay qolsa, serverga ulanib bo‘lmay qolishi mumkin.'
          : action === 'stop'
            ? 'Xizmat to‘xtaydi va undan foydalanayotganlar uzilib qoladi.'
            : 'Xizmat bir necha soniya ishlamay turadi.',
        confirm: action === 'stop' ? 'To‘xtatish' : 'Qayta ishga tushirish',
        danger: action === 'stop' || ssh,
      });
      if (!ok) return;
    }
    this.busy.add(s.unit);
    this.render();
    try {
      await call('sys:service', this.view.connId, s.unit, action);
      toast(action === 'stop' ? `${name} to‘xtatildi` : action === 'start' ? `${name} ishga tushdi` : `${name} qayta ishga tushdi`, 'ok');
    } catch (err) {
      toast(err.message, 'err', 6000);
    } finally {
      this.busy.delete(s.unit);
    }
    await this.load();
  }
}

/* ---------------- Docker ---------------- */

class DockerPane {
  constructor(view) {
    this.view = view;
    this.list = null;
    this.stats = {};
    this.error = null;
    this.busy = new Set();
    this.query = '';
    this.search = h('input', { class: 'input sy-search', placeholder: 'Konteynerni qidirish…', spellcheck: 'false', oninput: debounce(() => ((this.query = this.search.value.trim().toLowerCase()), this.render()), 120) });
    this.summary = h('div', { class: 'sy-summary' });
    this.rows = h('div', { class: 'sy-list' });
    this.el = h(
      'div',
      { class: 'sy-pane' },
      h('div', { class: 'sy-bar' }, h('label', { class: 'sy-search-wrap' }, icon('search', 15), this.search), h('div', { class: 'grow' }), this.summary, miniKey('refresh', null, () => this.load(), { tip: 'Yangilash', cls: 'key-gray key-icon-sm' })),
      this.rows,
    );
  }

  show() {
    if (!this.list && !this.loading) this.load();
    clearInterval(this.timer);
    // Container CPU / RAM while you look at them.
    this.timer = setInterval(() => this.loadStats(), 15000);
  }

  hide() {
    clearInterval(this.timer);
  }

  dispose() {
    clearInterval(this.timer);
  }

  onReady() {
    if (!this.list) this.load();
  }

  async load() {
    if (!this.view.ready) {
      clear(this.rows, emptyState('alert', 'Server bilan aloqa yo‘q', 'Ulanish tiklanganda ro‘yxat o‘zi yangilanadi.'));
      return;
    }
    this.loading = true;
    if (!this.list) clear(this.rows, loading('Konteynerlar olinmoqda…'));
    try {
      this.list = await call('sys:containers', this.view.connId);
      this.error = null;
    } catch (err) {
      this.error = err;
      this.list = null;
    } finally {
      this.loading = false;
    }
    this.render();
    if (this.list?.some((c) => c.state === 'running')) this.loadStats();
  }

  async loadStats() {
    if (!this.view.ready || !this.list || this.view.tab !== 'docker') return;
    try {
      this.stats = await call('sys:containerStats', this.view.connId);
      this.render();
    } catch {
      // stats are a bonus
    }
  }

  render() {
    if (this.error) {
      const none = this.error.code === 'NO_DOCKER';
      clear(this.rows, emptyState(none ? 'box' : 'alert', none ? 'Docker o‘rnatilmagan' : 'Docker’ga ulanib bo‘lmadi', this.error.message));
      clear(this.summary);
      return;
    }
    if (!this.list) return;
    const running = this.list.filter((c) => c.state === 'running').length;
    const stopped = this.list.length - running;
    clear(this.summary, h('span', null, `${running} ta ishlayapti${stopped ? ` · ${stopped} ta to‘xtagan` : ''}`));
    const shown = this.list.filter((c) => !this.query || `${c.name} ${c.image}`.toLowerCase().includes(this.query));
    if (!this.list.length) {
      clear(this.rows, emptyState('box', 'Konteyner yo‘q', 'Bu serverda hali birorta Docker konteyner yaratilmagan.'));
      return;
    }
    if (!shown.length) {
      clear(this.rows, emptyState('search', 'Hech narsa topilmadi', null));
      return;
    }
    clear(this.rows, shown.map((c) => this.row(c)));
  }

  row(c) {
    const st = this.stats[c.id];
    const state = c.state === 'running' ? (/unhealthy/i.test(c.status) ? 'warn' : 'ok') : c.state === 'restarting' ? 'warn' : /exited \((?!0\))/i.test(c.status) ? 'bad' : 'off';
    const running = c.state === 'running' || c.state === 'restarting';
    return h(
      'div',
      { class: `sy-row ${state}` },
      h('span', { class: `sy-dot ${state}` }),
      h('div', { class: 'sy-main' }, h('div', { class: 'sy-name' }, c.name), h('div', { class: 'sy-desc mono' }, c.image)),
      h('div', { class: 'sy-col' }, h('div', { class: 'sy-status' }, c.status), c.ports && h('div', { class: 'sy-ports mono', 'data-tip': c.ports }, shortPorts(c.ports))),
      st && running ? h('div', { class: 'sy-res' }, h('span', { class: 'sy-res-n' }, st.cpu), h('span', { class: 'sy-res-n' }, st.mem)) : h('div', { class: 'sy-res' }),
      h(
        'div',
        { class: 'sy-actions' },
        this.busy.has(c.id) && h('span', { class: 'spinner' }),
        miniKey('logs', 'Loglar', () => this.view.show('logs', { source: { kind: 'docker', id: c.name || c.id, label: c.name } }), { cls: 'key-gray' }),
        miniKey('refresh', null, () => this.act(c, 'restart'), { tip: 'Qayta ishga tushirish', cls: 'key-icon-sm' }),
        running ? miniKey('stop', null, () => this.act(c, 'stop'), { tip: 'To‘xtatish', cls: 'key-icon-sm' }) : miniKey('play', null, () => this.act(c, 'start'), { tip: 'Ishga tushirish', cls: 'key-icon-sm key-signal' }),
      ),
    );
  }

  async act(c, action) {
    if (action !== 'start') {
      const ok = await confirmDialog({
        title: action === 'stop' ? `${c.name} to‘xtatilsinmi?` : `${c.name} qayta ishga tushirilsinmi?`,
        message: action === 'stop' ? 'Konteyner to‘xtaydi; uning xizmati ishlamay qoladi.' : 'Konteyner bir necha soniya ishlamay turadi.',
        confirm: action === 'stop' ? 'To‘xtatish' : 'Qayta ishga tushirish',
        danger: action === 'stop',
      });
      if (!ok) return;
    }
    this.busy.add(c.id);
    this.render();
    try {
      await call('sys:container', this.view.connId, c.name || c.id, action);
      toast(action === 'stop' ? `${c.name} to‘xtatildi` : action === 'start' ? `${c.name} ishga tushdi` : `${c.name} qayta ishga tushdi`, 'ok');
    } catch (err) {
      toast(err.message, 'err', 6000);
    } finally {
      this.busy.delete(c.id);
    }
    await this.load();
  }
}

/** "0.0.0.0:80->80/tcp, :::80->80/tcp" → "80, 443" (published host ports). */
function shortPorts(ports) {
  const host = new Set();
  for (const m of String(ports).matchAll(/:(\d+)->/g)) host.add(m[1]);
  if (host.size) return [...host].join(', ');
  return String(ports).replace(/\/tcp/g, '').slice(0, 40);
}

/* ---------------- logs ---------------- */

const PRESETS = [
  { kind: 'journal', label: 'Tizim jurnali (journalctl)' },
  { kind: 'file', path: '/var/log/syslog', label: '/var/log/syslog' },
  { kind: 'file', path: '/var/log/auth.log', label: '/var/log/auth.log — kirishlar' },
  { kind: 'file', path: '/var/log/nginx/error.log', label: 'nginx — xatolar' },
  { kind: 'file', path: '/var/log/nginx/access.log', label: 'nginx — so‘rovlar' },
];
const MAX_LINES = 5000;
const ERR_RE = /\b(error|err|fatal|panic|exception|failed|failure|critical|crit|emerg|alert|denied|refused|traceback|segfault|oom)\b/i;
const WARN_RE = /\b(warn|warning|deprecated|timeout|timed out|retry)\b/i;
const STAMP_RE = /^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?|[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d)\s/;

function sourceLabel(src) {
  if (!src) return '';
  if (src.label) return src.label;
  if (src.kind === 'journal') return 'Tizim jurnali';
  if (src.kind === 'unit') return src.unit.replace(/\.service$/, '');
  if (src.kind === 'docker') return src.id;
  return src.path;
}

class LogsPane {
  constructor(view) {
    wire();
    this.view = view;
    this.source = null;
    this.streamId = null;
    this.lines = [];
    this.pending = []; // while paused
    this.paused = false;
    this.wrap = true;
    this.ended = false;
    this.query = '';
    this.unseen = 0;
    this.recent = [];

    this.srcBtn = h('button', { class: 'key key-sm sy-src', type: 'button', onclick: (e) => this.pickSource(e.currentTarget) }, icon('logs', 14), h('span', { class: 'sy-src-label' }, 'Manbani tanlang'), icon('chevronDown', 12));
    this.search = h('input', { class: 'input sy-search', placeholder: 'Filtr (masalan, error)', spellcheck: 'false', oninput: debounce(() => ((this.query = this.search.value.trim()), this.renderAll()), 150) });
    this.pauseBtn = miniKey('pause', 'Pauza', () => this.togglePause(), { cls: 'key-gray' });
    this.wrapBtn = miniKey('wrap', null, () => this.toggleWrap(), { tip: 'Uzun qatorlarni o‘rash', cls: 'key-icon-sm on' });
    this.state = h('div', { class: 'sy-live' });
    this.screen = h('div', { class: 'sy-log wrap', tabindex: '0' });
    this.more = h('button', { class: 'sy-more', type: 'button', hidden: true, onclick: () => this.toBottom() }, icon('arrowDown', 13), h('span'));
    this.screen.addEventListener('scroll', () => {
      if (this.atBottom()) {
        this.unseen = 0;
        this.more.hidden = true;
      }
    });
    this.el = h(
      'div',
      { class: 'sy-pane' },
      h(
        'div',
        { class: 'sy-bar' },
        this.srcBtn,
        h('label', { class: 'sy-search-wrap' }, icon('filter', 15), this.search),
        this.pauseBtn,
        this.wrapBtn,
        miniKey('trash', null, () => this.clearLines(), { tip: 'Ekranni tozalash', cls: 'key-icon-sm' }),
        h('div', { class: 'grow' }),
        this.state,
      ),
      h('div', { class: 'sy-log-wrap' }, this.screen, this.more),
    );
    this.renderEmpty();
  }

  show({ source } = {}) {
    if (source) this.open(source);
    else if (!this.source) this.renderEmpty();
    else if (this.ended && this.view.ready) this.open(this.source);
  }

  onReady() {
    if (this.source && this.ended) this.open(this.source); // the link came back
  }

  dispose() {
    this.stop();
  }

  renderEmpty() {
    clear(
      this.screen,
      h(
        'div',
        { class: 'sy-log-empty' },
        h('div', { class: 'sy-log-empty-title' }, 'Qaysi logni kuzatamiz?'),
        h('div', { class: 'sy-log-presets' }, PRESETS.map((p) => h('button', { class: 'key key-sm', type: 'button', onclick: () => this.open(p) }, p.label))),
        h('div', { class: 'sy-log-hint' }, 'Xizmat yoki konteyner logini «Xizmatlar» va «Docker» bo‘limlarida, faylnikini «Fayllar»da o‘ng tugma bilan ochasiz.'),
      ),
    );
  }

  pickSource(anchor) {
    const r = anchor.getBoundingClientRect();
    const same = (a, b) => JSON.stringify({ ...a, label: 0 }) === JSON.stringify({ ...b, label: 0 });
    const recent = this.recent.filter((s) => !PRESETS.some((p) => same(p, s)));
    menu(r.left, r.bottom + 4, [
      ...PRESETS.map((p) => ({ label: p.label, icon: p.kind === 'journal' ? 'server' : 'file', onClick: () => this.open(p) })),
      recent.length ? '-' : null,
      ...recent.map((s) => ({ label: sourceLabel(s), icon: s.kind === 'docker' ? 'box' : s.kind === 'unit' ? 'cog' : 'file', onClick: () => this.open(s) })),
      '-',
      {
        label: 'Fayl yo‘lini kiritish…',
        icon: 'pencil',
        onClick: async () => {
          const path = await inputDialog({ title: 'Log fayli', label: 'Serverdagi to‘liq yo‘l', placeholder: '/var/log/…', confirm: 'Kuzatish', validate: (v) => (v.startsWith('/') ? null : 'Yo‘l / bilan boshlansin') });
          if (path) this.open({ kind: 'file', path });
        },
      },
    ].filter((x) => x !== null));
  }

  async open(source) {
    this.stop();
    this.source = source;
    this.recent = [source, ...this.recent.filter((s) => JSON.stringify(s) !== JSON.stringify(source))].slice(0, 6);
    this.srcBtn.querySelector('.sy-src-label').textContent = sourceLabel(source);
    this.lines = [];
    this.pending = [];
    this.partial = '';
    this.unseen = 0;
    this.ended = false;
    this.more.hidden = true;
    clear(this.screen);
    if (!this.view.ready) {
      this.ended = true;
      this.setState('Server bilan aloqa yo‘q');
      return;
    }
    this.setState('ulanmoqda…');
    const my = (this.openSeq = (this.openSeq || 0) + 1);
    try {
      const id = await call('logs:open', this.view.connId, source);
      if (my !== this.openSeq) {
        call('logs:close', id).catch(() => {});
        return;
      }
      this.streamId = id;
      streams.set(id, { data: (text) => this.data(text), end: (code) => this.end(code) });
      this.setState(null);
    } catch (err) {
      this.ended = true;
      this.setState(err.message, true);
    }
  }

  stop() {
    if (this.streamId) {
      streams.delete(this.streamId);
      call('logs:close', this.streamId).catch(() => {});
      this.streamId = null;
    }
  }

  data(text) {
    const parts = (this.partial + text.replace(/\r/g, '')).split('\n');
    this.partial = parts.pop();
    if (!parts.length) return;
    if (this.paused) {
      this.pending.push(...parts);
      this.setState(null);
      return;
    }
    this.append(parts);
  }

  end(code) {
    this.streamId = null;
    this.ended = true;
    if (this.partial) this.append([this.partial]);
    this.partial = '';
    this.setState(this.view.ready ? `oqim tugadi${code ? ` (kod ${code})` : ''}` : 'aloqa uzildi — qayta ulanganda davom etadi', !this.view.ready);
  }

  append(newLines) {
    const follow = this.atBottom();
    this.lines.push(...newLines);
    let dropped = 0;
    if (this.lines.length > MAX_LINES) {
      dropped = this.lines.length - MAX_LINES;
      this.lines.splice(0, dropped);
    }
    const frag = document.createDocumentFragment();
    let added = 0;
    for (const l of newLines) {
      const el = this.lineEl(l);
      if (el) {
        frag.append(el);
        added += 1;
      }
    }
    this.screen.append(frag);
    while (dropped-- > 0 && this.screen.firstChild) this.screen.firstChild.remove();
    if (follow) this.toBottom();
    else if (added) {
      this.unseen += added;
      this.more.hidden = false;
      this.more.lastChild.textContent = `${this.unseen} ta yangi qator`;
    }
    this.setState(null);
  }

  lineEl(line) {
    if (this.query && !this.matches(line)) return null;
    const cls = ERR_RE.test(line) ? 'err' : WARN_RE.test(line) ? 'warn' : '';
    const m = line.match(STAMP_RE);
    const el = h('div', { class: `sy-line ${cls}` });
    if (m) {
      el.append(h('span', { class: 'sy-stamp' }, m[1]), ' ');
      this.mark(el, line.slice(m[0].length));
    } else this.mark(el, line);
    return el;
  }

  matches(line) {
    return line.toLowerCase().includes(this.query.toLowerCase());
  }

  /** The line's text with the filter word highlighted. */
  mark(el, text) {
    if (!this.query) {
      el.append(text);
      return;
    }
    const low = text.toLowerCase();
    const q = this.query.toLowerCase();
    let i = 0;
    for (let j = low.indexOf(q); j >= 0; j = low.indexOf(q, i)) {
      el.append(text.slice(i, j), h('mark', null, text.slice(j, j + q.length)));
      i = j + q.length;
    }
    el.append(text.slice(i));
  }

  renderAll() {
    if (!this.source) return;
    const frag = document.createDocumentFragment();
    for (const l of this.lines) {
      const el = this.lineEl(l);
      if (el) frag.append(el);
    }
    clear(this.screen, frag);
    this.toBottom();
    this.setState(null);
  }

  atBottom() {
    return this.screen.scrollHeight - this.screen.scrollTop - this.screen.clientHeight < 30;
  }

  toBottom() {
    this.screen.scrollTop = this.screen.scrollHeight;
    this.unseen = 0;
    this.more.hidden = true;
  }

  togglePause() {
    this.paused = !this.paused;
    clear(this.pauseBtn, icon(this.paused ? 'play' : 'pause', 14), h('span', null, this.paused ? 'Davom etish' : 'Pauza'));
    this.pauseBtn.classList.toggle('key-signal', this.paused);
    if (!this.paused && this.pending.length) {
      const p = this.pending;
      this.pending = [];
      this.append(p);
    }
    this.setState(null);
  }

  toggleWrap() {
    this.wrap = !this.wrap;
    this.screen.classList.toggle('wrap', this.wrap);
    this.wrapBtn.classList.toggle('on', this.wrap);
  }

  clearLines() {
    this.lines = [];
    this.pending = [];
    clear(this.screen);
    this.setState(null);
  }

  setState(text, bad = false) {
    if (text) {
      clear(this.state, h('span', { class: `sy-live-dot ${bad ? 'bad' : 'off'}` }), h('span', null, text));
      return;
    }
    if (!this.source) {
      clear(this.state);
      return;
    }
    const shown = this.query ? this.screen.childElementCount : this.lines.length;
    const what = this.paused ? `pauza${this.pending.length ? ` · ${this.pending.length} ta kutmoqda` : ''}` : this.ended ? 'tugadi' : 'jonli';
    clear(this.state, h('span', { class: `sy-live-dot ${this.paused || this.ended ? 'off' : ''}` }), h('span', null, `${what} · ${shown.toLocaleString('ru-RU')} qator`));
  }
}

/* ---------------- disk ---------------- */

class DiskPane {
  constructor(view) {
    this.view = view;
    this.mounts = null;
    this.dir = '/';
    this.cache = new Map(); // dir → { dir, total, items, at }
    this.big = new Map(); // dir → files
    this.mountsEl = h('div', { class: 'sy-mounts' });
    this.crumbs = h('div', { class: 'sy-crumbs' });
    this.usageEl = h('div', { class: 'sy-usage' });
    this.bigEl = h('div', { class: 'sy-big' });
    this.el = h(
      'div',
      { class: 'sy-pane sy-scroll' },
      h('div', { class: 'sy-section' }, h('div', { class: 'sy-h' }, h('span', null, 'Disklar'), h('div', { class: 'grow' }), miniKey('refresh', null, () => this.refresh(), { tip: 'Yangilash', cls: 'key-gray key-icon-sm' })), this.mountsEl),
      h(
        'div',
        { class: 'sy-section' },
        h('div', { class: 'sy-h' }, h('span', null, 'Joy nimaga ketgan'), h('div', { class: 'grow' }), miniKey('folder', 'Fayllarda ochish', () => this.view.session.openFilesAt(this.dir), { cls: 'key-gray' })),
        this.crumbs,
        this.usageEl,
      ),
      h('div', { class: 'sy-section' }, h('div', { class: 'sy-h' }, h('span', null, 'Eng katta fayllar'), h('span', { class: 'sy-h-note' }, '100 MB dan kattalari')), this.bigEl),
    );
  }

  show({ dir } = {}) {
    if (dir) this.dir = dir;
    if (!this.mounts) this.loadMounts();
    this.loadUsage(this.dir);
    this.renderBig();
  }

  onReady() {
    if (!this.mounts) this.loadMounts();
  }

  refresh() {
    this.cache.delete(this.dir);
    this.big.delete(this.dir);
    this.mounts = null;
    this.loadMounts();
    this.loadUsage(this.dir);
    this.renderBig();
  }

  async loadMounts() {
    if (!this.view.ready) return;
    clear(this.mountsEl, loading('Disklar olinmoqda…'));
    try {
      this.mounts = await call('sys:mounts', this.view.connId);
      this.renderMounts();
    } catch (err) {
      clear(this.mountsEl, h('div', { class: 'sy-note bad' }, err.message));
    }
  }

  renderMounts() {
    clear(
      this.mountsEl,
      this.mounts.map((m) => {
        const p = pct(m.used, m.used + m.avail);
        return h(
          'button',
          { class: `sy-mount ${this.dir.startsWith(m.mount) && (m.mount !== '/' || !this.mounts.some((x) => x.mount !== '/' && this.dir.startsWith(x.mount))) ? 'on' : ''}`, type: 'button', onclick: () => this.go(m.mount) },
          h('div', { class: 'sy-mount-top' }, h('span', { class: 'sy-name mono' }, m.mount), h('span', { class: 'sy-meta' }, `${m.type} · ${m.fs}`), h('div', { class: 'grow' }), h('span', { class: `sy-pct ${tone(p)}` }, `${p}%`)),
          h('div', { class: 'sy-bar-track' }, h('div', { class: `sy-bar-fill ${tone(p)}`, style: `width:${Math.max(1, p)}%` })),
          h('div', { class: 'sy-mount-sub' }, `${fmt.bytes(m.used)} band · ${fmt.bytes(m.avail)} bo‘sh · jami ${fmt.bytes(m.size)}`),
        );
      }),
    );
  }

  go(dir) {
    this.dir = dir;
    if (this.mounts) this.renderMounts();
    this.loadUsage(dir);
    this.renderBig();
  }

  renderCrumbs() {
    const parts = this.dir.split('/').filter(Boolean);
    const keys = [h('button', { class: `crumb ${parts.length ? '' : 'current'}`, type: 'button', onclick: () => this.go('/') }, '/')];
    let acc = '';
    parts.forEach((p, i) => {
      acc += `/${p}`;
      const target = acc;
      keys.push(h('span', { class: 'crumb-sep' }, '/'), h('button', { class: `crumb ${i === parts.length - 1 ? 'current' : ''}`, type: 'button', onclick: () => this.go(target) }, p));
    });
    clear(this.crumbs, keys);
  }

  async loadUsage(dir) {
    this.renderCrumbs();
    const known = this.cache.get(dir);
    if (known) {
      this.renderUsage(known);
      return;
    }
    if (!this.view.ready) {
      clear(this.usageEl, h('div', { class: 'sy-note' }, 'Server bilan aloqa yo‘q'));
      return;
    }
    clear(this.usageEl, loading('Hisoblanmoqda… Katta papkalarda bir-ikki daqiqa olishi mumkin.'));
    try {
      const r = await call('sys:usage', this.view.connId, dir);
      this.cache.set(dir, r);
      if (this.dir === dir) this.renderUsage(r);
    } catch (err) {
      if (this.dir === dir) clear(this.usageEl, h('div', { class: 'sy-note bad' }, err.message));
    }
  }

  renderUsage(r) {
    if (!r.items.length) {
      clear(this.usageEl, h('div', { class: 'sy-note' }, 'Bu papka bo‘sh (yoki o‘qishga ruxsat yo‘q).'));
      return;
    }
    const top = r.items[0].bytes || 1;
    const up = this.dir !== '/' && h('button', { class: 'sy-du up', type: 'button', onclick: () => this.go(this.dir.replace(/\/[^/]+$/, '') || '/') }, h('span', { class: 'sy-du-name' }, icon('up', 14), '..'));
    clear(
      this.usageEl,
      h('div', { class: 'sy-du-total' }, `Jami: ${fmt.bytes(r.total)}`, h('span', { class: 'sy-meta' }, ' · faqat shu disk, eng kattalari tepada')),
      up,
      r.items.slice(0, 60).map((it) =>
        h(
          it.dir ? 'button' : 'div',
          { class: `sy-du ${it.dir ? 'dir' : 'file'}`, type: it.dir ? 'button' : null, onclick: it.dir ? () => this.go(it.path) : null, 'data-tip': it.path },
          h('div', { class: 'sy-du-bar', style: `width:${Math.max(0.5, (it.bytes / top) * 100)}%` }),
          h('span', { class: 'sy-du-name' }, icon(it.dir ? 'folder' : 'file', 14), h('span', null, it.name)),
          h('span', { class: 'sy-du-size' }, fmt.bytes(it.bytes)),
          h('span', { class: 'sy-du-pct' }, `${pct(it.bytes, r.total)}%`),
          it.dir && icon('chevronRight', 14),
        ),
      ),
    );
  }

  renderBig() {
    const dir = this.dir;
    const files = this.big.get(dir);
    if (files === undefined) {
      clear(this.bigEl, h('div', { class: 'sy-big-ask' }, h('span', { class: 'sy-meta' }, `${dir} ichida 100 MB dan katta fayllarni qidirish (bir oz vaqt oladi).`), miniKey('search', 'Qidirish', () => this.loadBig(dir), { cls: 'key-gray' })));
      return;
    }
    if (files === null) {
      clear(this.bigEl, loading('Qidirilmoqda…'));
      return;
    }
    if (!files.length) {
      clear(this.bigEl, h('div', { class: 'sy-note' }, 'Bu yerda 100 MB dan katta fayl yo‘q.'));
      return;
    }
    clear(
      this.bigEl,
      files.map((f) =>
        h(
          'div',
          { class: 'sy-bigrow' },
          h('span', { class: 'sy-big-size' }, fmt.bytes(f.bytes)),
          h('span', { class: 'sy-big-path mono', 'data-tip': f.path }, f.path),
          h('span', { class: 'sy-meta' }, f.mtime ? fmt.ago(f.mtime) : ''),
          miniKey('folder', null, () => this.view.session.openFilesAt(f.path.replace(/\/[^/]+$/, '') || '/', f.path.split('/').pop()), { tip: 'Fayllarda ko‘rsatish', cls: 'key-icon-sm' }),
        ),
      ),
    );
  }

  async loadBig(dir) {
    this.big.set(dir, null);
    this.renderBig();
    try {
      const files = await call('sys:bigFiles', this.view.connId, dir);
      this.big.set(dir, files);
    } catch (err) {
      this.big.delete(dir);
      toast(err.message, 'err');
    }
    if (this.dir === dir) this.renderBig();
  }
}

/* ---------------- a long job's live output (apt; see jobStart in system.js) ---------------- */

/** Follows ~/.pult/jobs/<id>.log until its "PULT_EXIT=<code>" line. */
class JobConsole {
  constructor(view, { title, onDone }) {
    wire();
    this.view = view;
    this.onDone = onDone;
    this.titleEl = h('span', { class: 'jc-title' }, title || 'Jarayon');
    this.state = h('span', { class: 'jc-state' });
    this.screen = h('div', { class: 'sy-log wrap jc-screen' });
    this.el = h('div', { class: 'jc' }, h('div', { class: 'jc-head' }, this.titleEl, h('div', { class: 'grow' }), this.state), h('div', { class: 'sy-log-wrap jc-wrap' }, this.screen));
    this.partial = '';
    this.done = false;
  }

  async follow(log, title) {
    if (title) this.titleEl.textContent = title;
    this.stop();
    this.log = log;
    this.done = false;
    this.partial = '';
    clear(this.screen);
    this.setState('ishlayapti…');
    try {
      const id = await call('logs:open', this.view.connId, { kind: 'job', path: log });
      this.streamId = id;
      streams.set(id, {
        data: (text) => this.data(text),
        // The link dropped: the job goes on on the server; follow it again when back.
        end: () => {
          this.streamId = null;
          if (!this.done) this.setState('aloqa uzildi — jarayon serverda davom etmoqda');
        },
      });
    } catch (err) {
      this.setState(err.message, 'bad');
    }
  }

  data(text) {
    const parts = (this.partial + text.replace(/\r/g, '\n')).split('\n');
    this.partial = parts.pop();
    const follow = this.screen.scrollHeight - this.screen.scrollTop - this.screen.clientHeight < 40;
    for (const line of parts) {
      const end = line.match(/^PULT_EXIT=(\d+)$/);
      if (end) {
        this.finish(Number(end[1]));
        continue;
      }
      if (!line.trim()) continue;
      const cls = /^(E:|Err:|dpkg: error)/.test(line) ? 'err' : /^W:/.test(line) ? 'warn' : '';
      this.screen.append(h('div', { class: `sy-line ${cls}` }, line));
    }
    if (follow) this.screen.scrollTop = this.screen.scrollHeight;
  }

  finish(code) {
    this.done = true;
    this.stop();
    this.setState(code === 0 ? 'tugadi' : `xato bilan tugadi (kod ${code})`, code === 0 ? 'ok' : 'bad');
    this.onDone?.(code);
  }

  setState(text, tone = '') {
    clear(this.state, h('span', { class: `sy-live-dot ${tone === 'ok' ? 'off' : tone === 'bad' ? 'bad' : ''}` }), text);
  }

  stop() {
    if (this.streamId) {
      streams.delete(this.streamId);
      call('logs:close', this.streamId).catch(() => {});
      this.streamId = null;
    }
  }
}

/* ---------------- security check ---------------- */

const AUTH_LABEL = { password: 'parol', publickey: 'kalit', 'keyboard-interactive': 'parol' };

class SecurityPane {
  constructor(view) {
    this.view = view;
    this.data = null;
    this.busy = null; // a fix in progress
    this.summary = h('div', { class: 'sy-summary' });
    this.list = h('div', { class: 'sy-scroll sec-list' });
    this.job = new JobConsole(view, { onDone: () => setTimeout(() => this.load(), 800) });
    this.job.el.hidden = true;
    this.el = h(
      'div',
      { class: 'sy-pane' },
      h('div', { class: 'sy-bar' }, h('div', { class: 'sec-os' }), this.summary, h('div', { class: 'grow' }), miniKey('refresh', 'Qayta tekshirish', () => this.load(), { cls: 'key-gray' })),
      this.job.el,
      this.list,
    );
  }

  show() {
    if (!this.data && !this.loading) this.load();
  }

  onReady() {
    if (this.job.log && !this.job.done && !this.job.streamId) this.job.follow(this.job.log);
    if (!this.data) this.load();
  }

  async load() {
    if (!this.view.ready) {
      clear(this.list, emptyState('alert', 'Server bilan aloqa yo‘q', null));
      return;
    }
    this.loading = true;
    if (!this.data) clear(this.list, loading('Server tekshirilmoqda…'));
    try {
      this.data = await call('sys:security', this.view.connId);
      this.render();
    } catch (err) {
      clear(this.list, emptyState('alert', 'Tekshirib bo‘lmadi', err.message));
    } finally {
      this.loading = false;
    }
  }

  /** The facts from the server → checks: { tone: bad|warn|ok|info, title, text, details, actions }. */
  checks() {
    const d = this.data;
    const out = [];
    const viaPassword = d.auth === 'password';
    const keysOnlyTip = viaPassword ? 'Pult bu serverga parol bilan ulangan: avval kalit bilan ulanishni sozlang (Server sozlamalari)' : null;
    const canRoot = d.root || d.sudo;
    const undo = d.pultDropin && { label: 'Pult o‘zgartirishini bekor qilish', fix: 'ssh-undo', plain: true };

    if (!d.sshd) {
      out.push({ tone: 'info', title: 'SSH sozlamalari', text: canRoot ? 'sshd sozlamasini o‘qib bo‘lmadi.' : 'Ko‘rish uchun root yoki parolsiz sudo kerak.' });
    } else {
      const pw = d.sshd.passwordauthentication;
      out.push(
        pw === 'no'
          ? { tone: 'ok', title: 'SSH: parol bilan kirish o‘chirilgan', text: 'Serverga faqat SSH kalit bilan kiriladi — parolni taxmin qilish befoyda.', actions: [undo].filter(Boolean) }
          : {
              tone: 'warn',
              title: 'SSH: parol bilan kirish yoqilgan',
              text: 'Botlar parolni taxmin qilishga urinadi. SSH kalit bilan kirish ancha xavfsiz.',
              actions: [{ label: 'Parol bilan kirishni o‘chirish', fix: 'ssh-password-off', disabled: viaPassword || !canRoot, tip: keysOnlyTip || (!canRoot ? 'root yoki parolsiz sudo kerak' : null) }, undo].filter(Boolean),
            },
      );
      const root = d.sshd.permitrootlogin;
      out.push(
        root === 'yes'
          ? {
              tone: pw === 'no' ? 'warn' : 'bad',
              title: 'SSH: root parol bilan ham kira oladi',
              text: 'root — hujumchilar birinchi urinadigan foydalanuvchi. Uni faqat kalit bilan qoldirish tavsiya etiladi.',
              actions: [{ label: 'root’ga faqat kalit bilan', fix: 'ssh-root-keys', disabled: viaPassword || !canRoot, tip: keysOnlyTip || (!canRoot ? 'root yoki parolsiz sudo kerak' : null) }],
            }
          : { tone: 'ok', title: root === 'no' ? 'SSH: root kira olmaydi' : 'SSH: root faqat kalit bilan kiradi', text: `PermitRootLogin ${root}` },
      );
      if (d.sshd.permitemptypasswords === 'yes') out.push({ tone: 'bad', title: 'SSH: bo‘sh parol bilan kirish mumkin', text: 'PermitEmptyPasswords yes — darhol o‘chirish kerak.' });
    }

    if (!d.f2b.installed) {
      out.push({ tone: 'warn', title: 'Fail2ban o‘rnatilmagan', text: 'Fail2ban parolni taxmin qilayotgan IP manzillarni avtomatik bloklaydi.', actions: [{ label: 'O‘rnatish', job: 'fail2ban', disabled: !canRoot, tip: !canRoot ? 'root yoki parolsiz sudo kerak' : null }] });
    } else if (!d.f2b.active) {
      out.push({ tone: 'bad', title: 'Fail2ban to‘xtagan', text: 'O‘rnatilgan, lekin ishlamayapti.', actions: [{ label: 'Ishga tushirish', service: 'fail2ban.service' }] });
    } else {
      out.push({ tone: 'ok', title: 'Fail2ban ishlayapti', text: `Hozir ${d.f2b.banned} ta IP bloklangan, jami ${d.f2b.totalBanned} ta bloklangan.` });
    }

    const f = d.fails;
    if (f.total > 0) {
      out.push({
        tone: d.f2b.active ? 'info' : 'warn',
        title: `Kirishga urinishlar (24 soat): ${f.total.toLocaleString('ru-RU')} ta`,
        text: d.f2b.active ? 'Ko‘pchiligi botlar; fail2ban ularni bloklayapti.' : 'Bularning hammasi muvaffaqiyatsiz urinishlar. Fail2ban va kalit bilan kirish ularni befoyda qiladi.',
        details: h(
          'div',
          { class: 'sec-cols' },
          h('div', null, h('div', { class: 'sec-sub' }, 'Eng ko‘p uringan IP manzillar'), f.byIp.map((x) => h('div', { class: 'sec-kv mono' }, h('span', null, x.ip), h('b', null, x.n.toLocaleString('ru-RU'))))),
          h('div', null, h('div', { class: 'sec-sub' }, 'Taxmin qilingan foydalanuvchilar'), f.byUser.map((x) => h('div', { class: 'sec-kv mono' }, h('span', null, x.user), h('b', null, x.n.toLocaleString('ru-RU'))))),
        ),
      });
    } else if (f.source) {
      out.push({ tone: 'ok', title: 'Kirishga urinishlar (24 soat): yo‘q', text: 'SSH jurnalida muvaffaqiyatsiz kirish topilmadi.' });
    }

    if (d.logins.length) {
      out.push({
        tone: 'info',
        title: 'So‘nggi muvaffaqiyatli kirishlar',
        text: 'Tanimagan IP manzil bo‘lsa — darhol parol va kalitlarni almashtiring.',
        details: h(
          'div',
          { class: 'sec-logins' },
          d.logins.slice(0, 8).map((x) => h('div', { class: 'sec-kv' }, h('span', { class: 'mono' }, x.ip), h('span', null, `${x.user} · ${AUTH_LABEL[x.method] || x.method}`), h('span', { class: 'sy-meta' }, x.t ? fmt.ago(x.t) : ''))),
        ),
      });
    }

    const pub = d.listen.filter((x) => x.scope === 'public');
    const risky = pub.filter((x) => x.risk);
    out.push({
      tone: risky.length ? 'bad' : 'info',
      title: risky.length ? `Internetga ochiq xavfli port: ${risky.map((x) => x.port).join(', ')}` : `Internetga ochiq portlar: ${pub.length} ta`,
      text: risky.length
        ? `${risky.map((x) => `${x.port} — ${x.risk}`).join('; ')}. Bunday xizmatlar faqat 127.0.0.1 da tinglashi yoki firewall bilan yopilishi kerak.`
        : 'Har biri kerakligini tekshiring: kerakmasini o‘chiring yoki faqat 127.0.0.1 da tinglaydigan qiling.',
      details: h(
        'div',
        { class: 'sec-ports' },
        pub.map((x) => h('span', { class: `sec-port ${x.risk ? 'bad' : ''}`, 'data-tip': `${x.proto} · ${x.addr}` }, h('b', { class: 'mono' }, String(x.port)), x.proc || x.proto)),
      ),
    });

    if (d.ufw?.active) out.push({ tone: 'ok', title: 'Firewall (UFW) yoqilgan', text: `${d.ufw.rules} ta qoida.` });
    else if (d.ufw) out.push({ tone: 'warn', title: 'Firewall (UFW) o‘rnatilgan, lekin o‘chiq', text: 'Yoqishdan oldin SSH portiga ruxsat bering, aks holda ulanib bo‘lmay qoladi: ufw allow OpenSSH && ufw enable' });
    else if ((d.nftDrops || 0) > 0 || (d.iptablesPolicy && d.iptablesPolicy !== 'ACCEPT')) out.push({ tone: 'ok', title: 'Firewall qoidalari bor', text: 'nftables/iptables ichida bloklovchi qoidalar topildi.' });
    else out.push({ tone: 'warn', title: 'Firewall yo‘q', text: 'Serverda ochilgan har qanday port darhol internetga ham ochiq bo‘ladi.' });

    if (d.updates) {
      out.push(
        d.updates.security > 0
          ? { tone: 'warn', title: `Xavfsizlik yangilanishlari: ${d.updates.security} ta`, text: `Jami ${d.updates.total} ta paket yangilanishi kutyapti.`, actions: [{ label: 'Yangilanishlarga o‘tish', tab: 'updates' }] }
          : { tone: 'ok', title: 'Xavfsizlik yangilanishlari o‘rnatilgan', text: d.updates.total ? `${d.updates.total} ta oddiy yangilanish bor.` : 'Hamma paketlar yangi.' },
      );
      out.push(
        d.auto.enabled
          ? { tone: 'ok', title: 'Avtomatik xavfsizlik yangilanishlari yoqilgan', text: 'unattended-upgrades xavfsizlik yangilanishlarini o‘zi o‘rnatadi.' }
          : { tone: 'warn', title: 'Avtomatik xavfsizlik yangilanishlari o‘chiq', text: 'Yoqilsa, xavfsizlik tuzatishlari har kuni o‘zi o‘rnatiladi.', actions: [{ label: 'Yoqish', job: 'auto-updates', disabled: !canRoot, tip: !canRoot ? 'root yoki parolsiz sudo kerak' : null }] },
      );
    }
    if (d.reboot.required) out.push({ tone: 'warn', title: 'Qayta yuklash kerak', text: `Yangilangan: ${d.reboot.pkgs.join(', ') || 'yadro'}. Yangi yadro qayta yuklangandan keyin ishlaydi.`, actions: [{ label: 'Yangilanishlarga o‘tish', tab: 'updates' }] });
    const extraRoot = d.uid0.filter((u) => u !== 'root');
    if (extraRoot.length) out.push({ tone: 'bad', title: `root huquqli boshqa foydalanuvchi: ${extraRoot.join(', ')}`, text: 'UID 0 — root bilan bir xil huquq. O‘zingiz yaratmagan bo‘lsangiz, bu xavfli belgi.' });
    if (d.emptyPw?.length) out.push({ tone: 'bad', title: `Parolsiz foydalanuvchi: ${d.emptyPw.join(', ')}`, text: 'Bu foydalanuvchilarga parol qo‘ying yoki ularni qulflang (passwd -l).' });
    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    return out.sort((a, b) => order[a.tone] - order[b.tone]);
  }

  render() {
    const d = this.data;
    this.el.querySelector('.sec-os').textContent = d.os;
    const checks = this.checks();
    const n = (t) => checks.filter((c) => c.tone === t).length;
    clear(
      this.summary,
      n('bad') ? h('span', { class: 'sy-bad' }, icon('alert', 14), `${n('bad')} ta muammo`) : null,
      n('warn') ? h('span', { class: 'sec-warn' }, `${n('warn')} ta ogohlantirish`) : null,
      n('ok') ? h('span', null, `${n('ok')} ta joyida`) : null,
    );
    clear(this.list, checks.map((c) => this.card(c)));
  }

  card(c) {
    const mark = { bad: 'x', warn: 'alert', ok: 'check', info: 'info' }[c.tone];
    return h(
      'div',
      { class: `sec-card ${c.tone}` },
      h('div', { class: `sec-ic ${c.tone}` }, icon(mark, 15)),
      h(
        'div',
        { class: 'sec-main' },
        h('div', { class: 'sec-title' }, c.title),
        c.text && h('div', { class: 'sec-text' }, c.text),
        c.details,
        c.actions?.length > 0 &&
          h(
            'div',
            { class: 'sec-actions' },
            c.actions.map((a) =>
              h(
                'button',
                {
                  class: `key key-sm ${a.plain ? 'key-gray' : a.tab ? '' : 'key-signal'}`,
                  type: 'button',
                  disabled: a.disabled || this.busy === (a.fix || a.job),
                  'data-tip': a.tip,
                  onclick: () => this.act(a),
                },
                this.busy && this.busy === (a.fix || a.job) ? h('span', { class: 'spinner' }) : null,
                a.label,
              ),
            ),
          ),
      ),
    );
  }

  async act(a) {
    if (a.tab) return this.view.show(a.tab);
    if (a.service) {
      try {
        await call('sys:service', this.view.connId, a.service, 'start');
        toast('Ishga tushdi', 'ok');
      } catch (err) {
        toast(err.message, 'err', 6000);
      }
      return this.load();
    }
    if (a.job) {
      const ok = await confirmDialog({
        title: a.job === 'fail2ban' ? 'Fail2ban o‘rnatilsinmi?' : 'Avtomatik yangilanishlar yoqilsinmi?',
        message: 'Paket apt orqali o‘rnatiladi. Jarayon serverda alohida ishlaydi: aloqa uzilsa ham to‘xtamaydi.',
        confirm: a.job === 'fail2ban' ? 'O‘rnatish' : 'Yoqish',
      });
      if (!ok) return;
      try {
        const job = await call('sys:job', this.view.connId, a.job, []);
        this.job.el.hidden = false;
        this.job.follow(job.log, a.job === 'fail2ban' ? 'Fail2ban o‘rnatilmoqda' : 'Avtomatik yangilanishlar yoqilmoqda');
      } catch (err) {
        toast(err.message, 'err', 6000);
      }
      return;
    }
    const texts = {
      'ssh-password-off': {
        title: 'Parol bilan kirish o‘chirilsinmi?',
        message: 'Shundan keyin serverga faqat SSH kalit bilan kiriladi — bu serverga parol bilan kiradigan boshqa foydalanuvchilar ham kira olmay qoladi. Pult o‘zi kalit bilan ulangan, joriy ulanishlar uzilmaydi. Sozlama /etc/ssh/sshd_config.d/01-pult.conf faylida, “bekor qilish” bilan qaytariladi.',
        confirm: 'O‘chirish',
      },
      'ssh-root-keys': {
        title: 'root faqat kalit bilan kirsinmi?',
        message: 'root parol bilan kira olmaydi, kalit bilan esa kiradi. Joriy ulanishlar uzilmaydi. Sozlama /etc/ssh/sshd_config.d/01-pult.conf faylida, “bekor qilish” bilan qaytariladi.',
        confirm: 'Qo‘llash',
      },
      'ssh-undo': { title: 'Pult o‘zgartirishi bekor qilinsinmi?', message: 'SSH sozlamasi Pult o‘zgartirishidan oldingi holiga qaytadi.', confirm: 'Bekor qilish' },
    }[a.fix];
    if (!(await confirmDialog({ ...texts, danger: a.fix !== 'ssh-undo' }))) return;
    this.busy = a.fix;
    this.render();
    try {
      await call('sys:securityFix', this.view.connId, a.fix);
      toast('Qo‘llandi — SSH sozlamasi qayta yuklandi', 'ok');
    } catch (err) {
      toast(err.message, 'err', 8000);
    } finally {
      this.busy = null;
    }
    await this.load();
  }
}

/* ---------------- package updates (apt) ---------------- */

class UpdatesPane {
  constructor(view) {
    this.view = view;
    this.data = null;
    this.running = false;
    this.osEl = h('div', { class: 'sec-os' });
    this.stamp = h('div', { class: 'sy-meta' });
    this.top = h('div', { class: 'up-top' });
    this.list = h('div', { class: 'up-list' });
    this.job = new JobConsole(view, { onDone: (code) => this.jobDone(code) });
    this.job.el.hidden = true;
    this.el = h(
      'div',
      { class: 'sy-pane' },
      h('div', { class: 'sy-bar' }, this.osEl, this.stamp, h('div', { class: 'grow' }), miniKey('refresh', 'Ro‘yxatni yangilash', () => this.start('apt-update'), { cls: 'key-gray', tip: 'apt-get update: yangi versiyalar haqidagi ma’lumotni yuklash' })),
      h('div', { class: 'sy-scroll up-body' }, this.top, this.job.el, this.list),
    );
  }

  show() {
    if (!this.data && !this.loading) this.load();
  }

  onReady() {
    this.load(); // after a reboot: fresh state; a job that ran meanwhile shows its end
  }

  async load() {
    if (!this.view.ready) return;
    this.loading = true;
    if (!this.data) clear(this.list, loading('Yangilanishlar tekshirilmoqda…'));
    try {
      this.data = await call('sys:updates', this.view.connId);
      this.render();
      // A job still running (Pult was closed, or the link dropped while we watched): follow it
      // again — from the start of its log, so a job that ended meanwhile shows its end too.
      const j = this.data.job;
      if (j && !this.job.streamId && !this.job.done && (this.running || !j.done)) {
        this.running = true;
        this.job.el.hidden = false;
        this.job.follow(j.log, 'Davom etayotgan jarayon');
        this.render();
      }
    } catch (err) {
      clear(this.list, emptyState('alert', 'Tekshirib bo‘lmadi', err.message));
    } finally {
      this.loading = false;
    }
  }

  render() {
    const d = this.data;
    if (!d.apt) {
      this.osEl.textContent = d.os;
      clear(this.top);
      clear(this.list, emptyState('download', 'Bu serverda apt yo‘q', 'Hozircha faqat Debian va Ubuntu (apt) qo‘llab-quvvatlanadi.'));
      return;
    }
    this.osEl.textContent = d.os;
    this.stamp.textContent = d.checkedAt ? `ro‘yxat ${fmt.ago(d.checkedAt)} yangilangan` : '';
    const sec = d.items.filter((x) => x.security);
    const block = this.running || !d.canRoot;
    const why = !d.canRoot ? 'root yoki parolsiz sudo kerak' : this.running ? 'jarayon tugashini kuting' : null;
    clear(
      this.top,
      d.reboot.required &&
        h(
          'div',
          { class: 'up-reboot' },
          icon('alert', 16),
          h('div', { class: 'grow' }, h('b', null, 'Qayta yuklash kerak.'), ` Yangi yadro va kutubxonalar (${d.reboot.pkgs.slice(0, 3).join(', ') || 'yadro'}) qayta yuklangandan keyin ishlaydi.`),
          h('button', { class: 'key key-sm key-danger', type: 'button', disabled: block, 'data-tip': why, onclick: () => this.reboot() }, icon('power', 14), 'Qayta yuklash'),
        ),
      d.items.length
        ? h(
            'div',
            { class: 'up-summary' },
            h('div', { class: 'up-count' }, h('b', { class: 'mono' }, String(d.items.length)), ' ta yangilanish', sec.length ? h('span', { class: 'up-sec' }, ` · ${sec.length} tasi xavfsizlik`) : null),
            h('div', { class: 'grow' }),
            sec.length > 0 && h('button', { class: 'key key-sm key-signal', type: 'button', disabled: block, 'data-tip': why, onclick: () => this.start('apt-install', sec.map((x) => x.name)) }, icon('shield', 14), `Xavfsizliklarini o‘rnatish (${sec.length})`),
            h('button', { class: 'key key-sm', type: 'button', disabled: block, 'data-tip': why, onclick: () => this.start('apt-upgrade') }, icon('download', 14), `Hammasini o‘rnatish (${d.items.length})`),
          )
        : h('div', { class: 'up-fresh' }, icon('check', 18), h('b', null, 'Hammasi yangi'), h('span', { class: 'sy-meta' }, ' — o‘rnatiladigan yangilanish yo‘q.')),
    );
    clear(
      this.list,
      d.items.map((x) =>
        h(
          'div',
          { class: 'up-row' },
          h('span', { class: 'up-name mono' }, x.name),
          x.security ? h('span', { class: 'sy-badge bad' }, 'xavfsizlik') : h('span', { class: 'sy-badge' }, x.suites.split(',')[0]),
          h('span', { class: 'up-ver mono', 'data-tip': `${x.from} → ${x.to}` }, h('span', { class: 'up-from' }, x.from), ' → ', h('b', null, x.to)),
          h('button', { class: 'key key-sm', type: 'button', disabled: block, 'data-tip': why, onclick: () => this.start('apt-install', [x.name]) }, 'O‘rnatish'),
        ),
      ),
    );
  }

  async start(kind, pkgs = []) {
    if (kind !== 'apt-update') {
      const what = kind === 'apt-upgrade' ? `${this.data.items.length} ta paket` : pkgs.length === 1 ? pkgs[0] : `${pkgs.length} ta paket`;
      const ok = await confirmDialog({
        title: `${what} yangilansinmi?`,
        message: 'Yangilanayotgan dasturlar (masalan, nginx yoki Docker) bir necha soniya qayta ishga tushishi mumkin. Jarayon serverda alohida ishlaydi: aloqa uzilsa yoki Pult yopilsa ham to‘xtamaydi.',
        confirm: 'Yangilash',
      });
      if (!ok) return;
    }
    try {
      const job = await call('sys:job', this.view.connId, kind, pkgs);
      this.running = true;
      this.job.el.hidden = false;
      this.job.follow(job.log, kind === 'apt-update' ? 'Ro‘yxat yangilanmoqda (apt-get update)' : 'Paketlar yangilanmoqda');
      this.render();
    } catch (err) {
      toast(err.message, 'err', 6000);
    }
  }

  jobDone(code) {
    this.running = false;
    toast(code === 0 ? 'Tayyor' : 'Jarayon xato bilan tugadi — logni ko‘ring', code === 0 ? 'ok' : 'err', 5000);
    setTimeout(() => this.load(), 600);
  }

  async reboot() {
    const ok = await confirmDialog({
      title: 'Server qayta yuklansinmi?',
      message: 'Server 1–2 daqiqa ishlamaydi. Terminallardagi ishlar (tmux sessiyalari) va ishlab turgan dasturlar to‘xtaydi. Pult server qaytishi bilan o‘zi qayta ulanadi.',
      confirm: 'Qayta yuklash',
      danger: true,
    });
    if (!ok) return;
    try {
      await call('sys:reboot', this.view.connId);
      toast('Server qayta yuklanmoqda…', 'info', 6000);
    } catch (err) {
      toast(err.message, 'err', 6000);
    }
  }
}
