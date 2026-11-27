// App settings dialog. Every change applies immediately.

import { call } from './api.js';
import { h, icon } from './dom.js';
import { modal, segmented, toggleRow } from './ui.js';

export async function openSettings(app) {
  const s = app.settings;
  const set = (patch) => app.updateSettings(patch);

  const theme = segmented(
    [
      { value: 'system', label: 'Tizim' },
      { value: 'dark', label: 'Qorong‘i' },
      { value: 'light', label: 'Yorug‘' },
    ],
    s.theme,
    (v) => set({ theme: v }),
  );

  // Signal colour (active keys, cursor, limits) and chassis colour (light theme).
  const swatches = (options, value, onPick) => {
    const el = h('div', { class: 'swatches', role: 'radiogroup' });
    const buttons = options.map(([v, label, color]) =>
      h(
        'button',
        {
          class: `swatch ${v === value ? 'on' : ''}`,
          type: 'button',
          role: 'radio',
          'aria-checked': String(v === value),
          'aria-label': label,
          'data-tip': label,
          style: `--sw: ${color}`,
          onclick: () => {
            for (const b of buttons) {
              const on = b === buttons[options.findIndex((o) => o[0] === v)];
              b.classList.toggle('on', on);
              b.setAttribute('aria-checked', String(on));
            }
            onPick(v);
          },
        },
        h('span', { class: 'swatch-dot' }),
      ),
    );
    el.append(...buttons);
    return el;
  };
  const signal = swatches(
    [
      ['orange', 'To‘q sariq', '#ff5a1f'],
      ['yellow', 'Sariq', '#ffc21a'],
      ['blue', 'Ko‘k', '#3d7bff'],
      ['green', 'Yashil', '#2bd47d'],
    ],
    s.signal || 'orange',
    (v) => set({ signal: v }),
  );
  const body = swatches(
    [
      ['gray', 'Kulrang', '#e2e1db'],
      ['mint', 'Yalpiz', '#d9e3da'],
      ['sky', 'Osmon', '#d8e1ea'],
      ['sand', 'Qum', '#e9dccb'],
    ],
    s.body || 'gray',
    (v) => set({ body: v }),
  );

  const sizeValue = h('span', { class: 'stepper-value mono' }, String(s.fontSize));
  const step = (d) => {
    const v = Math.max(9, Math.min(24, app.settings.fontSize + d));
    sizeValue.textContent = String(v);
    set({ fontSize: v });
  };
  const fontSize = h(
    'div',
    { class: 'stepper' },
    h('button', { class: 'icon-btn sm', type: 'button', onclick: () => step(-1) }, '−'),
    sizeValue,
    h('button', { class: 'icon-btn sm', type: 'button', onclick: () => step(1) }, '+'),
  );

  const cursor = segmented(
    [
      { value: 'bar', label: '▏ Chiziq' },
      { value: 'block', label: '█ Blok' },
      { value: 'underline', label: '▁ Pastki' },
    ],
    s.cursorStyle,
    (v) => set({ cursorStyle: v }),
  );

  const blink = toggleRow('Kursor miltillashi', null, s.cursorBlink, (v) => set({ cursorBlink: v }));
  const copySel = toggleRow('Belgilanganda nusxalash', 'Matnni sichqoncha bilan belgilash bilanoq buferga olinadi.', s.copyOnSelect, (v) => set({ copyOnSelect: v }));
  const restore = toggleRow('Oxirgi serverlarga ulanish', 'Pult ochilganda, yopilishidan oldin ochiq bo‘lgan serverlarga o‘zi ulanadi.', s.restoreSessions !== false, (v) => set({ restoreSessions: v }));
  const history = toggleRow('Terminal tarixini tiklash', 'Qayta ochilgan terminalda avvalgi chiqish ham ko‘rinadi (tmux tarixidan).', s.restoreHistory !== false, (v) => set({ restoreHistory: v }));

  const dirLabel = h('span', { class: 'dir-path mono' }, s.downloadDir || (await call('downloads:dir')));
  const pickDir = h('button', {
    class: 'btn btn-sm',
    type: 'button',
    onclick: async () => {
      const d = await call('dialog:folder', 'Yuklab olish papkasi');
      if (d) {
        dirLabel.textContent = d;
        set({ downloadDir: d });
      }
    },
  }, 'O‘zgartirish');

  const row = (label, control) => h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, label), control);
  const pace = segmented(
    [
      { value: 'smooth', label: 'Ping past' },
      { value: 'fast', label: 'Maksimal tezlik' },
    ],
    s.transferPace === 'fast' ? 'fast' : 'smooth',
    (v) => set({ transferPace: v }),
  );
  const updates = toggleRow('Yangilanishlarni tekshirish', 'GitHub’da Pult’ning yangi versiyasi chiqsa, holat qatorida taklif qilinadi.', s.checkUpdates !== false, (v) => set({ checkUpdates: v }));
  const checkNow = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => app.checkUpdate({ manual: true }) }, icon('refresh', 14), 'Hozir tekshirish');

  // AI agents on the server (Claude Code, agy).
  const usage = toggleRow('Limitlarni ko‘rsatish', 'Claude Code va agy obuna limitlari (5 soatlik, haftalik) holat qatorida turadi.', s.agentUsage !== false, (v) => set({ agentUsage: v }));
  const notify = toggleRow('Bildirishnomalar', 'Boshqa oynada bo‘lsangiz, agent ishni tugatganda yoki ruxsat so‘raganda xabar chiqadi.', s.agentNotify !== false, (v) => set({ agentNotify: v }));
  const newline = toggleRow('Shift+Enter — yangi qator', 'Claude Code va agy’da xabarni yubormasdan keyingi qatorga o‘tadi.', s.shiftEnterNewline !== false, (v) => set({ shiftEnterNewline: v }));
  const cmdInput = (key, fallback) => {
    const input = h('input', { class: 'input mono set-cmd', value: s[key] || fallback, placeholder: fallback, spellcheck: 'false' });
    input.addEventListener('change', () => set({ [key]: input.value.trim() || fallback }));
    return input;
  };

  const content = h(
    'div',
    // Focus lands here, not in the first text field (the agent commands).
    { class: 'settings', tabindex: '-1', autofocus: true },
    h(
      'div',
      { class: 'set-group' },
      h('div', { class: 'set-title' }, 'Ko‘rinish'),
      row('Mavzu', theme.el),
      row('Signal rangi', signal),
      row('Korpus rangi', body),
    ),
    h(
      'div',
      { class: 'set-group' },
      h('div', { class: 'set-title' }, 'Terminal'),
      row('Shrift o‘lchami', fontSize),
      row('Kursor', cursor.el),
      blink.el,
      copySel.el,
      restore.el,
      history.el,
    ),
    h(
      'div',
      { class: 'set-group' },
      h('div', { class: 'set-title' }, 'Fayllar'),
      row('Yuklab olish', h('div', { class: 'dir-row' }, dirLabel, pickDir)),
      row('Fayl uzatishda', pace.el),
      h('div', { class: 'set-hint' }, 'Ping past: fayl uzatilayotganda terminal va ping sekinlashmaydi, uzatish biroz sekinroq bo‘lishi mumkin. Maksimal tezlik: fayl eng tez uzatiladi, lekin ping va terminal kechikadi.'),
    ),
    h(
      'div',
      { class: 'set-group' },
      h('div', { class: 'set-title' }, 'AI agentlar (Claude Code, agy)'),
      usage.el,
      notify.el,
      newline.el,
      row('Claude buyrug‘i', cmdInput('claudeCmd', 'claude')),
      row('agy buyrug‘i', cmdInput('agyCmd', 'agy')),
    ),
    h('div', { class: 'set-group' }, h('div', { class: 'set-title' }, 'Yangilanish'), updates.el, h('div', { class: 'set-row' }, h('div', { class: 'set-label muted' }, `Hozirgi versiya: ${app.info.version}`), checkNow)),
    h(
      'div',
      { class: 'set-about' },
      icon('logo', 16),
      h('span', null, `Pult ${app.info.version}`),
      h('span', { class: 'muted' }, '· SSH · SFTP · tmux'),
    ),
  );

  await modal({ title: 'Sozlamalar', width: 520, body: content }).promise;
}
