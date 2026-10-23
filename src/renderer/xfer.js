// Upload / download progress: a status bar chip plus a small panel.

import { call } from './api.js';
import { h, icon, clear, fmt } from './dom.js';

const ACTIVE = new Set(['queued', 'running', 'waiting']);

export class Transfers {
  constructor(app) {
    this.app = app;
    this.jobs = new Map();
    this.isOpen = false;
    this.list = h('div', { class: 'xf-list' });
    this.panel = h(
      'div',
      { class: 'xf-panel', hidden: true },
      h(
        'div',
        { class: 'xf-head' },
        h('span', { class: 'xf-title' }, 'Uzatishlar'),
        h('button', { class: 'link-btn', type: 'button', onclick: () => call('xfer:clear') }, 'Tozalash'),
        h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Yopish', onclick: () => this.toggle(false) }, icon('x', 14)),
      ),
      this.list,
    );
    this.chip = h('button', { class: 'sb-xfer', type: 'button', hidden: true, onclick: () => this.toggle() });
    document.getElementById('layer').append(this.panel);
    document.addEventListener('mousedown', (e) => {
      if (this.isOpen && !this.panel.contains(e.target) && !this.chip.contains(e.target)) this.toggle(false);
    });
  }

  update(job) {
    const isNew = !this.jobs.has(job.id);
    this.jobs.set(job.id, job);
    if (isNew) this.toggle(true);
    this.render();
  }

  reset(jobs) {
    this.jobs = new Map(jobs.map((j) => [j.id, j]));
    if (!this.jobs.size) this.toggle(false);
    this.render();
  }

  toggle(open = !this.isOpen) {
    this.isOpen = open && this.jobs.size > 0;
    this.panel.hidden = !this.isOpen;
  }

  render() {
    const jobs = [...this.jobs.values()].reverse();
    const active = jobs.filter((j) => ACTIVE.has(j.state));
    this.chip.hidden = jobs.length === 0;
    if (jobs.length) {
      const total = active.reduce((a, j) => a + j.totalBytes, 0);
      const done = active.reduce((a, j) => a + j.doneBytes, 0);
      const waiting = active.some((j) => j.state === 'waiting');
      const failed = jobs.some((j) => j.state === 'error');
      clear(
        this.chip,
        icon(active.length ? (waiting ? 'refresh' : 'arrowUp') : failed ? 'alert' : 'check', 13),
        active.length
          ? h('span', null, `${active.length} · ${total ? Math.floor((done / total) * 100) : 0}%`)
          : h('span', null, failed ? 'Xato' : 'Tayyor'),
      );
      this.chip.className = `sb-xfer ${active.length ? 'busy' : failed ? 'failed' : 'done'}`;
    }
    clear(this.list, jobs.map((j) => this.row(j)));
  }

  row(j) {
    const pct = j.totalBytes ? Math.min(100, (j.doneBytes / j.totalBytes) * 100) : j.state === 'done' ? 100 : 0;
    let meta;
    if (j.state === 'waiting') meta = 'Aloqa kutilmoqda — davom ettiriladi';
    else if (j.state === 'queued') meta = 'Navbatda';
    else if (j.state === 'error') meta = j.error || 'Xato';
    else if (j.state === 'cancelled') meta = 'Bekor qilindi';
    else if (j.state === 'done') meta = `${fmt.bytes(j.totalBytes)}${j.totalFiles > 1 ? ` · ${j.totalFiles} fayl` : ''}`;
    else {
      meta = `${fmt.bytes(j.doneBytes)} / ${fmt.bytes(j.totalBytes)}`;
      if (j.speed) meta += ` · ${fmt.speed(j.speed)}`;
      if (j.totalFiles > 1) meta += ` · ${j.doneFiles}/${j.totalFiles}`;
    }

    let action = null;
    if (ACTIVE.has(j.state)) {
      action = h('button', { class: 'icon-btn sm', type: 'button', 'data-tip': 'Bekor qilish', onclick: () => call('xfer:cancel', j.id) }, icon('x', 14));
    } else if (j.state === 'done' && j.kind === 'download' && j.target) {
      action = h('button', { class: 'icon-btn sm', type: 'button', 'data-tip': 'Papkada ko‘rsatish', onclick: () => call('reveal', j.target) }, icon('reveal', 14));
    }

    return h(
      'div',
      { class: `xf-row state-${j.state}` },
      h('span', { class: 'xf-ic' }, icon(j.kind === 'upload' ? 'upload' : 'download', 15)),
      h(
        'div',
        { class: 'xf-main' },
        h('div', { class: 'xf-name', title: j.name }, j.name),
        h('div', { class: 'xf-bar' }, h('span', { style: { width: `${pct}%` } })),
        h('div', { class: 'xf-meta' }, meta),
      ),
      action,
    );
  }
}
