// AI coding agents on the server (Claude Code, agy): usage limits in the
// status bar, a details panel, and the "start an agent" menu.

import { call } from './api.js';
import { h, icon, clear, fmt, shellQuote } from './dom.js';
import { toast } from './ui.js';

// label: menus and headings; name: inside a sentence; short: tight spots.
export const AGENTS = {
  claude: { label: 'Claude Code', name: 'Claude Code', short: 'Claude', icon: 'claude', setting: 'claudeCmd', fallback: 'claude' },
  agy: { label: 'agy (Antigravity)', name: 'agy', short: 'agy', icon: 'agy', setting: 'agyCmd', fallback: 'agy' },
};

const STALE_MS = 45 * 60 * 1000;

/** "✳ Refactor auth" → "Refactor auth" (drops the status glyph agents put in front). */
export function cleanTitle(t) {
  return String(t || '')
    .replace(/^[^\p{L}\p{N}(["'`]+/u, '')
    .trim();
}

/** A path as one shell word (quoted only when it has to be). */
export const pathArg = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : shellQuote(p));

const pct = (v) => `${Math.round(v)}%`;
const tone = (ratio) => (ratio >= 0.9 ? 'crit' : ratio >= 0.75 ? 'warn' : '');

/* ---------------- normalised usage ---------------- */

// Claude's windows reset by themselves: once resets_at has passed the old
// percentage is meaningless, the window starts again from zero.
function claudeWindow(w) {
  if (!w) return null;
  const reset = w.resetsAt && w.resetsAt <= Date.now();
  return { used: reset ? 0 : Math.max(0, Math.min(100, w.pct)) / 100, resetAt: reset ? null : w.resetsAt, wasReset: !!reset };
}

/** { five, week } for agy: the most used bucket of each window across model groups. */
function agyWindows(groups) {
  const out = { five: null, week: null };
  for (const g of groups || []) {
    for (const b of g.buckets) {
      const key = b.window === '5h' ? 'five' : b.window === 'week' ? 'week' : null;
      if (!key) continue;
      const reset = b.resetAt && b.resetAt <= Date.now();
      const w = { used: reset ? 0 : b.used, resetAt: reset ? null : b.resetAt, group: g.name };
      if (!out[key] || w.used > out[key].used) out[key] = w;
    }
  }
  return out;
}

/* ---------------- status bar ---------------- */

function meter(ratio) {
  return h('span', { class: `sb-meter ${tone(ratio)}` }, h('span', { style: { width: `${Math.max(2, ratio * 100)}%` } }));
}

function chipWindow(label, w) {
  if (!w) return null;
  return h('span', { class: 'sb-win' }, h('span', { class: 'sb-label' }, label), meter(w.used), h('span', { class: 'sb-val' }, pct(w.used * 100)));
}

function windowTip(name, w) {
  if (!w) return null;
  const left = w.resetAt ? ` · ${fmt.when(w.resetAt)} da tiklanadi (${fmt.until(w.resetAt)})` : w.wasReset ? ' · yangilandi' : '';
  return `${name}: ${pct(w.used * 100)}${left}`;
}

/** Status bar chips for one session (empty when nothing to show). */
export function usageChips(session) {
  const st = session.agents;
  if (!st || !session.app.settings.agentUsage) return [];
  const chips = [];
  const open = (e) => openUsagePanel(session, e.currentTarget);

  if (st.claude?.path || st.claude?.bridged) {
    const c = st.claude;
    const u = c.usage;
    let body;
    let tip;
    let cls = '';
    if (!c.bridged) {
      body = [h('span', { class: 'sb-label' }, 'limitni ulash')];
      tip = 'Claude Code limitlarini shu yerda ko‘rsatish — bosing';
      cls = 'setup';
    } else if (u && (u.five || u.week)) {
      const five = claudeWindow(u.five);
      const week = claudeWindow(u.week);
      body = [chipWindow('5 soat', five), chipWindow('hafta', week)];
      const age = Date.now() - u.t;
      if (age > STALE_MS) cls = 'stale';
      tip = [windowTip('5 soatlik', five), windowTip('Haftalik', week), `Ma’lumot: ${fmt.ago(u.t)}`].filter(Boolean).join('\n');
    } else if (u?.spend) {
      const s = claudeWindow(u.spend);
      body = [chipWindow('sarf', s)];
      tip = windowTip('Sarf limiti', s);
    } else {
      body = [h('span', { class: 'sb-label' }, '—')];
      tip = c.seen ? 'Bu hisobda obuna limitlari yo‘q (API kalit?)' : 'Claude Code’da bitta so‘rov yuboring — limitlar shundan keyin chiqadi';
    }
    chips.push(
      h('button', { class: `sb-agent ${cls}`, type: 'button', 'data-tip': tip, onclick: open }, icon('claude', 13), h('span', { class: 'sb-agent-name' }, 'Claude'), body),
    );
  }

  if (st.agy?.path) {
    const a = st.agy;
    let body;
    let tip;
    let cls = '';
    if (a.usage) {
      const w = agyWindows(a.usage);
      body = [chipWindow('5 soat', w.five), chipWindow('hafta', w.week)];
      if (!w.five && !w.week) body = [h('span', { class: 'sb-label' }, 'limit')];
      tip = [windowTip('5 soatlik', w.five), windowTip('Haftalik', w.week), a.at ? `Yangilangan: ${fmt.ago(a.at)}` : null].filter(Boolean).join('\n');
      if (a.error) cls = 'stale';
    } else if (a.busy) {
      body = [h('span', { class: 'spinner xs' })];
      tip = 'agy limitlari olinmoqda…';
    } else if (a.error) {
      body = [h('span', { class: 'sb-label' }, a.error.code === 'AUTH' ? 'kirilmagan' : 'xato')];
      tip = a.error.message;
      cls = 'warn';
    } else {
      body = [h('span', { class: 'sb-label' }, '—')];
      tip = 'agy limitlari hali olinmagan';
    }
    chips.push(h('button', { class: `sb-agent ${cls}`, type: 'button', 'data-tip': tip, onclick: open }, icon('agy', 13), h('span', { class: 'sb-agent-name' }, 'agy'), body));
  }
  return chips;
}

/* ---------------- details panel ---------------- */

let panel = null; // { el, session, anchor, render() }

/** Close the panel (only if it shows `session`, when one is given). */
export function closeUsagePanel(session = null) {
  if (!panel || (session && panel.session !== session)) return;
  panel.el.remove();
  panel = null;
}

export function refreshUsagePanel(session) {
  if (panel && (!session || panel.session === session)) panel.render();
}

export function openUsagePanel(session, anchor) {
  if (panel && panel.session === session) {
    closeUsagePanel();
    return;
  }
  closeUsagePanel();
  const el = h('div', { class: 'ai-panel', role: 'dialog' });
  document.getElementById('layer').append(el);
  panel = { el, session, anchor, render: () => renderPanel(session, el) };
  panel.render();
  place(el, anchor);
  if (session.agents?.agy?.path && Date.now() - (session.agents.agy.at || 0) > 60e3) refreshAgy(session);
}

function place(el, anchor) {
  const r = anchor?.getBoundingClientRect?.();
  const w = el.offsetWidth;
  const left = r ? Math.max(8, Math.min(r.left, innerWidth - w - 8)) : 8;
  el.style.left = `${left}px`;
}

addEventListener(
  'mousedown',
  (e) => {
    if (!panel) return;
    if (panel.el.contains(e.target) || e.target.closest?.('.sb-agent, .menu')) return;
    closeUsagePanel();
  },
  true,
);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panel) closeUsagePanel();
});

async function refreshAgy(session) {
  try {
    await call('agents:refreshAgy', session.id);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function bar(label, w, extra) {
  if (!w) return null;
  const when = w.resetAt ? `${fmt.when(w.resetAt)} da tiklanadi · ${fmt.until(w.resetAt)}` : w.wasReset ? 'tiklandi' : '';
  return h(
    'div',
    { class: 'ai-row' },
    h('div', { class: 'ai-row-head' }, h('span', { class: 'ai-row-label' }, label), h('span', { class: `ai-row-val ${tone(w.used)}` }, pct(w.used * 100), h('span', { class: 'muted' }, ' ishlatilgan'))),
    h('div', { class: `ai-bar ${tone(w.used)}` }, h('span', { style: { width: `${Math.max(1, w.used * 100)}%` } })),
    (when || extra) && h('div', { class: 'ai-row-meta' }, [when, extra].filter(Boolean).join(' · ')),
  );
}

function renderPanel(session, el) {
  const st = session.agents || {};
  const sections = [];

  if (st.claude?.path || st.claude?.bridged) sections.push(claudeSection(session, st.claude));
  if (st.agy?.path) sections.push(agySection(session, st.agy));
  if (!sections.length) {
    sections.push(
      h(
        'div',
        { class: 'ai-sec' },
        h('div', { class: 'ai-empty' }, st.detected ? 'Bu serverda Claude Code ham, agy ham topilmadi.' : 'Tekshirilmoqda…'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => call('agents:detect', session.id).catch((e) => toast(e.message, 'err')) }, icon('refresh', 14), 'Qayta tekshirish'),
      ),
    );
  }
  clear(el, h('div', { class: 'ai-head' }, h('span', { class: 'ai-title' }, 'AI limitlari'), h('span', { class: 'ai-server muted' }, session.server.name), h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Yopish', onclick: () => closeUsagePanel() }, icon('x', 14))), sections);
}

function sectionHead(ic, title, ...right) {
  return h('div', { class: 'ai-sec-head' }, h('span', { class: 'ai-ic' }, icon(ic, 14)), h('span', { class: 'ai-sec-title' }, title), h('span', { class: 'grow' }), right);
}

function claudeSection(session, c) {
  const busyBtn = (label, kind, fn) => {
    const b = h('button', { class: `btn btn-sm ${kind || ''}`, type: 'button' }, label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (err) {
        toast(err.message, 'err', 6000);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  };

  if (!c.bridged) {
    return h(
      'div',
      { class: 'ai-sec' },
      sectionHead('claude', 'Claude Code'),
      h(
        'p',
        { class: 'ai-text' },
        'Obunangiz limitlari (5 soatlik va haftalik) shu yerda doim ko‘rinib turishi uchun Pult serverdagi Claude Code’ga kichik status line skriptini ulaydi. ',
        'O‘zingizning status line’ingiz bo‘lsa, u ham ishlashda davom etadi. Claude ishni tugatganda yoki ruxsat so‘raganda terminal signal beradi — Pult buni bildirishnoma qilib ko‘rsatadi.',
      ),
      h('p', { class: 'ai-note muted' }, '~/.claude/settings.json o‘zgaradi (avvalgi nusxasi saqlanadi). Istalgan vaqtda shu yerdan uzib qo‘yish mumkin.'),
      h(
        'div',
        { class: 'ai-actions' },
        busyBtn('Ulash', 'btn-primary', async () => {
          await call('agents:installClaude', session.id);
          toast('Ulandi — Claude Code’da keyingi javobdan so‘ng limitlar chiqadi', 'ok', 4000);
        }),
      ),
    );
  }

  const u = c.usage;
  const rows = [];
  if (u) {
    rows.push(bar('5 soatlik limit', claudeWindow(u.five)));
    rows.push(bar('Haftalik limit', claudeWindow(u.week)));
    if (u.spend) {
      const s = claudeWindow(u.spend);
      const money = u.spend.usedUsd != null && u.spend.limitUsd != null ? `$${u.spend.usedUsd.toFixed(2)} / $${u.spend.limitUsd}` : null;
      rows.push(bar('Sarf limiti', s, money));
    }
  }
  // What the terminal you are looking at is doing.
  const view = session.active;
  const snap = view?.attach ? c.sessions?.[view.attach] : null;
  const facts = snap ? [snap.model, snap.ctx != null ? `kontekst ${Math.round(snap.ctx)}%` : null, snap.cost != null ? `$${snap.cost.toFixed(2)}` : null].filter(Boolean) : [];

  return h(
    'div',
    { class: 'ai-sec' },
    sectionHead(
      'claude',
      'Claude Code',
      u && h('span', { class: `ai-age ${Date.now() - u.t > STALE_MS ? 'warn' : ''}` }, fmt.ago(u.t)),
      busyBtn('Uzish', 'btn-ghost', async () => {
        await call('agents:removeClaude', session.id);
        toast('Claude Code sozlamalari avvalgi holatiga qaytarildi', 'ok', 3000);
      }),
    ),
    rows.filter(Boolean).length
      ? rows
      : h('p', { class: 'ai-text muted' }, c.seen ? 'Bu hisobda obuna limitlari yo‘q — ular faqat Pro/Max obunada bo‘ladi (API kalit bilan cheklov yo‘q).' : 'Hali ma’lumot yo‘q: Claude Code’da bitta xabar yuboring — limitlar birinchi javobdan keyin chiqadi.'),
    u && Date.now() - u.t > STALE_MS && h('p', { class: 'ai-note muted' }, 'Ma’lumot Claude Code oxirgi marta javob berganda olingan; boshqa qurilmadagi ishlatish keyingi javobda qo‘shiladi.'),
    facts.length > 0 && h('div', { class: 'ai-facts' }, icon('terminal', 13), h('span', null, facts.join(' · '))),
  );
}

function agySection(session, a) {
  const refresh = h('button', { class: 'icon-btn sm', type: 'button', 'data-tip': 'Yangilash', disabled: a.busy, onclick: () => refreshAgy(session) }, a.busy ? h('span', { class: 'spinner xs' }) : icon('refresh', 14));
  const groups = (a.usage || []).map((g) =>
    h(
      'div',
      { class: 'ai-group' },
      h('div', { class: 'ai-group-name' }, g.name),
      g.buckets.map((b) => {
        const reset = b.resetAt && b.resetAt <= Date.now();
        const label = b.window === '5h' ? '5 soatlik' : b.window === 'week' ? 'Haftalik' : b.window === 'day' ? 'Kunlik' : b.window;
        return bar(label, { used: reset ? 0 : b.used, resetAt: reset ? null : b.resetAt, wasReset: reset });
      }),
    ),
  );
  return h(
    'div',
    { class: 'ai-sec' },
    sectionHead('agy', 'Antigravity CLI (agy)', a.at ? h('span', { class: 'ai-age' }, fmt.ago(a.at)) : null, refresh),
    a.error && h('p', { class: `ai-text ${a.error.code === 'AUTH' ? 'warn' : 'err'}` }, a.error.message),
    groups.length ? groups : !a.error && h('p', { class: 'ai-text muted' }, a.busy ? 'Limitlar olinmoqda…' : 'Hali ma’lumot yo‘q.'),
  );
}

/* ---------------- launching agents ---------------- */

/** The command a terminal types to start an agent. */
export function agentCommand(app, kind, { resume = false } = {}) {
  const meta = AGENTS[kind];
  const base = String(app.settings[meta.setting] || '').trim() || meta.fallback;
  return resume ? `${base} -c` : base;
}

/** Menu entries that start agents (in a new terminal, optionally in `dir`). */
export function agentMenuItems(session, { dir = null, resume = true } = {}) {
  const st = session.agents;
  const items = [];
  for (const kind of Object.keys(AGENTS)) {
    const meta = AGENTS[kind];
    const found = !!st?.[kind]?.path || Object.values(st?.panes || {}).some((p) => p.agent === kind);
    if (!found && dir) continue;
    items.push({
      label: dir ? `${meta.name}’ni shu yerda ochish` : meta.label,
      icon: meta.icon,
      disabled: !found && st?.detected,
      hint: !found && st?.detected ? 'topilmadi' : null,
      onClick: () => session.launchAgent(kind, { dir }),
    });
    if (resume && !dir) {
      items.push({
        label: `${meta.short} — oxirgi suhbat`,
        icon: 'resume',
        hint: `${meta.fallback} -c`,
        disabled: !found && st?.detected,
        onClick: () => session.launchAgent(kind, { resume: true }),
      });
    }
  }
  return items;
}
