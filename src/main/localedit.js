'use strict';

// "Open on this computer": a server file is copied to a temp folder and opened
// with its usual Windows program (VS Code, Photoshop, a PDF viewer…). Every
// save there is copied back to the server. If the server copy changed in the
// meantime, nothing is overwritten until the user says so.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, shell } = require('electron');

const MAX_BYTES = 300 * 1024 * 1024;
const call = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

class LocalEdits extends EventEmitter {
  constructor(getConnection) {
    super();
    this.getConnection = getConnection;
    this.items = new Map(); // local path → item
  }

  async open(connId, remote) {
    const conn = this.getConnection(connId);
    if (!conn) throw new Error('Ulanish yopilgan');
    const sftp = await conn.sftp();
    const st = await call((cb) => sftp.stat(remote, cb));
    if (st.size > MAX_BYTES) throw new Error('Fayl juda katta (300 MB dan ortiq) — yuklab olib oching');
    const key = crypto.createHash('sha1').update(`${conn.server.id}:${remote}`).digest('hex').slice(0, 12);
    const dir = path.join(app.getPath('temp'), 'pult-open', key);
    fs.mkdirSync(dir, { recursive: true });
    const local = path.join(dir, path.posix.basename(remote));

    const old = this.items.get(local);
    if (old) fs.unwatchFile(local);
    // Fewer requests in flight than fastGet's 64: the terminal stays responsive.
    await call((cb) => sftp.fastGet(remote, local, { concurrency: 8 }, cb));
    const item = { connId, remote, local, name: path.posix.basename(remote), remoteMtime: st.mtime, localMtime: fs.statSync(local).mtimeMs, timer: null, busy: false, again: false };
    this.items.set(local, item);
    // Polling, not fs.watch: editors that save by rename would end a watch.
    fs.watchFile(local, { interval: 1000 }, (cur) => {
      if (!cur.mtimeMs || cur.mtimeMs === item.localMtime) return;
      item.localMtime = cur.mtimeMs;
      clearTimeout(item.timer);
      item.timer = setTimeout(() => this.sync(item), 600);
    });
    const problem = await shell.openPath(local);
    if (problem) throw new Error(`Kompyuterda ochilmadi: ${problem}`);
    return { local };
  }

  async sync(item, { force = false } = {}) {
    if (item.busy) {
      item.again = true;
      return;
    }
    item.busy = true;
    try {
      const conn = this.getConnection(item.connId);
      if (!conn) {
        this.forget(item);
        return;
      }
      const sftp = await conn.sftp({ wait: true });
      const st = await call((cb) => sftp.stat(item.remote, cb)).catch(() => null);
      if (!force && st && item.remoteMtime && st.mtime !== item.remoteMtime) {
        this.emit('conflict', this.view(item));
        return;
      }
      await call((cb) => sftp.fastPut(item.local, item.remote, { concurrency: 8 }, cb));
      const after = await call((cb) => sftp.stat(item.remote, cb)).catch(() => null);
      item.remoteMtime = after ? after.mtime : item.remoteMtime;
      this.emit('synced', this.view(item));
    } catch (err) {
      this.emit('failed', this.view(item), String(err.message || err));
    } finally {
      item.busy = false;
      if (item.again) {
        item.again = false;
        this.sync(item);
      }
    }
  }

  /** The user chose to overwrite the newer server copy. */
  force(local) {
    const item = this.items.get(local);
    if (item) this.sync(item, { force: true });
  }

  view(item) {
    return { connId: item.connId, remote: item.remote, local: item.local, name: item.name };
  }

  forget(item) {
    fs.unwatchFile(item.local);
    clearTimeout(item.timer);
    this.items.delete(item.local);
  }

  dropConnection(connId) {
    for (const item of [...this.items.values()]) if (item.connId === connId) this.forget(item);
  }
}

module.exports = { LocalEdits };
