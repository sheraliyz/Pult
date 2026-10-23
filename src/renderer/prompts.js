// Questions the main process asks during connect: host keys, passwords, 2FA.

import { raw } from './api.js';
import { h, icon } from './dom.js';
import { modal, field, passwordInput, checkbox } from './ui.js';

export async function handlePrompt(p) {
  let answer = null;
  if (p.kind === 'hostkey') answer = await hostKey(p);
  else if (p.kind === 'password' || p.kind === 'passphrase') answer = await secret(p);
  else if (p.kind === 'interactive') answer = await interactive(p);
  raw('prompt:answer', p.id, answer);
}

function hostKey(p) {
  const changed = !!p.previous;
  const body = h(
    'div',
    { class: 'prompt' },
    h(
      'p',
      { class: 'm-text' },
      changed
        ? h('span', null, h('b', null, p.host), ' serverining kaliti avvalgisidan farq qiladi. Agar serverni qayta o‘rnatmagan bo‘lsangiz, bu hujum belgisi bo‘lishi mumkin — ulanmang.')
        : h('span', null, h('b', null, p.host), ' ga birinchi marta ulanmoqdasiz. Kalit barmoq izi server administratori bergan bilan bir xil ekanini tekshiring.'),
    ),
    changed && h('div', { class: 'fp-block old' }, h('div', { class: 'fp-label' }, 'Avvalgi'), h('div', { class: 'fp mono' }, p.previous)),
    h('div', { class: `fp-block ${changed ? 'new' : ''}` }, h('div', { class: 'fp-label' }, changed ? `Yangi · ${p.type}` : p.type), h('div', { class: 'fp mono' }, p.fingerprint)),
  );
  return modal({
    title: changed ? 'Server kaliti o‘zgargan!' : 'Serverni tasdiqlang',
    icon: changed ? 'alert' : 'shield',
    tone: changed ? 'danger' : null,
    width: 480,
    dismiss: false,
    body,
    actions: [
      { label: changed ? 'Ulanmaslik' : 'Bekor qilish', value: false },
      { label: changed ? 'Baribir ishonaman' : 'Ishonaman, ulanish', kind: changed ? 'danger' : 'primary', value: true },
    ],
  }).promise.then((v) => v === true);
}

function secret(p) {
  const isPass = p.kind === 'passphrase';
  const pw = passwordInput({ autofocus: true });
  const save = checkbox(isPass ? 'Kalit parolini saqlash' : 'Parolni saqlash', true);
  const body = h(
    'div',
    { class: 'prompt' },
    p.retry && h('div', { class: 'form-error shown' }, icon('alert', 14), isPass ? 'Kalit paroli noto‘g‘ri' : 'Parol noto‘g‘ri, qaytadan kiriting'),
    field(
      isPass ? 'Kalit paroli' : `${p.user}@${p.host} uchun parol`,
      pw.el,
      isPass ? p.keyPath : null,
    ),
    save.el,
  );
  return modal({
    title: isPass ? 'Kalit qulflangan' : p.server,
    icon: isPass ? 'key' : 'lock',
    width: 400,
    dismiss: true,
    body,
    actions: [
      { label: 'Bekor qilish', value: null },
      { label: 'Ulanish', kind: 'primary', onClick: () => (pw.input.value ? { value: pw.input.value, save: save.value } : false) },
    ],
  }).promise;
}

function interactive(p) {
  const inputs = p.prompts.map((q) => {
    const el = q.echo ? h('input', { class: 'input', spellcheck: 'false' }) : passwordInput().input;
    return { q, el };
  });
  const body = h(
    'div',
    { class: 'prompt' },
    (p.name || p.instructions) && h('p', { class: 'm-text' }, [p.name, p.instructions].filter(Boolean).join(' — ')),
    inputs.map(({ q, el }) => field(q.prompt.trim().replace(/:$/, ''), el.parentElement?.classList.contains('input-wrap') ? el.parentElement : el)),
  );
  return modal({
    title: p.server,
    icon: 'shield',
    width: 400,
    body,
    actions: [
      { label: 'Bekor qilish', value: null },
      { label: 'Yuborish', kind: 'primary', onClick: () => inputs.map(({ el }) => el.value) },
    ],
  }).promise;
}
