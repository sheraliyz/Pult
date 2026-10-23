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

  const body = h(
    'div',
    { class: 'settings' },
    h('div', { class: 'set-group' }, h('div', { class: 'set-title' }, 'Ko‘rinish'), row('Mavzu', theme.el)),
    h(
      'div',
      { class: 'set-group' },
      h('div', { class: 'set-title' }, 'Terminal'),
      row('Shrift o‘lchami', fontSize),
      row('Kursor', cursor.el),
      blink.el,
      copySel.el,
    ),
    h('div', { class: 'set-group' }, h('div', { class: 'set-title' }, 'Fayllar'), row('Yuklab olish', h('div', { class: 'dir-row' }, dirLabel, pickDir))),
    h(
      'div',
      { class: 'set-about' },
      icon('logo', 16),
      h('span', null, `Pult ${app.info.version}`),
      h('span', { class: 'muted' }, '· SSH · SFTP · tmux'),
    ),
  );

  await modal({ title: 'Sozlamalar', width: 500, body }).promise;
}
