'use strict';

// Upload / download engine. Each file is moved with many SFTP requests in
// flight (fast on high-latency links) and remembers the last contiguous byte
// that is safely on the other side. If the connection drops, the job waits
// for the reconnect and resumes from that byte instead of starting over.

const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const posix = path.posix;

const CHUNK = 32 * 1024;
const IN_FLIGHT = 64;
const MAX_ACTIVE_JOBS = 2;
const EMIT_EVERY_MS = 150;

const call = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cancelled extends Error {
  constructor() {
    super('Bekor qilindi');
    this.code = 'CANCELLED';
  }
}

const S_IFMT = 0o170000;
const isDir = (attrs) => (attrs.mode & S_IFMT) === 0o040000;
const isLink = (attrs) => (attrs.mode & S_IFMT) === 0o120000;

// Move bytes [start, size) through `chunk(off, len)` with bounded concurrency.
// `progress(confirmed)` reports the end of the contiguous completed prefix.
function pipeline(start, size, chunk, progress, cancelled) {
  return new Promise((resolve, reject) => {
    let pos = start;
    let active = 0;
    let done = false;
    const pending = new Set();
    const finish = (err) => {
      if (done) return;
      done = true;
      err ? reject(err) : resolve();
    };
    const launch = () => {
      if (done) return;
      if (cancelled()) return finish(new Cancelled());
      while (active < IN_FLIGHT && pos < size) {
        const off = pos;
        const len = Math.min(CHUNK, size - off);
        pos += len;
        active += 1;
        pending.add(off);
        chunk(off, len).then(
          () => {
            active -= 1;
            pending.delete(off);
            if (done) return;
            progress(pending.size ? Math.min(...pending) : pos);
            if (pos >= size && active === 0) finish();
            else launch();
          },
          (err) => finish(err),
        );
      }
      if (pos >= size && active === 0) finish();
    };
    launch();
  });
}

class TransferManager extends EventEmitter {
  constructor(getConnection) {
    super();
    this.getConnection = getConnection;
    this.jobs = new Map();
    this.seq = 0;
  }

  list() {
    return [...this.jobs.values()].map((j) => this.view(j));
  }

  get activeCount() {
    return [...this.jobs.values()].filter((j) => ['queued', 'running', 'waiting'].includes(j.state)).length;
  }

  view(job) {
    return {
      id: job.id,
      connId: job.connId,
      kind: job.kind,
      name: job.name,
      state: job.state,
      error: job.error,
      totalBytes: job.totalBytes,
      doneBytes: job.doneBytes,
      totalFiles: job.files.length,
      doneFiles: job.doneFiles,
      speed: job.speed,
      target: job.target,
      remoteDir: job.remoteDir,
    };
  }

  upload(connId, localPaths, remoteDir) {
    const name = localPaths.length === 1 ? path.basename(localPaths[0]) : `${localPaths.length} ta element`;
    return this.add({ kind: 'upload', connId, name, localPaths, remoteDir, target: remoteDir });
  }

  download(connId, remotePaths, localDir) {
    const name = remotePaths.length === 1 ? posix.basename(remotePaths[0]) : `${remotePaths.length} ta element`;
    return this.add({ kind: 'download', connId, name, remotePaths, localDir, target: localDir });
  }

  add(spec) {
    const job = {
      id: `x${++this.seq}`,
      state: 'queued',
      error: null,
      files: [],
      dirs: [],
      totalBytes: 0,
      doneBytes: 0,
      finishedBytes: 0,
      doneFiles: 0,
      speed: 0,
      cancelled: false,
      open: new Set(),
      lastEmit: 0,
      sample: { t: Date.now(), bytes: 0 },
      ...spec,
    };
    this.jobs.set(job.id, job);
    this.emitJob(job, true);
    this.pump();
    return job.id;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || ['done', 'error', 'cancelled'].includes(job.state)) return;
    job.cancelled = true;
    for (const { sftp, handle } of job.open) sftp.close(handle, () => {});
    if (job.state === 'queued' || job.state === 'waiting') {
      job.state = 'cancelled';
      this.emitJob(job, true);
      this.pump();
    }
  }

  cancelForConnection(connId) {
    for (const job of this.jobs.values()) if (job.connId === connId) this.cancel(job.id);
  }

  clearFinished() {
    for (const [id, job] of this.jobs) {
      if (['done', 'error', 'cancelled'].includes(job.state)) this.jobs.delete(id);
    }
    this.emit('cleared');
  }

  emitJob(job, force = false) {
    const now = Date.now();
    if (!force && now - job.lastEmit < EMIT_EVERY_MS) return;
    const dt = (now - job.sample.t) / 1000;
    if (dt >= 0.5) {
      const rate = (job.doneBytes - job.sample.bytes) / dt;
      job.speed = job.speed ? job.speed * 0.6 + rate * 0.4 : rate;
      job.sample = { t: now, bytes: job.doneBytes };
    }
    job.lastEmit = now;
    this.emit('update', this.view(job));
  }

  pump() {
    const running = [...this.jobs.values()].filter((j) => j.state === 'running' || j.state === 'waiting' || j.planning);
    let slots = MAX_ACTIVE_JOBS - running.length;
    for (const job of this.jobs.values()) {
      if (slots <= 0) break;
      if (job.state === 'queued' && !job.planning) {
        slots -= 1;
        this.run(job);
      }
    }
  }

  async run(job) {
    job.planning = true;
    try {
      const conn = this.getConnection(job.connId);
      if (!conn) throw new Error('Ulanish yopilgan');
      job.state = 'running';
      this.emitJob(job, true);
      if (job.kind === 'upload') await this.planUpload(job, conn);
      else await this.planDownload(job, conn);
      job.planning = false;
      this.emitJob(job, true);

      for (const file of job.files) {
        await this.moveFile(job, file);
        job.finishedBytes += file.size;
        job.doneFiles += 1;
        job.doneBytes = job.finishedBytes;
        this.emitJob(job);
      }
      job.state = 'done';
      job.speed = 0;
      this.emitJob(job, true);
      this.emit('done', this.view(job));
    } catch (err) {
      job.planning = false;
      if (err instanceof Cancelled || job.cancelled) {
        job.state = 'cancelled';
      } else {
        job.state = 'error';
        job.error = String(err.message || err);
      }
      job.speed = 0;
      this.emitJob(job, true);
    } finally {
      job.planning = false;
      this.pump();
    }
  }

  /* ---------------- planning ---------------- */

  async planUpload(job, conn) {
    const sftp = await conn.sftp({ wait: true });
    const walk = async (local, remote) => {
      const st = await fsp.stat(local);
      if (st.isDirectory()) {
        job.dirs.push(remote);
        const entries = await fsp.readdir(local);
        for (const e of entries) await walk(path.join(local, e), posix.join(remote, e));
      } else if (st.isFile()) {
        job.files.push({ local, remote, size: st.size, done: 0 });
        job.totalBytes += st.size;
      }
    };
    for (const local of job.localPaths) {
      if (job.cancelled) throw new Cancelled();
      await walk(local, posix.join(job.remoteDir, path.basename(local)));
    }
    for (const dir of job.dirs) {
      if (job.cancelled) throw new Cancelled();
      await call((cb) => sftp.mkdir(dir, cb)).catch(async (err) => {
        const st = await call((cb) => sftp.stat(dir, cb)).catch(() => null);
        if (!st || !isDir(st)) throw err;
      });
    }
  }

  async planDownload(job, conn) {
    const sftp = await conn.sftp({ wait: true });
    const walk = async (remote, local, attrs) => {
      if (job.cancelled) throw new Cancelled();
      if (isDir(attrs)) {
        job.dirs.push(local);
        const list = await call((cb) => sftp.readdir(remote, cb));
        for (const e of list) {
          let a = e.attrs;
          if (isLink(a)) a = await call((cb) => sftp.stat(posix.join(remote, e.filename), cb)).catch(() => null);
          if (a) await walk(posix.join(remote, e.filename), path.join(local, e.filename), a);
        }
      } else {
        job.files.push({ remote, local, size: attrs.size, done: 0, mtime: attrs.mtime, atime: attrs.atime });
        job.totalBytes += attrs.size;
      }
    };
    for (const remote of job.remotePaths) {
      const attrs = await call((cb) => sftp.stat(remote, cb));
      const local = await uniqueLocal(path.join(job.localDir, posix.basename(remote)));
      if (job.remotePaths.length === 1) job.target = local;
      await walk(remote, local, attrs);
    }
    for (const dir of job.dirs) await fsp.mkdir(dir, { recursive: true });
  }

  /* ---------------- moving bytes ---------------- */

  async moveFile(job, file) {
    let transient = 0;
    for (;;) {
      if (job.cancelled) throw new Cancelled();
      const conn = this.getConnection(job.connId);
      if (!conn) throw new Error('Ulanish yopilgan');
      try {
        const sftp = await conn.sftp({ wait: true });
        if (job.state !== 'running') {
          job.state = 'running';
          this.emitJob(job, true);
        }
        if (job.kind === 'upload') await this.put(sftp, job, file);
        else await this.get(sftp, job, file);
        return;
      } catch (err) {
        if (job.cancelled || err instanceof Cancelled) {
          await this.discardPartial(job, file);
          throw new Cancelled();
        }
        // Did the link drop under us? Then wait for it and resume.
        await sleep(400);
        if (conn.state !== 'ready' && !conn.closed && !conn.fatal) {
          job.state = 'waiting';
          this.emitJob(job, true);
          await conn.whenReady();
          continue;
        }
        if (/no response|not connected|closed|ECONNRESET/i.test(String(err.message)) && transient++ < 3) continue;
        throw err;
      }
    }
  }

  async discardPartial(job, file) {
    if (job.kind === 'download') {
      await fsp.unlink(file.local).catch(() => {});
    } else {
      const conn = this.getConnection(job.connId);
      if (conn?.state === 'ready') {
        const sftp = await conn.sftp().catch(() => null);
        if (sftp && file.done < file.size) await call((cb) => sftp.unlink(file.remote, cb)).catch(() => {});
      }
    }
  }

  async withRemote(job, sftp, remote, flags, fn) {
    const handle = await call((cb) => sftp.open(remote, flags, cb));
    const entry = { sftp, handle };
    job.open.add(entry);
    try {
      return await fn(handle);
    } finally {
      job.open.delete(entry);
      sftp.close(handle, () => {});
    }
  }

  async put(sftp, job, file) {
    const fd = await fsp.open(file.local, 'r');
    try {
      await this.withRemote(job, sftp, file.remote, file.done > 0 ? 'r+' : 'w', (handle) =>
        pipeline(
          file.done,
          file.size,
          async (off, len) => {
            const buf = Buffer.allocUnsafe(len);
            const { bytesRead } = await fd.read(buf, 0, len, off);
            if (bytesRead !== len) throw new Error('Mahalliy fayl o‘qish paytida o‘zgardi');
            await call((cb) => sftp.write(handle, buf, 0, len, off, cb));
          },
          (confirmed) => this.progress(job, file, confirmed),
          () => job.cancelled,
        ),
      );
    } finally {
      await fd.close();
    }
  }

  async get(sftp, job, file) {
    const fd = await fsp.open(file.local, file.done > 0 ? 'r+' : 'w');
    try {
      await this.withRemote(job, sftp, file.remote, 'r', (handle) =>
        pipeline(
          file.done,
          file.size,
          async (off, len) => {
            let got = 0;
            while (got < len) {
              const want = len - got;
              const buf = Buffer.allocUnsafe(want);
              const n = await new Promise((resolve, reject) =>
                sftp.read(handle, buf, 0, want, off + got, (err, nb) => (err ? reject(err) : resolve(nb))),
              );
              if (!n) return; // file shrank on the server
              await fd.write(buf, 0, n, off + got);
              got += n;
            }
          },
          (confirmed) => this.progress(job, file, confirmed),
          () => job.cancelled,
        ),
      );
    } finally {
      await fd.close();
    }
    if (file.mtime) await fsp.utimes(file.local, file.atime || file.mtime, file.mtime).catch(() => {});
  }

  progress(job, file, confirmed) {
    file.done = confirmed;
    job.doneBytes = job.finishedBytes + confirmed;
    this.emitJob(job);
  }
}

async function uniqueLocal(target) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let candidate = target;
  for (let i = 1; ; i++) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${base} (${i})${ext}`);
    } catch {
      return candidate;
    }
  }
}

module.exports = { TransferManager };
