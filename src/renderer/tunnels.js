// Port forwarding panel: open a site or panel that the server only serves on
// its own localhost in this computer's browser (SSH tunnel, see main/tunnels.js).

import { call } from './api.js';
import { h, icon, clear } from './dom.js';
import { toast } from './ui.js';

let panel = null; // { el, session, render() }

export function closeTunnelPanel(session = null) {
  if (!panel || (session && panel.session !== session)) return;
  panel.el.remove();
  panel = null;
}

export function refreshTunnelPanel(session) {
  if (panel && panel.session === session) panel.renderList();
}

export function openTunnelPanel(session) {
  if (panel && panel.session === session) {
    closeTunnelPanel();
    return;
  }
  closeTunnelPanel();
  const listEl = h('div', { class: 'tn-list' });
  const scanEl = h('div', { class: 'tn-scan' });
  const remote = h('input', { class: 'input mono', id: 'tn-remote', inputmode: 'numeric', placeholder: 'masalan, 3000', spellcheck: 'false' });
  const local = h('input', { class: 'input mono', id: 'tn-local', inputmode: 'numeric', placeholder: 'xuddi shu', spellcheck: 'false' });
  const add = async (remotePort, localPort) => {
    try {
      session.tunnels = await call('tun:add', session.id, { remotePort, localPort: localPort || null });
      renderList();
      const t = session.tunnels.find((x) => x.remotePort === Number(remotePort));
      if (t) toast(`Ochildi: http://127.0.0.1:${t.localPort}`, 'ok', 3500);
      remote.value = '';
      local.value = '';
    } catch (err) {
      toast(err.message, 'err', 5000);
    }
  };
  const form = h(
    'form',
    {
      class: 'tn-form',
      onsubmit: (e) => {
        e.preventDefault();
        if (remote.value.trim()) add(remote.value.trim(), local.value.trim());
      },
    },
    h('label', { class: 'field', for: 'tn-remote' }, h('span', { class: 'field-label' }, 'Serverdagi port'), remote),
    h('label', { class: 'field', for: 'tn-local' }, h('span', { class: 'field-label' }, 'Kompyuterdagi port'), local),
    h('button', { class: 'btn btn-primary', type: 'submit' }, icon('plus', 15), 'Ochish'),
  );

  const el = h(
    'div',
    { class: 'tn-panel', role: 'dialog', 'aria-label': 'Portlar' },
    h(
      'div',
      { class: 'st-head' },
      h('span', { class: 'st-title' }, 'Portlar'),
      h('span', { class: 'st-server muted' }, session.server.name),
      h('span', { class: 'grow' }),
      h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Yopish', onclick: () => closeTunnelPanel() }, icon('x', 14)),
    ),
    h('p', { class: 'tn-text' }, 'Serverda faqat ichkarida (localhost) ishlayotgan sayt yoki panelni shu kompyuterda ochish. Ochilgan portlar shu server uchun eslab qolinadi.'),
    listEl,
    form,
    h('div', { class: 'st-sub' }, 'Serverda tinglayotgan portlar'),
    scanEl,
  );
  document.getElementById('layer').append(el);

  function renderList() {
    const list = session.tunnels || [];
    if (!list.length) {
      clear(listEl, h('div', { class: 'tn-empty' }, 'Hozircha ochiq port yo‘q.'));
      return;
    }
    clear(
      listEl,
      list.map((t) => {
        const url = `http://127.0.0.1:${t.localPort}`;
        return h(
          'div',
          { class: 'tn-row' },
          h(
            'div',
            { class: 'tn-main' },
            h('div', { class: 'tn-map mono' }, h('b', null, `127.0.0.1:${t.localPort}`), ' → ', `${t.remoteHost}:${t.remotePort}`),
            h('div', { class: `tn-meta ${t.error ? 'err' : ''}` }, t.error || (t.active ? `${t.active} ta ulanish ochiq` : `${t.total} marta ishlatildi`)),
          ),
          h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => call('open:external', url) }, icon('reveal', 14), 'Brauzerda'),
          h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Manzilni nusxalash', 'data-tip': 'Manzilni nusxalash', onclick: () => (call('clip:write', url), toast('Nusxalandi', 'ok', 1200)) }, icon('copy', 14)),
          h(
            'button',
            {
              class: 'icon-btn sm',
              type: 'button',
              'aria-label': 'Yopish',
              'data-tip': 'Portni yopish',
              onclick: async () => {
                session.tunnels = await call('tun:remove', session.id, t.id).catch((e) => (toast(e.message, 'err'), session.tunnels));
                renderList();
              },
            },
            icon('x', 14),
          ),
        );
      }),
    );
  }

  let lastPorts = null;
  async function scan() {
    clear(scanEl, h('div', { class: 'st-note' }, h('span', { class: 'spinner' }), ' Tekshirilmoqda…'));
    try {
      lastPorts = await call('tun:scan', session.id);
    } catch (err) {
      clear(scanEl, h('div', { class: 'st-note' }, err.message));
      return;
    }
    if (!panel || panel.session !== session) return;
    renderScan(lastPorts);
  }

  function renderScan(ports) {
    if (!ports.length) {
      clear(scanEl, h('div', { class: 'st-note' }, 'Tinglayotgan port topilmadi (ss yoki netstat yo‘q bo‘lishi mumkin).'));
      return;
    }
    clear(
      scanEl,
      ports.map((p) =>
        h(
          'div',
          { class: 'tn-row tn-found' },
          h('span', { class: 'tn-port' }, String(p.port)),
          h('div', { class: 'tn-main' }, h('div', null, p.proc || 'noma’lum dastur'), h('div', { class: 'tn-meta' }, p.localOnly ? 'faqat server ichida' : 'tashqaridan ham ochiq')),
          (session.tunnels || []).some((t) => t.remotePort === p.port)
            ? h('span', { class: 'tn-on' }, icon('check', 14), 'ochiq')
            : h('button', { class: 'btn btn-sm', type: 'button', onclick: () => add(p.port) }, 'Ochish'),
        ),
      ),
    );
  }

  panel = {
    el,
    session,
    renderList: () => {
      renderList();
      if (lastPorts) renderScan(lastPorts);
    },
  };
  renderList();
  scan();
}

addEventListener(
  'mousedown',
  (e) => {
    if (!panel) return;
    if (panel.el.contains(e.target) || e.target.closest?.('.sb-tun, .backdrop, .menu')) return;
    closeTunnelPanel();
  },
  true,
);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panel && !document.querySelector('.backdrop')) closeTunnelPanel();
});
