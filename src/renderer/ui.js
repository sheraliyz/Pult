// Modals, menus, toasts, tooltips and form controls.

import { h, icon } from './dom.js';

const layer = () => document.getElementById('layer');

/* ---------------- modal ---------------- */

export function modal({ title, icon: ic, tone, body, actions = [], width = 440, dismiss = true, className = '' }) {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  const prevFocus = document.activeElement;
  let closed = false;

  const close = (value) => {
    if (closed) return;
    closed = true;
    back.classList.add('out');
    setTimeout(() => back.remove(), 140);
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.();
    resolve(value);
  };

  const buttons = actions.map((a) => {
    const b = h(
      'button',
      {
        class: `btn ${a.kind ? `btn-${a.kind}` : ''}`,
        type: 'button',
        onclick: async () => {
          if (b.disabled) return;
          if (!a.onClick) return close(a.value);
          b.disabled = true;
          try {
            const r = await a.onClick();
            if (r !== false) close(r === undefined ? a.value : r);
          } finally {
            b.disabled = false;
          }
        },
      },
      a.label,
    );
    if (a.kind === 'primary' || a.kind === 'danger') b.dataset.primary = '';
    return b;
  });

  const card = h(
    'div',
    { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true', style: { width: `${width}px` } },
    title &&
      h(
        'div',
        { class: 'm-head' },
        ic && h('span', { class: `m-icon ${tone ? `tone-${tone}` : ''}` }, icon(ic, 18)),
        h('div', { class: 'm-title' }, title),
        dismiss && h('button', { class: 'icon-btn m-close', type: 'button', 'aria-label': 'Yopish', onclick: () => close(null) }, icon('x', 16)),
      ),
    h('div', { class: 'm-body' }, body),
    buttons.length > 0 && h('div', { class: 'm-foot' }, buttons),
  );

  const back = h('div', { class: 'backdrop' }, card);
  back.addEventListener('mousedown', (e) => {
    if (e.target === back && dismiss) close(null);
  });
  back.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dismiss) {
      e.stopPropagation();
      close(null);
    } else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      const primary = card.querySelector('[data-primary]');
      if (primary) {
        e.preventDefault();
        primary.click();
      }
    }
  });

  layer().append(back);
  requestAnimationFrame(() => {
    const target = card.querySelector('[autofocus]') || card.querySelector('input:not([type=checkbox]), textarea') || card.querySelector('[data-primary]') || card;
    target.focus?.();
    if (target.select && target.dataset.select !== 'none') target.select();
  });

  return { close, promise, el: card };
}

export function confirmDialog({ title, message, confirm = 'Tasdiqlash', danger = false, icon: ic }) {
  return modal({
    title,
    icon: ic || (danger ? 'alert' : null),
    tone: danger ? 'danger' : null,
    width: 400,
    body: h('p', { class: 'm-text' }, message),
    actions: [
      { label: 'Bekor qilish', value: false },
      { label: confirm, kind: danger ? 'danger' : 'primary', value: true },
    ],
  }).promise.then((v) => v === true);
}

export function inputDialog({ title, label, value = '', placeholder = '', confirm = 'Saqlash', selectStem = false, validate }) {
  const input = h('input', { class: 'input', value, placeholder, spellcheck: 'false', 'data-select': 'none' });
  const error = h('div', { class: 'field-error' });
  const m = modal({
    title,
    width: 420,
    body: h('div', { class: 'field' }, label && h('label', { class: 'field-label' }, label), input, error),
    actions: [
      { label: 'Bekor qilish', value: null },
      {
        label: confirm,
        kind: 'primary',
        onClick: () => {
          const v = input.value.trim();
          const problem = !v ? 'Bo‘sh bo‘lmasin' : validate?.(v);
          if (problem) {
            error.textContent = problem;
            input.focus();
            return false;
          }
          return v;
        },
      },
    ],
  });
  requestAnimationFrame(() => {
    input.focus();
    const dot = value.lastIndexOf('.');
    if (selectStem && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
  return m.promise;
}

/* ---------------- toast ---------------- */

let toastBox = null;
export function toast(message, kind = 'info', ms = 2800) {
  if (!toastBox || !document.contains(toastBox)) {
    toastBox = h('div', { class: 'toasts' });
    layer().append(toastBox);
  }
  const ic = kind === 'err' ? 'alert' : kind === 'ok' ? 'check' : null;
  const t = h('div', { class: `toast toast-${kind}` }, ic && icon(ic, 15), h('span', null, message));
  toastBox.append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 200);
  }, ms);
}

/** A toast that stays (with a spinner) until the returned function is called. */
export function busy(message) {
  if (!toastBox || !document.contains(toastBox)) {
    toastBox = h('div', { class: 'toasts' });
    layer().append(toastBox);
  }
  const t = h('div', { class: 'toast toast-busy' }, h('span', { class: 'spinner' }), h('span', null, message));
  toastBox.append(t);
  return () => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 200);
  };
}

/* ---------------- context menu ---------------- */

let openMenu = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

export function menu(x, y, items) {
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu', tabindex: '-1' });
  const entries = [];
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      if (el.lastChild && !el.lastChild.classList.contains('menu-sep')) el.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    const b = h(
      'button',
      {
        class: `menu-item ${it.danger ? 'danger' : ''}`,
        type: 'button',
        role: 'menuitem',
        disabled: !!it.disabled,
        onclick: () => {
          closeMenu();
          it.onClick?.();
        },
      },
      h('span', { class: 'menu-ic' }, it.icon ? icon(it.icon, 15) : null),
      h('span', { class: 'menu-label' }, it.label),
      it.hint && h('span', { class: 'menu-hint' }, it.hint),
    );
    entries.push(b);
    el.append(b);
  }
  if (el.lastChild?.classList.contains('menu-sep')) el.lastChild.remove();
  layer().append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(6, Math.min(x, innerWidth - r.width - 6))}px`;
  el.style.top = `${Math.max(6, y + r.height > innerHeight - 6 ? y - r.height : y)}px`;
  openMenu = el;
  el.focus();

  let idx = -1;
  el.addEventListener('keydown', (e) => {
    const enabled = entries.filter((b) => !b.disabled);
    if (e.key === 'Escape') closeMenu();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
      enabled[idx]?.focus();
    }
  });
}

addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}, true);
addEventListener('blur', closeMenu);
addEventListener('resize', closeMenu);

/* ---------------- tooltips ---------------- */

let tip = null;
let tipTimer = null;
let tipFor = null;

function hideTip() {
  clearTimeout(tipTimer);
  tipFor = null;
  tip?.remove();
  tip = null;
}

document.addEventListener('mouseover', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (t === tipFor) return;
  hideTip();
  if (!t) return;
  tipFor = t;
  tipTimer = setTimeout(() => {
    if (!document.contains(t)) return;
    tip = h('div', { class: 'tooltip' }, t.dataset.tip);
    layer().append(tip);
    const r = t.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + tr.height > innerHeight - 4) top = r.top - tr.height - 6;
    const left = Math.max(6, Math.min(r.left + r.width / 2 - tr.width / 2, innerWidth - tr.width - 6));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }, 450);
});
document.addEventListener('mousedown', hideTip, true);
document.addEventListener('keydown', hideTip, true);

/* ---------------- form controls ---------------- */

export function field(label, control, hint) {
  return h(
    'div',
    { class: 'field' },
    label && h('label', { class: 'field-label' }, label),
    control,
    hint && h('div', { class: 'field-hint' }, hint),
  );
}

export function segmented(options, value, onChange) {
  const el = h('div', { class: 'segmented', role: 'tablist' });
  let current = value;
  const buttons = options.map((o) =>
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        class: o.value === value ? 'on' : '',
        onclick: () => set(o.value, true),
      },
      o.icon && icon(o.icon, 15),
      o.label,
    ),
  );
  el.append(...buttons);
  function set(v, notify) {
    current = v;
    buttons.forEach((b, i) => b.classList.toggle('on', options[i].value === v));
    if (notify) onChange?.(v);
  }
  return {
    el,
    get value() {
      return current;
    },
    set value(v) {
      set(v, false);
    },
  };
}

export function toggle(checked, onChange) {
  const input = h('input', { type: 'checkbox', checked: !!checked, onchange: () => onChange?.(input.checked) });
  const el = h('label', { class: 'switch' }, input, h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' })));
  return {
    el,
    get value() {
      return input.checked;
    },
  };
}

export function toggleRow(title, hint, checked, onChange) {
  const t = toggle(checked, onChange);
  const el = h(
    'div',
    { class: 'toggle-row' },
    h('div', { class: 'toggle-text' }, h('div', { class: 'toggle-title' }, title), hint && h('div', { class: 'toggle-hint' }, hint)),
    t.el,
  );
  return {
    el,
    get value() {
      return t.value;
    },
  };
}

export function passwordInput(props = {}) {
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', ...props });
  const eye = h('button', { class: 'icon-btn input-eye', type: 'button', tabindex: '-1', 'data-tip': 'Ko‘rsatish' }, icon('eye', 15));
  eye.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.replaceChildren(icon(show ? 'eyeOff' : 'eye', 15));
    input.focus();
  });
  const el = h('div', { class: 'input-wrap' }, input, eye);
  return { el, input };
}

export function checkbox(label, checked) {
  const input = h('input', { type: 'checkbox', checked: !!checked });
  const el = h('label', { class: 'check' }, input, h('span', { class: 'check-box' }, icon('check', 12)), h('span', null, label));
  return {
    el,
    get value() {
      return input.checked;
    },
  };
}
