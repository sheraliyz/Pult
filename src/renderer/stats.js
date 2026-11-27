// Server health: the last 30 minutes of CPU, RAM and ping as three small
// charts (one measure each, never two scales on one axis), plus the processes
// using the most CPU, with a way to stop one.

import { call } from './api.js';
import { h, icon, clear, fmt } from './dom.js';
import { toast, confirmDialog } from './ui.js';

const KEEP = 900; // 30 minutes of 2-second samples
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Remember one sample (called for every stats tick of a session). */
export function recordStats(session, s) {
  const list = (session.statsHistory ??= []);
  const mem = s.memTotal ? s.memUsed / s.memTotal : null;
  list.push({ t: Date.now(), cpu: s.cpu != null ? s.cpu * 100 : null, mem: mem != null ? mem * 100 : null, rtt: s.rtt ?? null, memUsed: s.memUsed, memTotal: s.memTotal });
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
}

/* ---------------- panel ---------------- */

let panel = null; // { el, session, render(), timer }

export function closeStatsPanel(session = null) {
  if (!panel || (session && panel.session !== session)) return;
  clearInterval(panel.timer);
  panel.el.remove();
  panel = null;
}

export function refreshStatsPanel(session) {
  if (panel && panel.session === session) panel.renderCharts();
}

export function openStatsPanel(session) {
  if (panel && panel.session === session) {
    closeStatsPanel();
    return;
  }
  closeStatsPanel();
  const charts = h('div', { class: 'st-charts' });
  const procs = h('div', { class: 'st-procs' }, h('div', { class: 'st-note' }, h('span', { class: 'spinner' }), ' Jarayonlar olinmoqda…'));
  const el = h(
    'div',
    { class: 'st-panel', role: 'dialog', 'aria-label': 'Server holati' },
    h(
      'div',
      { class: 'st-head' },
      h('span', { class: 'st-title' }, 'Server holati'),
      h('span', { class: 'st-server muted' }, session.server.name),
      h('span', { class: 'grow' }),
      h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Yopish', onclick: () => closeStatsPanel() }, icon('x', 14)),
    ),
    charts,
    h('div', { class: 'st-sub' }, 'Eng ko‘p protsessor ishlatayotgan jarayonlar'),
    procs,
  );
  document.getElementById('layer').append(el);
  panel = {
    el,
    session,
    renderCharts: () => renderCharts(session, charts),
    loadProcs: () => loadProcs(session, procs),
    timer: null,
  };
  panel.renderCharts();
  panel.loadProcs();
  panel.timer = setInterval(() => {
    if (document.hidden) return;
    panel?.loadProcs();
  }, 3000);
}

addEventListener(
  'mousedown',
  (e) => {
    if (!panel) return;
    if (panel.el.contains(e.target) || e.target.closest?.('.sb-stat, .backdrop, .menu')) return;
    closeStatsPanel();
  },
  true,
);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panel && !document.querySelector('.backdrop')) closeStatsPanel();
});

/* ---------------- charts ---------------- */

const SERIES = [
  { key: 'cpu', label: 'CPU', unit: '%', max: () => 100, fmt: (v) => String(Math.round(v)) },
  { key: 'mem', label: 'RAM', unit: '%', max: () => 100, fmt: (v) => String(Math.round(v)) },
  { key: 'rtt', label: 'Ping', unit: 'ms', max: (vals) => Math.max(50, niceCeil(Math.max(...vals) * 1.15)), fmt: (v) => String(Math.round(v)) },
];

function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(Math.max(1, v)));
  return Math.ceil(v / p) * p;
}

function renderCharts(session, box) {
  const samples = session.statsHistory || [];
  clear(box, SERIES.map((s) => chart(session, s, samples)));
}

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function chart(session, s, samples) {
  const pts = samples.filter((p) => p[s.key] != null);
  const vals = pts.map((p) => p[s.key]);
  const now = vals.length ? vals[vals.length - 1] : null;
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const top = vals.length ? Math.max(...vals) : null;
  const span = pts.length > 1 ? pts[pts.length - 1].t - pts[0].t : 0;
  const ram = s.key === 'mem' && pts.length ? pts[pts.length - 1] : null;

  const head = h(
    'div',
    { class: 'st-chart-head' },
    h('span', { class: 'st-label' }, s.label),
    h('span', { class: 'st-now' }, now != null ? s.fmt(now) : '—'),
    h('span', { class: 'st-unit' }, s.unit),
    ram?.memTotal && h('span', { class: 'st-extra' }, `${fmt.bytes(ram.memUsed)} / ${fmt.bytes(ram.memTotal)}`),
    h('span', { class: 'grow' }),
    avg != null && h('span', { class: 'st-agg' }, `o‘rtacha ${s.fmt(avg)}${s.unit === '%' ? '%' : ` ${s.unit}`} · eng ko‘p ${s.fmt(top)}${s.unit === '%' ? '%' : ` ${s.unit}`}`),
  );

  const W = 420;
  const H = 64;
  const plot = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'st-svg', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const wrap = h(
    'div',
    {
      class: 'st-plot',
      role: 'img',
      'aria-label': now != null ? `${s.label}, oxirgi ${Math.max(1, Math.round(span / 60000))} daqiqa: hozir ${s.fmt(now)} ${s.unit}, o‘rtacha ${s.fmt(avg)}, eng ko‘p ${s.fmt(top)}` : `${s.label}: ma’lumot yo‘q`,
    },
    plot,
  );

  // Recessive grid: 0, half and top of the scale.
  for (const f of [0, 0.5, 1]) plot.append(svg('line', { x1: 0, x2: W, y1: H - f * (H - 4) - 0.5, y2: H - f * (H - 4) - 0.5, class: 'st-grid' }));

  if (pts.length < 2) {
    wrap.append(h('div', { class: 'st-wait' }, 'Ma’lumot yig‘ilmoqda…'));
    return h('div', { class: 'st-chart' }, head, wrap);
  }
  const max = s.max(vals);
  const t0 = pts[0].t;
  const tSpan = Math.max(1, pts[pts.length - 1].t - t0);
  const x = (p) => ((p.t - t0) / tSpan) * W;
  const y = (v) => H - Math.min(1, v / max) * (H - 4);
  const line = pts.map((p) => `${x(p).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(' ');
  plot.append(svg('polygon', { points: `0,${H} ${line} ${W},${H}`, class: 'st-area' }));
  plot.append(svg('polyline', { points: line, class: 'st-line', 'vector-effect': 'non-scaling-stroke' }));

  // Endpoint and the hover crosshair are HTML so they stay round in a stretched SVG.
  const last = pts[pts.length - 1];
  const dot = h('span', { class: 'st-dot', style: { left: `${(x(last) / W) * 100}%`, top: `${(y(last[s.key]) / H) * 100}%` } });
  const cross = h('span', { class: 'st-cross', hidden: true });
  const hoverDot = h('span', { class: 'st-dot st-dot-hover', hidden: true });
  const tip = h('span', { class: 'st-tip', hidden: true });
  wrap.append(dot, cross, hoverDot, tip);
  wrap.addEventListener('mousemove', (e) => {
    const r = wrap.getBoundingClientRect();
    const fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const target = t0 + fx * tSpan;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - target) < Math.abs(best.t - target)) best = p;
    const px = (x(best) / W) * 100;
    const py = (y(best[s.key]) / H) * 100;
    cross.hidden = hoverDot.hidden = tip.hidden = false;
    cross.style.left = `${px}%`;
    hoverDot.style.left = `${px}%`;
    hoverDot.style.top = `${py}%`;
    tip.textContent = `${s.fmt(best[s.key])} ${s.unit} · ${ago(best.t)}`;
    tip.style.left = `${Math.min(78, Math.max(0, px - 11))}%`;
  });
  wrap.addEventListener('mouseleave', () => {
    cross.hidden = hoverDot.hidden = tip.hidden = true;
  });

  const axis = h('div', { class: 'st-axis' }, h('span', null, ago(t0)), h('span', null, 'hozir'));
  return h('div', { class: 'st-chart' }, head, wrap, axis);
}

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return 'hozir';
  if (s < 60) return `${s} soniya oldin`;
  return `${Math.round(s / 60)} daq oldin`;
}

/* ---------------- processes ---------------- */

const etime = (sec) => {
  if (sec == null) return '—';
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} daq`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} soat`;
  return `${Math.floor(sec / 86400)} kun`;
};

async function loadProcs(session, box) {
  let list;
  try {
    list = await call('sys:top', session.id);
  } catch (err) {
    clear(box, h('div', { class: 'st-note' }, `Jarayonlar ro‘yxatini olib bo‘lmadi: ${err.message}`));
    return;
  }
  if (!panel || panel.session !== session) return;
  if (!list.length) {
    clear(box, h('div', { class: 'st-note' }, 'Jarayonlar topilmadi (serverda ps buyrug‘i yo‘q bo‘lishi mumkin).'));
    return;
  }
  clear(
    box,
    h(
      'div',
      { class: 'st-table', role: 'table' },
      h('div', { class: 'st-row st-th', role: 'row' }, ['PID', 'Kim', 'CPU', 'RAM', 'Vaqt', 'Buyruq', ''].map((t) => h('span', { role: 'columnheader' }, t))),
      list.map((p) =>
        h(
          'div',
          { class: 'st-row', role: 'row' },
          h('span', { class: 'mono' }, String(p.pid)),
          h('span', { class: 'st-user' }, p.user),
          h('span', { class: `mono ${p.cpu >= 80 ? 'st-hot' : ''}` }, `${p.cpu.toFixed(1)}%`),
          h('span', { class: 'mono' }, p.rss != null ? fmt.bytes(p.rss * 1024) : `${p.mem.toFixed(1)}%`),
          h('span', null, etime(p.etime)),
          h('span', { class: 'st-cmd mono', 'data-tip': p.args }, p.args),
          h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': `${p.pid} ni to‘xtatish`, 'data-tip': 'To‘xtatish', onclick: () => stop(session, p) }, icon('x', 13)),
        ),
      ),
    ),
  );
}

async function stop(session, p) {
  const ok = await confirmDialog({
    title: 'Jarayonni to‘xtatish',
    message: `${p.pid} · ${p.args.slice(0, 160)} — ${p.user} foydalanuvchisiniki. To‘xtatish signali (TERM) yuboriladi; dastur saqlanmagan ishini yo‘qotishi mumkin.`,
    confirm: 'To‘xtatish',
    danger: true,
  });
  if (!ok) return;
  try {
    await call('sys:kill', session.id, p.pid);
    toast(`${p.pid} ga to‘xtatish signali yuborildi`, 'ok');
    panel?.loadProcs();
  } catch (err) {
    toast(err.message, 'err', 5000);
  }
}
