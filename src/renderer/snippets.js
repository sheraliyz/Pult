// Quick commands: saved command lines sent to the active terminal with one
// click (top bar "Buyruqlar") or Alt+1…9.

import { h, icon, clear } from './dom.js';
import { modal } from './ui.js';

/** Editor for the list; saves to settings.snippets. */
export async function editSnippets(app) {
  let rows = (app.settings.snippets || []).map((s) => ({ name: s.name || '', cmd: s.cmd || '', run: s.run !== false }));
  const listEl = h('div', { class: 'snip-list' });

  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    render();
  };

  function render() {
    clear(listEl);
    if (!rows.length) {
      listEl.append(h('div', { class: 'snip-empty' }, 'Hali buyruq yo‘q. Pastdagi tugma bilan qo‘shing.'));
      return;
    }
    rows.forEach((r, i) => {
      const name = h('input', { class: 'input snip-name', value: r.name, placeholder: 'Nomi (ixtiyoriy)', spellcheck: 'false', 'aria-label': `${i + 1}-buyruq nomi` });
      name.addEventListener('input', () => (r.name = name.value));
      const cmd = h('input', { class: 'input mono snip-cmd', value: r.cmd, placeholder: 'masalan, docker ps', spellcheck: 'false', 'aria-label': `${i + 1}-buyruq` });
      cmd.addEventListener('input', () => (r.cmd = cmd.value));
      const run = h('input', { type: 'checkbox', checked: r.run, onchange: () => (r.run = run.checked) });
      listEl.append(
        h(
          'div',
          { class: 'snip-row' },
          h('span', { class: 'snip-n', 'data-tip': i < 9 ? `Alt+${i + 1}` : null }, String(i + 1)),
          name,
          cmd,
          h('label', { class: 'check snip-run', 'data-tip': 'Belgilansa, buyruq darhol bajariladi (Enter bosiladi)' }, run, h('span', { class: 'check-box' }, icon('check', 12)), h('span', null, 'Enter')),
          h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Yuqoriga', 'data-tip': 'Yuqoriga', disabled: i === 0, onclick: () => move(i, -1) }, icon('arrowUp', 14)),
          h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Pastga', 'data-tip': 'Pastga', disabled: i === rows.length - 1, onclick: () => move(i, 1) }, icon('arrowDown', 14)),
          h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'O‘chirish', 'data-tip': 'O‘chirish', onclick: () => (rows.splice(i, 1), render()) }, icon('trash', 14)),
        ),
      );
    });
  }
  render();

  const add = h(
    'button',
    {
      class: 'btn btn-sm',
      type: 'button',
      onclick: () => {
        rows.push({ name: '', cmd: '', run: true });
        render();
        listEl.querySelector('.snip-row:last-child .snip-cmd')?.focus();
      },
    },
    icon('plus', 14),
    'Buyruq qo‘shish',
  );

  const saved = await modal({
    title: 'Tez buyruqlar',
    icon: 'bolt',
    width: 680,
    body: h(
      'div',
      { class: 'snip' },
      h('p', { class: 'm-text' }, 'Ko‘p yoziladigan buyruqlar. Yuqori paneldagi «Buyruqlar» tugmasidan yoki Alt+1…9 bilan joriy terminalga yuboriladi.'),
      listEl,
      h('div', { class: 'snip-foot' }, add),
    ),
    actions: [
      { label: 'Bekor qilish', value: null },
      { label: 'Saqlash', kind: 'primary', onClick: () => rows.map((r) => ({ name: r.name.trim(), cmd: r.cmd.replace(/\s+$/, ''), run: r.run })).filter((r) => r.cmd.trim()) },
    ],
  }).promise;
  if (saved) await app.updateSettings({ snippets: saved });
}

/** Menu entries for the quick-command button. */
export function snippetMenuItems(session) {
  const list = session.app.settings.snippets || [];
  return [
    ...list.map((sn, i) => ({ label: sn.name || sn.cmd, icon: sn.run === false ? 'enter' : 'terminal', hint: i < 9 ? `Alt+${i + 1}` : '', onClick: () => session.runSnippet(sn) })),
    list.length > 0 && '-',
    { label: 'Buyruqlarni tahrirlash…', icon: 'pencil', onClick: () => editSnippets(session.app) },
  ];
}
