// Server list (start screen) and the add / edit server form.

import { call } from './api.js';
import { h, icon, clear, fmt } from './dom.js';
import { modal, menu, toast, confirmDialog, field, segmented, toggleRow, passwordInput } from './ui.js';

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class Home {
  constructor(app) {
    this.app = app;
    this.query = '';
    this.el = h('section', { class: 'view home' });
    this.search = h('input', { class: 'input home-search-input', placeholder: 'Qidirish', spellcheck: 'false' });
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this.renderList();
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.listEl.querySelector('.srv')?.click();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.listEl.querySelector('.srv')?.focus();
      }
    });
    this.listEl = h('div', { class: 'srv-list' });
  }

  render() {
    const servers = this.app.servers;
    const importBtn =
      this.app.info.sshConfigHosts > 0 &&
      h('button', { class: 'btn btn-ghost', type: 'button', 'data-tip': '~/.ssh/config fayldan', onclick: () => this.importConfig() }, icon('import', 15), 'Import');

    const header = h(
      'div',
      { class: 'home-head' },
      h('div', { class: 'home-title' }, h('h1', null, 'Serverlar'), servers.length > 0 && h('span', { class: 'home-count' }, String(servers.length))),
      h(
        'div',
        { class: 'home-actions' },
        importBtn,
        servers.length > 0 && h('button', { class: 'btn btn-primary', type: 'button', onclick: () => this.app.editServer() }, icon('plus', 15), 'Yangi server'),
      ),
    );

    const body = servers.length
      ? [servers.length > 5 && h('label', { class: 'home-search' }, icon('search', 15), this.search), this.listEl]
      : this.emptyState();

    clear(
      this.el,
      h(
        'div',
        { class: 'home-inner' },
        header,
        body,
        h(
          'div',
          { class: 'home-hints' },
          hint('Ctrl', 'Shift', 'N', 'yangi server'),
          hint('Ctrl', 'Tab', 'oynalar'),
          hint('Ctrl', ',', 'sozlamalar'),
        ),
      ),
    );
    this.renderList();
  }

  emptyState() {
    return h(
      'div',
      { class: 'home-empty' },
      h('div', { class: 'home-empty-ic' }, icon('server', 24)),
      h('div', { class: 'home-empty-title' }, 'Hali server qo‘shilmagan'),
      h('div', { class: 'home-empty-text' }, 'Server qo‘shing — terminal va fayllar bir joyda, aloqa uzilsa ham sessiya saqlanadi.'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => this.app.editServer() }, icon('plus', 15), 'Server qo‘shish'),
    );
  }

  renderList() {
    const q = this.query;
    const list = this.app.servers
      .filter((s) => !q || `${s.name} ${s.host} ${s.username}`.toLowerCase().includes(q))
      .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || COLLATOR.compare(a.name, b.name));
    clear(this.listEl);
    if (!list.length && q) {
      this.listEl.append(h('div', { class: 'srv-none' }, 'Hech narsa topilmadi'));
      return;
    }
    for (const s of list) this.listEl.append(this.row(s));
  }

  row(s) {
    const live = this.app.sessionFor(s.id);
    const addr = `${s.username}@${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ''}`;
    const authIcon = s.auth === 'key' ? 'key' : s.auth === 'agent' ? 'shield' : 'lock';
    const el = h(
      'div',
      { class: 'srv', tabindex: '0', role: 'button', onclick: () => this.app.openServer(s) },
      h('div', { class: 'srv-avatar' }, (s.name || s.host).trim().charAt(0).toUpperCase()),
      h(
        'div',
        { class: 'srv-main' },
        h('div', { class: 'srv-name' }, s.name, live && h('span', { class: 'srv-live', dataset: { state: live.state.state }, 'data-tip': 'Ochiq' })),
        h('div', { class: 'srv-addr' }, icon(authIcon, 12), h('span', { class: 'mono' }, addr)),
      ),
      h('div', { class: 'srv-meta' }, fmt.ago(s.lastUsed)),
      h(
        'div',
        { class: 'srv-actions' },
        h('button', {
          class: 'icon-btn',
          type: 'button',
          'data-tip': 'Tahrirlash',
          onclick: (e) => {
            e.stopPropagation();
            this.app.editServer(s);
          },
        }, icon('pencil', 15)),
        h('button', {
          class: 'icon-btn',
          type: 'button',
          'data-tip': 'Yana',
          onclick: (e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            this.rowMenu(s, r.right - 180, r.bottom + 4);
          },
        }, icon('more', 15)),
      ),
      h('span', { class: 'srv-go' }, icon('chevron', 16)),
    );
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.app.openServer(s);
      else if (e.key === 'Delete') this.remove(s);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        (e.key === 'ArrowDown' ? el.nextElementSibling : el.previousElementSibling)?.focus();
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.rowMenu(s, e.clientX, e.clientY);
    });
    return el;
  }

  rowMenu(s, x, y) {
    menu(x, y, [
      { label: 'Ulanish', icon: 'terminal', onClick: () => this.app.openServer(s) },
      { label: 'Yangi oynada ulanish', icon: 'plus', onClick: () => this.app.openServer(s, true) },
      '-',
      { label: 'Tahrirlash', icon: 'pencil', onClick: () => this.app.editServer(s) },
      { label: 'Nusxa yaratish', icon: 'copy', onClick: () => this.duplicate(s) },
      { label: 'Manzilni nusxalash', icon: 'copy', onClick: () => call('clip:write', `${s.username}@${s.host}`) },
      '-',
      { label: 'O‘chirish', icon: 'trash', danger: true, onClick: () => this.remove(s) },
    ]);
  }

  async duplicate(s) {
    const { id, createdAt, lastUsed, hasPassword, hasPassphrase, ...rest } = s;
    await call('servers:save', { ...rest, name: `${s.name} (nusxa)` });
    await this.app.reloadServers();
  }

  async remove(s) {
    const ok = await confirmDialog({
      title: 'Serverni o‘chirish',
      message: `“${s.name}” ro‘yxatdan o‘chirilsinmi? Serverning o‘ziga hech narsa bo‘lmaydi.`,
      confirm: 'O‘chirish',
      danger: true,
    });
    if (!ok) return;
    await call('servers:delete', s.id);
    await this.app.reloadServers();
  }

  async importConfig() {
    const n = await call('servers:import');
    await this.app.reloadServers();
    this.app.info.sshConfigHosts = 0;
    this.render();
    toast(n ? `${n} ta server import qilindi` : 'Yangi server topilmadi', n ? 'ok' : 'info');
  }
}

function hint(...keys) {
  const label = keys.pop();
  return h('span', { class: 'hint' }, keys.map((k) => h('kbd', null, k)), h('span', null, label));
}

/* ---------------- server form ---------------- */

export function serverForm(server) {
  const s = server || { port: 22, auth: 'password', persist: true };
  const editing = !!server;

  const name = h('input', { class: 'input', value: s.name || '', placeholder: 'masalan, prod-web', spellcheck: 'false' });
  const host = h('input', { class: 'input', value: s.host || '', placeholder: 'example.com yoki 10.0.0.4', spellcheck: 'false', autofocus: !editing });
  const port = h('input', { class: 'input mono', value: String(s.port || 22), inputmode: 'numeric', spellcheck: 'false' });
  const user = h('input', { class: 'input', value: s.username || '', placeholder: 'root', spellcheck: 'false' });

  const pw = passwordInput({ placeholder: s.hasPassword ? '•••••••• saqlangan' : 'Bo‘sh qolsa, har safar so‘raladi' });
  const keyPath = h('input', { class: 'input mono', value: s.keyPath || '', placeholder: '~/.ssh/id_ed25519', spellcheck: 'false' });
  const pickKey = h('button', { class: 'btn', type: 'button', onclick: async () => {
    const p = await call('dialog:keyFile');
    if (p) keyPath.value = p;
  } }, 'Tanlash');
  const pass = passwordInput({ placeholder: s.hasPassphrase ? '•••••••• saqlangan' : 'Kalit shifrlanmagan bo‘lsa — bo‘sh' });
  const startDir = h('input', { class: 'input mono', value: s.startDir || '', placeholder: '~ (uy papkasi)', spellcheck: 'false' });

  const authPanels = {
    password: h('div', { class: 'auth-panel' }, field('Parol', pw.el)),
    key: h(
      'div',
      { class: 'auth-panel' },
      field('Kalit fayli', h('div', { class: 'input-row' }, keyPath, pickKey), 'Bo‘sh qolsa, ~/.ssh ichidagi standart kalit ishlatiladi'),
      field('Kalit paroli', pass.el),
    ),
    agent: h('div', { class: 'auth-panel' }, h('div', { class: 'note' }, icon('shield', 15), h('span', null, 'Windows OpenSSH agent’dagi kalitlar ishlatiladi (ssh-add bilan qo‘shilgan).'))),
  };
  const authBox = h('div', { class: 'auth-box' });
  const showAuth = (v) => clear(authBox, authPanels[v]);
  const auth = segmented(
    [
      { value: 'password', label: 'Parol', icon: 'lock' },
      { value: 'key', label: 'SSH kalit', icon: 'key' },
      { value: 'agent', label: 'Agent', icon: 'shield' },
    ],
    s.auth || 'password',
    showAuth,
  );
  showAuth(auth.value);

  const persist = toggleRow(
    'Sessiyani saqlash',
    'Aloqa uzilsa ham terminal va undagi jarayonlar o‘chmaydi (serverda tmux kerak).',
    s.persist !== false,
  );

  const error = h('div', { class: 'form-error' });

  const collect = () => {
    const data = {
      id: s.id,
      name: name.value.trim(),
      host: host.value.trim(),
      port: Number(port.value) || 22,
      username: user.value.trim(),
      auth: auth.value,
      keyPath: keyPath.value.trim(),
      persist: persist.value,
      startDir: startDir.value.trim(),
    };
    // user@host typed into the host field
    const m = data.host.match(/^([^@\s]+)@(.+)$/);
    if (m) {
      if (!data.username) data.username = m[1];
      data.host = m[2];
    }
    const hp = data.host.match(/^(.+):(\d+)$/);
    if (hp && !hp[1].includes(':')) {
      data.host = hp[1];
      data.port = Number(hp[2]);
    }
    if (pw.input.value) data.password = pw.input.value;
    if (pass.input.value) data.passphrase = pass.input.value;
    return data;
  };

  const validate = (d) => {
    if (!d.host) return [host, 'Server manzilini kiriting'];
    if (!d.username) return [user, 'Foydalanuvchi nomini kiriting'];
    if (d.port < 1 || d.port > 65535) return [port, 'Port 1–65535 oralig‘ida bo‘lsin'];
    return null;
  };

  const submit = async (connect) => {
    const d = collect();
    const problem = validate(d);
    if (problem) {
      error.textContent = problem[1];
      problem[0].focus();
      return false;
    }
    try {
      const saved = await call('servers:save', d);
      return { server: saved, connect };
    } catch (err) {
      error.textContent = err.message;
      return false;
    }
  };

  const clearSecrets =
    editing &&
    (s.hasPassword || s.hasPassphrase) &&
    h('button', {
      class: 'link-btn',
      type: 'button',
      onclick: async (e) => {
        await call('servers:save', { id: s.id, password: '', passphrase: '' });
        e.currentTarget.replaceWith(h('span', { class: 'muted' }, 'Saqlangan parollar o‘chirildi'));
        pw.input.placeholder = 'Bo‘sh qolsa, har safar so‘raladi';
        pass.input.placeholder = 'Kalit shifrlanmagan bo‘lsa — bo‘sh';
      },
    }, 'Saqlangan parolni unutish');

  const body = h(
    'div',
    { class: 'server-form' },
    h('div', { class: 'grid-2' }, field('Server', host), field('Port', port)),
    h('div', { class: 'grid-2b' }, field('Foydalanuvchi', user), field('Nomi', name)),
    field('Kirish usuli', auth.el),
    authBox,
    h('div', { class: 'form-sep' }),
    persist.el,
    field('Boshlang‘ich papka', startDir),
    clearSecrets,
    error,
  );

  return modal({
    title: editing ? 'Serverni tahrirlash' : 'Yangi server',
    width: 500,
    body,
    actions: [
      { label: 'Bekor qilish', value: null },
      { label: 'Saqlash', onClick: () => submit(false) },
      { label: editing ? 'Saqlash va ulanish' : 'Ulanish', kind: 'primary', onClick: () => submit(true) },
    ],
  }).promise;
}
