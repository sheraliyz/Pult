// SFTP file browser for one session.

import { call, pathForFile } from './api.js';
import { h, icon, clear, fmt, posix } from './dom.js';
import { menu, toast, confirmDialog, inputDialog, modal, busy, segmented, field } from './ui.js';
import { openEditor } from './editor.js';
import { kindOf, kindIcon, KIND_LABEL } from './filekinds.js';
import { agentMenuItems } from './agents.js';

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const ARCHIVE_RE = /(\.tar\.(?:gz|bz2|xz|zst|lz4)|\.tgz|\.tbz2?|\.txz|\.tar|\.zip|\.7z|\.rar|\.gz|\.bz2|\.xz|\.zst)$/i;
const isDirLike = (e) => e.type === 'dir' || (e.type === 'link' && e.target === 'dir');

// Copy / cut "clipboard" for files, shared by every file view. Pasting only
// works on the same connection (the copy happens on the server itself).
let clip = null; // { connId, cut, items: [{ path, type, name }] }
const views = new Set();
function setClip(next) {
  clip = next;
  for (const v of views) v.renderClip();
}

export class FilesView {
  constructor(session) {
    this.session = session;
    this.cwd = '';
    this.entries = [];
    this.selected = new Set();
    this.anchor = null;
    this.cursor = null;
    this.sort = { key: 'name', dir: 1 };
    this.showHidden = false;
    this.filter = '';
    this.history = [];
    this.loaded = false;
    this.loading = false;
    this.error = null;
    this.build();
  }

  get connId() {
    return this.session.id;
  }

  /* ---------------- DOM ---------------- */

  build() {
    this.backBtn = h('button', { class: 'icon-btn', type: 'button', 'data-tip': 'Orqaga', onclick: () => this.back() }, icon('back', 16));
    this.upBtn = h('button', { class: 'icon-btn', type: 'button', 'data-tip': 'Yuqori papka (Backspace)', onclick: () => this.up() }, icon('up', 16));
    this.crumbs = h('div', { class: 'crumbs', 'data-tip': 'Yo‘lni yozish uchun bosing' });
    this.crumbs.addEventListener('click', (e) => {
      if (e.target === this.crumbs) this.editPath();
    });
    this.pathInput = h('input', { class: 'crumbs-input', spellcheck: 'false', hidden: true });
    this.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = this.pathInput.value.trim();
        this.stopEditPath();
        if (v) this.go(v.replace(/^~(?=\/|$)/, this.session.state.home || '~'));
      } else if (e.key === 'Escape') {
        this.stopEditPath();
      }
    });
    this.pathInput.addEventListener('blur', () => this.stopEditPath());

    this.filterInput = h('input', { class: 'f-filter-input', placeholder: 'Filtr', spellcheck: 'false' });
    this.filterInput.addEventListener('input', () => {
      this.filter = this.filterInput.value.trim().toLowerCase();
      this.filterInput.parentElement.classList.toggle('has-value', !!this.filter);
      this.renderRows();
    });
    this.filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.clearFilter();
        this.renderRows();
        this.list.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.list.focus();
        this.moveCursor(1, false);
      }
    });

    const toolbar = h(
      'div',
      { class: 'f-toolbar' },
      h('div', { class: 'f-nav' }, this.backBtn, this.upBtn),
      h('div', { class: 'crumbs-wrap' }, this.crumbs, this.pathInput),
      h('label', { class: 'f-filter' }, icon('search', 14), this.filterInput),
      h(
        'div',
        { class: 'f-actions' },
        h('button', { class: 'icon-btn', type: 'button', 'data-tip': 'Papkalar ichidan qidirish · Ctrl+Shift+F', onclick: () => this.openSearch() }, icon('search', 16)),
        h('button', { class: 'icon-btn', type: 'button', 'data-tip': 'Yangilash (F5)', onclick: () => this.refresh() }, icon('refresh', 16)),
        h('button', { class: 'icon-btn', type: 'button', 'data-tip': 'Yangi papka', onclick: () => this.newFolder() }, icon('folderPlus', 16)),
        h('button', { class: 'icon-btn', type: 'button', 'data-tip': 'Yangi fayl', onclick: () => this.newFile() }, icon('filePlus', 16)),
        h(
          'button',
          {
            class: 'btn btn-sm',
            type: 'button',
            onclick: (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              menu(r.left, r.bottom + 4, [
                { label: 'Fayllar', icon: 'file', onClick: () => this.pickUpload(false) },
                { label: 'Papka', icon: 'folder', onClick: () => this.pickUpload(true) },
              ]);
            },
          },
          icon('upload', 15),
          h('span', { class: 'btn-label' }, 'Yuklash'),
        ),
      ),
    );

    const col = (key, label, cls) =>
      h('button', { class: `f-col ${cls}`, type: 'button', dataset: { key }, onclick: () => this.setSort(key) }, label, h('span', { class: 'sort-ic' }));
    this.head = h(
      'div',
      { class: 'f-head f-grid' },
      col('name', 'Nomi', 'c-name'),
      col('size', 'Hajmi', 'c-size'),
      col('mtime', 'O‘zgartirilgan', 'c-date'),
      col('mode', 'Huquqlar', 'c-mode'),
      col('owner', 'Egasi', 'c-owner'),
    );

    this.list = h('div', { class: 'f-list', tabindex: '0' });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('mousedown', (e) => {
      if (e.target === this.list || e.target === this.rowsEl) {
        this.selected.clear();
        this.cursor = null;
        this.paintSelection();
      }
    });
    this.list.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.f-row')) return;
      e.preventDefault();
      this.selected.clear();
      this.paintSelection();
      this.dirMenu(e.clientX, e.clientY);
    });
    this.rowsEl = h('div', { class: 'f-rows' });
    this.empty = h('div', { class: 'f-empty', hidden: true });
    this.list.append(this.rowsEl, this.empty);

    this.dropHint = h('div', { class: 'f-drop' }, h('div', { class: 'f-drop-card' }, icon('upload', 22), h('div', { class: 'f-drop-text' })));
    this.loadingBar = h('div', { class: 'f-loading' });

    this.clipBar = h('div', { class: 'f-clip', hidden: true });
    this.el = h('div', { class: 'files' }, toolbar, this.loadingBar, this.clipBar, this.head, this.list, this.dropHint);
    views.add(this);
    // Long paths: always keep the current folder (the end) in view.
    new ResizeObserver(() => (this.crumbs.scrollLeft = this.crumbs.scrollWidth)).observe(this.crumbs);
    this.setupDrop();
    this.paintSortHeader();
  }

  /* ---------------- navigation ---------------- */

  async init() {
    if (this.loaded || this.loading) return;
    let start = this.session.server.startDir || this.session.state.home;
    if (!start) start = await call('sftp:home', this.connId).catch(() => '/');
    if (start.startsWith('~')) start = (this.session.state.home || '') + start.slice(1);
    await this.go(start || '/', { record: false });
  }

  async go(path, { record = true, keepSelection = false } = {}) {
    this.loading = true;
    this.el.classList.add('is-loading');
    try {
      const r = await call('sftp:list', this.connId, path);
      if (record && this.cwd && r.path !== this.cwd) this.history.push(this.cwd);
      const changed = r.path !== this.cwd;
      this.cwd = r.path;
      this.entries = r.entries;
      this.loaded = true;
      this.error = null;
      if (changed) this.clearFilter();
      if (!keepSelection || changed) {
        this.selected.clear();
        this.cursor = null;
      } else {
        const names = new Set(this.entries.map((e) => e.name));
        for (const n of [...this.selected]) if (!names.has(n)) this.selected.delete(n);
      }
      this.render();
      return true;
    } catch (err) {
      if (!this.loaded) {
        this.error = err;
        this.render();
      } else {
        toast(err.message, 'err');
      }
      return false;
    } finally {
      this.loading = false;
      this.el.classList.remove('is-loading');
    }
  }

  clearFilter() {
    this.filterInput.value = '';
    this.filter = '';
    this.filterInput.parentElement.classList.remove('has-value');
  }

  refresh() {
    if (!this.cwd) return this.init();
    return this.go(this.cwd, { record: false, keepSelection: true });
  }

  back() {
    const prev = this.history.pop();
    if (prev) this.go(prev, { record: false });
  }

  up() {
    if (this.cwd && this.cwd !== '/') {
      const from = posix.basename(this.cwd);
      this.go(posix.dirname(this.cwd)).then((ok) => {
        if (ok && this.entries.some((e) => e.name === from)) {
          this.selected = new Set([from]);
          this.cursor = from;
          this.paintSelection(true);
        }
      });
    }
  }

  editPath() {
    this.crumbs.hidden = true;
    this.pathInput.hidden = false;
    this.pathInput.value = this.cwd;
    this.pathInput.focus();
    this.pathInput.select();
  }

  stopEditPath() {
    this.pathInput.hidden = true;
    this.crumbs.hidden = false;
  }

  /* ---------------- rendering ---------------- */

  visible() {
    let list = this.entries;
    if (!this.showHidden) list = list.filter((e) => !e.name.startsWith('.'));
    if (this.filter) list = list.filter((e) => e.name.toLowerCase().includes(this.filter));
    const { key, dir } = this.sort;
    const isDirLike = (e) => e.type === 'dir' || (e.type === 'link' && e.target === 'dir');
    return [...list].sort((a, b) => {
      const da = isDirLike(a);
      const db = isDirLike(b);
      if (da !== db) return da ? -1 : 1;
      let c = 0;
      if (key === 'size') c = (a.size || 0) - (b.size || 0);
      else if (key === 'mtime') c = (a.mtime || 0) - (b.mtime || 0);
      else if (key === 'mode') c = a.mode - b.mode;
      else if (key === 'owner') c = COLLATOR.compare(a.owner, b.owner);
      if (c === 0) c = COLLATOR.compare(a.name, b.name);
      return c * dir;
    });
  }

  render() {
    this.renderCrumbs();
    this.backBtn.disabled = this.history.length === 0;
    this.upBtn.disabled = !this.cwd || this.cwd === '/';
    this.renderRows();
    this.session.onFilesPathChange?.();
  }

  renderCrumbs() {
    clear(this.crumbs);
    if (!this.cwd) return;
    const parts = this.cwd.split('/').filter(Boolean);
    const root = h('button', { class: 'crumb', type: 'button', onclick: () => this.go('/') }, '/');
    this.crumbs.append(root);
    let acc = '';
    parts.forEach((p, i) => {
      acc += `/${p}`;
      const target = acc;
      if (i > 0) this.crumbs.append(h('span', { class: 'crumb-sep' }, '/'));
      this.crumbs.append(
        h('button', { class: `crumb ${i === parts.length - 1 ? 'current' : ''}`, type: 'button', onclick: () => this.go(target) }, p),
      );
    });
    this.crumbs.scrollLeft = this.crumbs.scrollWidth;
  }

  renderRows() {
    clear(this.rowsEl);
    if (this.error && !this.loaded) {
      this.showEmpty('alert', 'Papkani ochib bo‘lmadi', this.error.message, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.init() }, 'Qayta urinish'));
      return;
    }
    const rows = this.visible();
    this.rowsCache = rows;
    if (!rows.length) {
      if (this.filter) this.showEmpty('search', 'Hech narsa topilmadi', `“${this.filterInput.value}” bo‘yicha natija yo‘q`);
      else if (this.loaded) this.showEmpty('folder', 'Bo‘sh papka', 'Fayllarni shu yerga sudrab tashlang');
      else this.empty.hidden = true;
      return;
    }
    this.empty.hidden = true;
    const frag = document.createDocumentFragment();
    for (const e of rows) frag.append(this.row(e));
    this.rowsEl.append(frag);
    this.paintSelection();
  }

  showEmpty(ic, title, text, extra) {
    clear(this.empty, h('div', { class: 'f-empty-ic' }, icon(ic, 22)), h('div', { class: 'f-empty-title' }, title), text && h('div', { class: 'f-empty-text' }, text), extra);
    this.empty.hidden = false;
  }

  row(e) {
    const isDir = e.type === 'dir' || (e.type === 'link' && e.target === 'dir');
    const kind = kindOf(e);
    const nameCell = h(
      'span',
      { class: 'c-name' },
      h('span', { class: `f-ic k-${kind}`, 'data-tip': KIND_LABEL[kind] }, kindIcon(kind, 15)),
      h('span', { class: 'f-name' }, e.name),
      e.type === 'link' && h('span', { class: 'f-link', 'data-tip': e.target === 'broken' ? 'Buzilgan havola' : 'Simvolik havola' }, icon('link', 13)),
    );
    const el = h(
      'div',
      { class: `f-row f-grid ${isDir ? 'is-dir' : ''} ${e.name.startsWith('.') ? 'is-hidden' : ''}`, dataset: { name: e.name }, draggable: 'false' },
      nameCell,
      h('span', { class: 'c-size' }, isDir ? 'papka' : fmt.bytes(e.size)),
      h('span', { class: 'c-date' }, fmt.date(e.mtime)),
      h('span', { class: 'c-mode mono' }, fmt.mode(e.mode, e.type)),
      h('span', { class: 'c-owner' }, e.owner),
    );
    el.addEventListener('mousedown', (ev) => this.onRowDown(ev, e));
    el.addEventListener('dblclick', () => this.open(e));
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (!this.selected.has(e.name)) {
        this.selected = new Set([e.name]);
        this.anchor = e.name;
      }
      this.cursor = e.name;
      this.paintSelection();
      this.rowMenu(ev.clientX, ev.clientY);
    });
    if (isDir) {
      el.addEventListener('dragover', (ev) => {
        if (!hasFiles(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        el.classList.add('drop-target');
        this.showDrop(posix.join(this.cwd, e.name));
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
      el.addEventListener('drop', (ev) => {
        el.classList.remove('drop-target');
        if (!hasFiles(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.hideDrop();
        this.uploadPaths(filesFrom(ev), posix.join(this.cwd, e.name), false);
      });
    }
    return el;
  }

  paintSelection(scroll = false) {
    for (const el of this.rowsEl.children) {
      const name = el.dataset.name;
      el.classList.toggle('selected', this.selected.has(name));
      el.classList.toggle('cursor', this.cursor === name);
      if (scroll && this.cursor === name) el.scrollIntoView({ block: 'nearest' });
    }
  }

  paintSortHeader() {
    for (const c of this.head.querySelectorAll('.f-col')) {
      const on = c.dataset.key === this.sort.key;
      c.classList.toggle('sorted', on);
      c.querySelector('.sort-ic').replaceChildren(on ? icon(this.sort.dir > 0 ? 'arrowUp' : 'arrowDown', 12) : '');
    }
  }

  setSort(key) {
    this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : 1 };
    this.paintSortHeader();
    this.renderRows();
  }

  /* ---------------- selection & keys ---------------- */

  onRowDown(ev, e) {
    if (ev.button !== 0) return;
    this.list.focus({ preventScroll: true });
    const names = this.rowsCache.map((x) => x.name);
    if (ev.shiftKey && this.anchor) {
      const a = names.indexOf(this.anchor);
      const b = names.indexOf(e.name);
      const [from, to] = a < b ? [a, b] : [b, a];
      this.selected = new Set(names.slice(from, to + 1));
    } else if (ev.ctrlKey) {
      if (this.selected.has(e.name)) this.selected.delete(e.name);
      else this.selected.add(e.name);
      this.anchor = e.name;
    } else {
      this.selected = new Set([e.name]);
      this.anchor = e.name;
    }
    this.cursor = e.name;
    this.paintSelection();
  }

  moveCursor(delta, extend) {
    const names = (this.rowsCache || []).map((x) => x.name);
    if (!names.length) return;
    let i = names.indexOf(this.cursor);
    i = i < 0 ? (delta > 0 ? 0 : names.length - 1) : Math.max(0, Math.min(names.length - 1, i + delta));
    this.cursor = names[i];
    if (extend && this.anchor) {
      const a = names.indexOf(this.anchor);
      const [from, to] = a < i ? [a, i] : [i, a];
      this.selected = new Set(names.slice(from, to + 1));
    } else {
      this.selected = new Set([this.cursor]);
      this.anchor = this.cursor;
    }
    this.paintSelection(true);
  }

  selectedEntries() {
    return this.entries.filter((e) => this.selected.has(e.name));
  }

  onKey(e) {
    const ctrl = e.ctrlKey && !e.altKey;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.moveCursor(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      this.moveCursor(e.key === 'Home' ? -1e9 : 1e9, e.shiftKey);
    } else if (e.key === 'Enter' && !e.altKey) {
      const cur = this.entries.find((x) => x.name === this.cursor);
      if (cur) this.open(cur);
    } else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) {
      e.preventDefault();
      this.up();
    } else if (e.altKey && e.key === 'ArrowLeft') {
      this.back();
    } else if (e.key === 'Delete') {
      this.remove();
    } else if (e.key === 'F2') {
      this.rename();
    } else if (e.key === 'F5') {
      e.preventDefault();
      this.refresh();
    } else if (ctrl && e.code === 'KeyA') {
      e.preventDefault();
      this.selected = new Set(this.rowsCache.map((x) => x.name));
      this.paintSelection();
    } else if (ctrl && !e.shiftKey && (e.code === 'KeyC' || e.code === 'KeyX')) {
      e.preventDefault();
      this.copySelection(e.code === 'KeyX');
    } else if (ctrl && !e.shiftKey && e.code === 'KeyV') {
      e.preventDefault();
      this.paste();
    } else if (ctrl && !e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      this.duplicate();
    } else if (e.altKey && e.key === 'Enter') {
      e.preventDefault();
      const [one] = this.selectedEntries();
      this.properties(one || null);
    } else if (ctrl && e.shiftKey && e.code === 'KeyF') {
      e.preventDefault();
      this.openSearch();
    } else if (ctrl && e.code === 'KeyF') {
      e.preventDefault();
      this.filterInput.focus();
      this.filterInput.select();
    } else if (ctrl && e.code === 'KeyL') {
      e.preventDefault();
      this.editPath();
    } else if (ctrl && e.shiftKey && e.code === 'Period') {
      this.toggleHidden();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Type to jump to a name.
      this.typeAhead = (Date.now() - (this.typeAt || 0) < 700 ? this.typeAhead || '' : '') + e.key.toLowerCase();
      this.typeAt = Date.now();
      const hit = this.rowsCache.find((x) => x.name.toLowerCase().startsWith(this.typeAhead));
      if (hit) {
        this.cursor = hit.name;
        this.selected = new Set([hit.name]);
        this.anchor = hit.name;
        this.paintSelection(true);
      }
    }
  }

  toggleHidden() {
    this.showHidden = !this.showHidden;
    this.renderRows();
    toast(this.showHidden ? 'Yashirin fayllar ko‘rsatilmoqda' : 'Yashirin fayllar berkitildi', 'info', 1400);
  }

  /* ---------------- menus ---------------- */

  rowMenu(x, y) {
    const items = this.selectedEntries();
    if (!items.length) return;
    const single = items.length === 1 ? items[0] : null;
    const isDir = single && isDirLike(single);
    const archive = single && !isDir && ARCHIVE_RE.test(single.name);
    const binary = single && ['apk', 'exe', 'package', 'archive', 'image', 'video', 'audio', 'pdf', 'doc', 'font'].includes(kindOf(single));
    const canPaste = this.canPaste();
    menu(x, y, [
      single && isDir && { label: 'Ochish', icon: 'folder', hint: 'Enter', onClick: () => this.open(single) },
      single && !isDir && !binary && { label: 'Tahrirlash', icon: 'pencil', hint: 'Enter', onClick: () => this.edit(single) },
      single && isDir && { label: 'Terminalda ochish', icon: 'terminal', onClick: () => this.session.cdInTerminal(posix.join(this.cwd, single.name)) },
      ...(single && isDir ? agentMenuItems(this.session, { dir: posix.join(this.cwd, single.name) }) : []),
      archive && { label: 'Shu yerga ochish', icon: 'unarchive', onClick: () => this.extract(single, 'here') },
      archive && { label: `“${single.name.replace(ARCHIVE_RE, '')}/” papkasiga ochish`, icon: 'unarchive', onClick: () => this.extract(single, 'folder') },
      '-',
      { label: 'Nusxalash', icon: 'copy', hint: 'Ctrl+C', onClick: () => this.copySelection(false) },
      { label: 'Kesib olish', icon: 'scissors', hint: 'Ctrl+X', onClick: () => this.copySelection(true) },
      single && isDir && canPaste && { label: 'Shu papkaga qo‘yish', icon: 'paste', onClick: () => this.paste(posix.join(this.cwd, single.name)) },
      { label: 'Dublikat', icon: 'duplicate', hint: 'Ctrl+D', onClick: () => this.duplicate() },
      { label: 'Arxivlash…', icon: 'archive', onClick: () => this.compress(items) },
      '-',
      { label: 'Yuklab olish', icon: 'download', onClick: () => this.download(items) },
      { label: 'Yuklab olish…', icon: 'reveal', onClick: () => this.download(items, true) },
      '-',
      single && { label: 'Nomini o‘zgartirish', icon: 'pencil', hint: 'F2', onClick: () => this.rename() },
      single && { label: 'Huquqlar', icon: 'lock', onClick: () => this.chmod(single) },
      { label: 'Yo‘lni nusxalash', icon: 'copy', onClick: () => this.copyPaths(items) },
      single && { label: 'Xususiyatlar', icon: 'info', hint: 'Alt+Enter', onClick: () => this.properties(single) },
      '-',
      { label: 'O‘chirish', icon: 'trash', hint: 'Del', danger: true, onClick: () => this.remove() },
    ]);
  }

  dirMenu(x, y) {
    menu(x, y, [
      this.canPaste() && { label: `Qo‘yish (${clip.items.length})`, icon: 'paste', hint: 'Ctrl+V', onClick: () => this.paste() },
      this.canPaste() && '-',
      { label: 'Yangi papka', icon: 'folderPlus', onClick: () => this.newFolder() },
      { label: 'Yangi fayl', icon: 'filePlus', onClick: () => this.newFile() },
      { label: 'Fayllarni yuklash', icon: 'upload', onClick: () => this.pickUpload(false) },
      '-',
      { label: 'Shu papkada qidirish', icon: 'search', hint: 'Ctrl+Shift+F', onClick: () => this.openSearch() },
      { label: 'Papka xususiyatlari', icon: 'info', onClick: () => this.properties(null) },
      { label: 'Terminalda ochish', icon: 'terminal', onClick: () => this.session.cdInTerminal(this.cwd) },
      ...agentMenuItems(this.session, { dir: this.cwd }),
      { label: 'Yo‘lni nusxalash', icon: 'copy', onClick: () => call('clip:write', this.cwd) },
      { label: this.showHidden ? 'Yashirin fayllarni berkitish' : 'Yashirin fayllarni ko‘rsatish', icon: this.showHidden ? 'eyeOff' : 'eye', hint: 'Ctrl+Shift+.', onClick: () => this.toggleHidden() },
      { label: 'Yangilash', icon: 'refresh', hint: 'F5', onClick: () => this.refresh() },
    ]);
  }

  /* ---------------- actions ---------------- */

  open(e) {
    const isDir = e.type === 'dir' || (e.type === 'link' && e.target === 'dir');
    if (isDir) this.go(posix.join(this.cwd, e.name));
    else this.edit(e);
  }

  async edit(e, { path: fullPath, line } = {}) {
    const path = fullPath || posix.join(this.cwd, e.name);
    try {
      const r = await call('sftp:readText', this.connId, path);
      openEditor(this.session, path, r.text, () => this.refresh(), { line });
    } catch (err) {
      if (err.code === 'BINARY' || err.code === 'TOO_BIG') {
        const ok = await confirmDialog({
          title: err.code === 'BINARY' ? 'Matnli fayl emas' : 'Fayl juda katta',
          message: `“${posix.basename(path)}” ni tahrirlab bo‘lmaydi. Kompyuterga yuklab olinsinmi?`,
          confirm: 'Yuklab olish',
          icon: 'download',
        });
        if (ok) call('xfer:download', this.connId, [path], null);
      } else {
        toast(err.message, 'err');
      }
    }
  }

  async newFolder() {
    const name = await inputDialog({ title: 'Yangi papka', label: `${this.cwd} ichida`, placeholder: 'papka-nomi', confirm: 'Yaratish', validate: validName });
    if (!name) return;
    try {
      await call('sftp:mkdir', this.connId, posix.join(this.cwd, name));
      await this.refresh();
      this.select(name);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async newFile() {
    const name = await inputDialog({ title: 'Yangi fayl', label: `${this.cwd} ichida`, placeholder: 'fayl.txt', confirm: 'Yaratish', validate: validName });
    if (!name) return;
    const path = posix.join(this.cwd, name);
    try {
      await call('sftp:touch', this.connId, path);
      await this.refresh();
      this.select(name);
      openEditor(this.session, path, '', () => this.refresh());
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  select(name) {
    this.selected = new Set([name]);
    this.cursor = name;
    this.anchor = name;
    this.paintSelection(true);
    this.list.focus();
  }

  async rename() {
    const [e] = this.selectedEntries();
    if (!e) return;
    const name = await inputDialog({ title: 'Nomini o‘zgartirish', value: e.name, confirm: 'Saqlash', selectStem: e.type !== 'dir', validate: validName });
    if (!name || name === e.name) return;
    try {
      await call('sftp:rename', this.connId, posix.join(this.cwd, e.name), posix.join(this.cwd, name));
      await this.refresh();
      this.select(name);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async remove() {
    const items = this.selectedEntries();
    if (!items.length) return;
    const what = items.length === 1 ? `“${items[0].name}”` : `${items.length} ta element`;
    const hasDir = items.some((e) => e.type === 'dir');
    const ok = await confirmDialog({
      title: 'O‘chirish',
      message: `${what} butunlay o‘chirilsinmi?${hasDir ? ' Papkalar ichidagi hamma narsa bilan o‘chadi.' : ''} Bu amalni qaytarib bo‘lmaydi.`,
      confirm: 'O‘chirish',
      danger: true,
    });
    if (!ok) return;
    try {
      await call('sftp:delete', this.connId, items.map((e) => ({ path: posix.join(this.cwd, e.name), type: e.type })));
      toast(`${what} o‘chirildi`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    this.refresh();
  }

  async chmod(e) {
    const path = posix.join(this.cwd, e.name);
    const bits = [
      ['Egasi', 6],
      ['Guruh', 3],
      ['Boshqalar', 0],
    ];
    let mode = e.mode & 0o777;
    const octal = h('input', { class: 'input mono chmod-octal', value: fmt.octal(mode), maxlength: '4', spellcheck: 'false' });
    const boxes = [];
    const grid = h('div', { class: 'chmod-grid' }, h('span'), h('span', { class: 'chmod-h' }, 'O‘qish'), h('span', { class: 'chmod-h' }, 'Yozish'), h('span', { class: 'chmod-h' }, 'Bajarish'));
    for (const [label, shift] of bits) {
      grid.append(h('span', { class: 'chmod-label' }, label));
      for (const b of [4, 2, 1]) {
        const bit = b << shift;
        const cb = h('input', { type: 'checkbox', checked: !!(mode & bit) });
        cb.addEventListener('change', () => {
          mode = cb.checked ? mode | bit : mode & ~bit;
          octal.value = fmt.octal(mode);
        });
        boxes.push([cb, bit]);
        grid.append(h('label', { class: 'check chmod-cell' }, cb, h('span', { class: 'check-box' }, icon('check', 12))));
      }
    }
    octal.addEventListener('input', () => {
      const v = parseInt(octal.value, 8);
      if (Number.isNaN(v)) return;
      mode = v & 0o7777;
      for (const [cb, bit] of boxes) cb.checked = !!(mode & bit);
    });
    const r = await modal({
      title: 'Huquqlar',
      width: 400,
      body: h('div', { class: 'chmod' }, h('div', { class: 'chmod-path mono' }, path), grid, h('div', { class: 'chmod-row' }, h('span', { class: 'field-label' }, 'Sakkizlik'), octal)),
      actions: [
        { label: 'Bekor qilish', value: null },
        { label: 'Saqlash', kind: 'primary', onClick: () => mode },
      ],
    }).promise;
    if (r == null) return;
    try {
      await call('sftp:chmod', this.connId, path, r);
      await this.refresh();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  copyPaths(items) {
    call('clip:write', items.map((e) => posix.join(this.cwd, e.name)).join('\n'));
    toast('Yo‘l nusxalandi', 'ok', 1400);
  }

  /* ---------------- copy / cut / paste ---------------- */

  copySelection(cut) {
    const items = this.selectedEntries();
    if (!items.length) return;
    setClip({
      connId: this.connId,
      cut,
      items: items.map((e) => ({ path: posix.join(this.cwd, e.name), type: isDirLike(e) && e.type !== 'link' ? 'dir' : e.type, name: e.name })),
    });
    const what = items.length === 1 ? `“${items[0].name}”` : `${items.length} ta element`;
    toast(`${what} ${cut ? 'kesib olindi' : 'nusxalandi'} — kerakli papkada Ctrl+V`, 'ok', 2200);
  }

  canPaste() {
    return !!clip && clip.connId === this.connId;
  }

  renderClip() {
    if (!this.canPaste()) {
      this.clipBar.hidden = true;
      return;
    }
    const what = clip.items.length === 1 ? `“${clip.items[0].name}”` : `${clip.items.length} ta element`;
    clear(
      this.clipBar,
      icon(clip.cut ? 'scissors' : 'copy', 14),
      h('span', { class: 'f-clip-text' }, `${what} ${clip.cut ? 'ko‘chirishga tayyor' : 'nusxalashga tayyor'}`),
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => this.paste() }, icon('paste', 14), 'Shu yerga qo‘yish'),
      h('button', { class: 'icon-btn sm', type: 'button', 'data-tip': 'Bekor qilish', onclick: () => setClip(null) }, icon('x', 14)),
    );
    this.clipBar.hidden = false;
  }

  async paste(dest = this.cwd) {
    if (!this.canPaste()) {
      if (clip) toast('Boshqa serverdan nusxalangan — fayllarni yuklab olib, keyin yuklang', 'err', 3500);
      return;
    }
    const { cut, items } = clip;
    const done = busy(cut ? 'Ko‘chirilmoqda…' : 'Nusxalanmoqda…');
    try {
      await call(cut ? 'fs:move' : 'fs:copy', this.connId, items, dest);
      if (cut) setClip(null);
      toast(cut ? 'Ko‘chirildi' : 'Nusxalandi', 'ok', 1600);
    } catch (err) {
      toast(err.message, 'err', 4000);
    } finally {
      done();
    }
    await this.refresh();
  }

  async duplicate() {
    const items = this.selectedEntries();
    if (!items.length) return;
    const done = busy('Nusxa yaratilmoqda…');
    try {
      await call('fs:copy', this.connId, items.map((e) => ({ path: posix.join(this.cwd, e.name), type: isDirLike(e) && e.type !== 'link' ? 'dir' : e.type })), this.cwd);
    } catch (err) {
      toast(err.message, 'err', 4000);
    } finally {
      done();
    }
    await this.refresh();
  }

  /* ---------------- archives ---------------- */

  async compress(items) {
    const base = items.length === 1 ? items[0].name.replace(ARCHIVE_RE, '') : posix.basename(this.cwd) || 'arxiv';
    const name = h('input', { class: 'input', value: base, spellcheck: 'false' });
    const format = segmented([{ value: 'tar.gz', label: '.tar.gz' }, { value: 'zip', label: '.zip' }], 'tar.gz');
    const what = items.length === 1 ? `“${items[0].name}”` : `${items.length} ta element`;
    const r = await modal({
      title: 'Arxivlash',
      icon: 'archive',
      width: 420,
      body: h('div', { class: 'server-form' }, h('p', { class: 'm-text' }, `${what} bitta arxivga joylanadi. Arxiv server ichida yaratiladi.`), field('Arxiv nomi', name), field('Format', format.el, '.tar.gz — Linux uchun eng qulay; .zip — Windows’da ham oson ochiladi.')),
      actions: [
        { label: 'Bekor qilish', value: null },
        { label: 'Arxivlash', kind: 'primary', onClick: () => ({ name: name.value.trim() || base, format: format.value }) },
      ],
    }).promise;
    if (!r) return;
    const done = busy('Arxivlanmoqda…');
    try {
      const out = await call('fs:compress', this.connId, this.cwd, items.map((e) => e.name), r.name, r.format);
      await this.refresh();
      this.select(out);
      toast(`“${out}” tayyor`, 'ok');
    } catch (err) {
      toast(err.message, 'err', 5000);
    } finally {
      done();
    }
  }

  async extract(e, mode) {
    const done = busy('Arxiv ochilmoqda…');
    try {
      const out = await call('fs:extract', this.connId, posix.join(this.cwd, e.name), mode);
      await this.refresh();
      if (out) this.select(out);
      toast('Arxiv ochildi', 'ok');
    } catch (err) {
      toast(err.message, 'err', 5000);
    } finally {
      done();
    }
  }

  /* ---------------- search ---------------- */

  openSearch() {
    const input = h('input', { class: 'input', placeholder: 'Nima qidiramiz?', spellcheck: 'false', autofocus: true });
    const mode = segmented(
      [
        { value: 'name', label: 'Fayl nomi', icon: 'file' },
        { value: 'content', label: 'Fayl ichida', icon: 'search' },
      ],
      'name',
      () => run(),
    );
    const results = h('div', { class: 'srch-results' });
    const status = h('div', { class: 'srch-status' }, `Qayerda: ${this.cwd} va ichidagi papkalar`);
    let seq = 0;
    const m = modal({
      title: 'Qidirish',
      icon: 'search',
      width: 620,
      className: 'srch-modal',
      body: h('div', { class: 'srch' }, h('div', { class: 'srch-bar' }, input, mode.el), status, results),
    });
    const go = async (r) => {
      m.close(null);
      if (r.type === 'dir') return this.go(r.path);
      await this.go(posix.dirname(r.path));
      this.select(posix.basename(r.path));
      if (r.line) this.edit(null, { path: r.path, line: r.line });
    };
    const run = async () => {
      const q = input.value.trim();
      if (!q) return;
      const my = ++seq;
      clear(results);
      status.replaceChildren(h('span', { class: 'spinner' }), h('span', null, ' Qidirilmoqda…'));
      try {
        const list = await call('fs:search', this.connId, this.cwd, q, mode.value);
        if (my !== seq) return;
        status.textContent = list.length ? `${list.length}${list.length >= 300 ? '+' : ''} ta natija` : 'Hech narsa topilmadi';
        for (const r of list) {
          const rel = r.path.startsWith(`${this.cwd}/`) ? r.path.slice(this.cwd.length + 1) : r.path;
          const kind = kindOf({ name: posix.basename(r.path), type: r.type, mode: 0 });
          results.append(
            h(
              'button',
              { class: 'srch-row', type: 'button', onclick: () => go(r) },
              h('span', { class: `f-ic k-${kind}` }, kindIcon(kind, 14)),
              h(
                'span',
                { class: 'srch-main' },
                h('span', { class: 'srch-path' }, rel, r.line ? h('span', { class: 'srch-line' }, `:${r.line}`) : null),
                r.text != null && h('span', { class: 'srch-text mono' }, r.text),
              ),
              r.size != null && r.type !== 'dir' && h('span', { class: 'srch-size' }, fmt.bytes(r.size)),
            ),
          );
        }
      } catch (err) {
        if (my === seq) status.textContent = err.message;
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        run();
      }
    });
  }

  /* ---------------- properties ---------------- */

  async properties(e) {
    const path = e ? posix.join(this.cwd, e.name) : this.cwd;
    const name = e ? e.name : posix.basename(this.cwd) || '/';
    const isDir = e ? isDirLike(e) : true;
    const kind = e ? kindOf(e) : 'folder';
    const rows = h('div', { class: 'props' });
    const row = (label, value, mono = false) => h('div', { class: 'props-row' }, h('span', { class: 'props-k' }, label), h('span', { class: `props-v ${mono ? 'mono' : ''}` }, value ?? '—'));
    const sizeCell = h('span', null, isDir ? '' : fmt.bytes(e.size));
    const sizeBtn = isDir && h('button', { class: 'link-btn', type: 'button', onclick: () => countSize() }, 'Hajmini hisoblash');
    const countSize = async () => {
      sizeCell.replaceChildren(h('span', { class: 'spinner' }), ' hisoblanmoqda…');
      sizeBtn?.remove();
      try {
        const s = await call('fs:dirSize', this.connId, path);
        sizeCell.textContent = `${s.bytes != null ? `${fmt.bytes(s.bytes)} · ` : ''}${s.files} fayl, ${s.dirs} papka`;
      } catch (err) {
        sizeCell.textContent = err.message;
      }
    };
    clear(
      rows,
      row('Turi', KIND_LABEL[kind]),
      row('Joylashuvi', path, true),
      h('div', { class: 'props-row' }, h('span', { class: 'props-k' }, 'Hajmi'), h('span', { class: 'props-v' }, sizeCell, sizeBtn)),
      row('O‘zgartirilgan', e ? fmt.date(e.mtime) : '…'),
      row('Huquqlar', e ? `${fmt.mode(e.mode, e.type)}  (${fmt.octal(e.mode)})` : '…', true),
      row('Egasi', e ? `${e.owner}:${e.group}` : '…'),
    );
    modal({
      title: name,
      icon: isDir ? 'folder' : 'file',
      width: 520,
      body: rows,
      actions: [{ label: 'Yo‘lni nusxalash', onClick: () => (call('clip:write', path), toast('Nusxalandi', 'ok', 1200), false) }, { label: 'Yopish', kind: 'primary', value: true }],
    });
    try {
      const i = await call('fs:info', this.connId, path);
      const extra = [];
      if (i.mime) extra.push(row('MIME', i.mime, true));
      if (i.real && i.real !== path) extra.push(row('Havola manzili', i.real, true));
      if (!e) {
        rows.children[3].replaceWith(row('O‘zgartirilgan', i.mtime ? fmt.date(i.mtime) : '—'));
        rows.children[4].replaceWith(row('Huquqlar', i.mode != null ? `${fmt.mode(i.mode, 'dir')}  (${fmt.octal(i.mode)})` : '—', true));
        rows.children[5].replaceWith(row('Egasi', i.owner ? `${i.owner}:${i.group}` : '—'));
      }
      rows.append(...extra);
    } catch {
      // Basic info from the listing is still shown.
    }
  }

  async download(items, choose = false) {
    let dir = null;
    if (choose) {
      dir = await call('dialog:folder', 'Qayerga saqlansin?');
      if (!dir) return;
    }
    await call('xfer:download', this.connId, items.map((e) => posix.join(this.cwd, e.name)), dir);
  }

  /* ---------------- upload ---------------- */

  async pickUpload(dirs) {
    const paths = await call('dialog:uploadFiles', dirs);
    if (paths.length) this.uploadPaths(paths, this.cwd);
  }

  async uploadPaths(paths, remoteDir, checkConflicts = true) {
    if (!paths.length) return;
    if (checkConflicts && remoteDir === this.cwd) {
      const names = new Set(this.entries.map((e) => e.name));
      const clash = paths.filter((p) => names.has(p.split(/[\\/]/).pop()));
      if (clash.length) {
        const ok = await confirmDialog({
          title: 'Fayl allaqachon bor',
          message:
            clash.length === 1
              ? `“${clash[0].split(/[\\/]/).pop()}” bu papkada mavjud. Ustidan yozilsinmi?`
              : `${clash.length} ta element bu papkada mavjud. Ustidan yozilsinmi?`,
          confirm: 'Ustidan yozish',
          danger: true,
        });
        if (!ok) return;
      }
    }
    await call('xfer:upload', this.connId, paths, remoteDir);
  }

  setupDrop() {
    let depth = 0;
    this.el.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      this.showDrop(this.cwd);
    });
    this.el.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!e.target.closest('.f-row.drop-target')) this.showDrop(this.cwd);
    });
    this.el.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) this.hideDrop();
    });
    this.el.addEventListener('drop', (e) => {
      depth = 0;
      this.hideDrop();
      if (!hasFiles(e) || !this.cwd) return;
      e.preventDefault();
      this.uploadPaths(filesFrom(e), this.cwd);
    });
  }

  showDrop(target) {
    this.dropHint.querySelector('.f-drop-text').textContent = `${target} ga yuklash`;
    this.el.classList.add('dragging');
  }

  hideDrop() {
    this.el.classList.remove('dragging');
  }

  onTransferDone(job) {
    if (job.kind === 'upload' && job.remoteDir && (job.remoteDir === this.cwd || posix.dirname(job.remoteDir) === this.cwd)) this.refresh();
  }
}

function hasFiles(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}

function filesFrom(e) {
  return [...e.dataTransfer.files].map((f) => pathForFile(f)).filter(Boolean);
}

function validName(v) {
  if (v.includes('/')) return '“/” belgisi ishlatilmaydi';
  if (v === '.' || v === '..') return 'Bu nom ishlatilmaydi';
  return null;
}
