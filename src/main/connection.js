'use strict';

// One SSH connection to one server. Owns the shells and the SFTP channel that
// ride on it, and keeps them alive: keepalives detect a dead link, the client
// reconnects with backoff, and every shell is re-attached to its tmux session
// so the remote programs never notice the network dropped.

const { Client, utils } = require('ssh2');
const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEEPALIVE_MS = 5000;
const KEEPALIVE_MAX = 3;
const READY_TIMEOUT_MS = 20000;
const BACKOFF_MS = [1000, 2000, 3000, 5000, 8000, 12000, 15000];
const MONITOR_MS = 2000;

// Output flow control: pause the remote stream while the renderer is behind.
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

const TMUX = 'tmux -u -L pult -f /dev/null';
const SESSION_RE = /^pult-\d{4}$/;

// Quote for the remote login shell (sh, bash, zsh, fish and csh all accept this form).
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Runs in the remote `sh`. Attaches to (or creates) a private tmux session so
// the shell survives disconnects. Uses a dedicated tmux socket and no user
// config, so it never touches the user's own tmux. Falls back to a plain
// login shell when tmux is missing. Kept on one line for csh/tcsh users.
function tmuxScript(name, cols, rows) {
  // Session first, options after: an option an old tmux does not know must
  // not prevent the session from existing.
  const opts = [
    'set -g status off',
    'set -g escape-time 0',
    'set -g default-terminal screen-256color',
    // No alternate screen: output scrolls into the local scrollback as usual.
    'set -ga terminal-overrides ",xterm*:smcup@:rmcup@:Tc"',
    'set -g focus-events on',
  ].join(' \\; ');
  const create = `$T new-session -d -s "$S" -x ${cols} -y ${rows}`;
  // Re-applied on every attach (idempotent), each on its own so an option an
  // older tmux lacks cannot block the others. Lets programs inside tmux copy
  // to the Windows clipboard through Pult (OSC 52).
  const everyTime = ['set -g set-clipboard on', 'set -g allow-passthrough on']
    .map((o) => `$T ${o} >/dev/null 2>&1`)
    .join('; ');
  return [
    `S=${name}`,
    'if command -v tmux >/dev/null 2>&1; then',
    `T="${TMUX}"`,
    `if ! $T has-session 2>/dev/null; then ${create} \\; ${opts} >/dev/null 2>&1`,
    `elif ! $T has-session -t "$S" 2>/dev/null; then ${create} >/dev/null 2>&1`,
    'fi',
    everyTime,
    '$T attach -t "$S" && exit 0',
    'fi',
    'exec "${SHELL:-/bin/sh}" -l',
  ].join('; ').replace(/then; /g, 'then ');
}

// Long-lived helper channel: answers pings (for latency) and reports load.
// "a" lists what runs in each Pult terminal (for AI agents: Claude Code, agy)
// plus checksums of ~/.pult/state/*.json; "g <file>" returns one of those files.
const MONITOR_SCRIPT = [
  'while IFS= read -r l; do case "$l" in',
  'p) echo p;;',
  's) read -r x c < /proc/stat; echo "cpu $c";',
  'm=""; while read -r k v u; do case "$k" in MemTotal:|MemAvailable:) m="$m $v";; esac; done < /proc/meminfo; echo "mem$m";',
  'echo "disk $(df -Pk / 2>/dev/null | tail -n 1)";',
  'read -r up idle < /proc/uptime; echo "up $up";',
  'echo end;;',
  // -u: titles keep their UTF-8 (Claude Code puts a glyph in front).
  'a) tmux -u -L pult list-panes -a -F "ap|::|#{session_name}|::|#{pane_current_command}|::|#{pane_current_path}|::|#{pane_title}" 2>/dev/null;',
  'for f in "$HOME"/.pult/state/*.json; do [ -f "$f" ] && echo "af $(cksum < "$f") $f"; done; echo aend;;',
  'g\\ *) echo gb; cat -- "${l#g }" 2>/dev/null; echo; echo ge;;',
  'esac; done',
].join(' ');

const PROBE_SCRIPT =
  'command -v tmux >/dev/null 2>&1 && { echo T; tmux -L pult ls -F "#{session_name}" 2>/dev/null; true; } || echo N; echo "H $HOME"';

function keyFingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function keyType(key) {
  try {
    const len = key.readUInt32BE(0);
    return key.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'unknown';
  }
}

function defaultKeyPaths() {
  const dir = path.join(os.homedir(), '.ssh');
  return ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
}

function agentPath() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  return process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined;
}

function serializeError(err) {
  if (!err) return null;
  return { message: String(err.message || err), code: err.code || null, level: err.level || null };
}

class Connection extends EventEmitter {
  /**
   * @param {string} id
   * @param {object} server  full server record (with secrets)
   * @param {object} deps    { ask(kind, data) => Promise, store }
   */
  constructor(id, server, deps) {
    super();
    this.id = id;
    this.server = server;
    this.ask = deps.ask;
    this.store = deps.store;

    this.state = 'idle';
    this.client = null;
    this.everReady = false;
    this.closed = false;
    this.attempt = 0;
    this.retryTimer = null;
    this.retryAt = 0;
    this.lastError = null;
    this.fatal = false;

    this.secrets = { password: server.password || '', passphrase: server.passphrase || '' };
    this.hasTmux = false;
    this.home = null;
    this.knownSessions = new Set();
    this.shells = new Map();

    this.sftpPromise = null;
    this.monitor = null;
    this.monitorTimer = null;
    this.pingSentAt = 0;
    this.rtt = null;
    this.cpuPrev = null;
    this.stats = {};
    // AI agents (see agents.js): poll panes + state files on every tick.
    this.agentPolling = false;
    this.agentScan = null;
    this.fetches = [];
    this.fetchBuf = null;

    this.waiters = [];
  }

  /* ---------------- lifecycle ---------------- */

  publicState() {
    return {
      state: this.state,
      error: serializeError(this.lastError),
      attempt: this.attempt,
      retryAt: this.retryAt,
      hasTmux: this.hasTmux,
      home: this.home,
      sessions: [...this.knownSessions].sort(),
      persist: this.server.persist !== false,
    };
  }

  setState(state) {
    this.state = state;
    this.emit('state', this.publicState());
  }

  start() {
    this.closed = false;
    this.fatal = false;
    this.connect();
  }

  async connect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = 0;
    if (this.closed) return;

    this.setState(this.everReady ? 'reconnecting' : 'connecting');

    let authQueue;
    try {
      authQueue = await this.buildAuth();
    } catch (err) {
      this.fail(err);
      return;
    }
    if (this.closed) return;

    const client = new Client();
    this.client = client;
    this.hostRejected = false;

    client.on('ready', () => {
      if (this.client !== client) return;
      this.onReady(client);
    });
    client.on('error', (err) => {
      if (this.client !== client) return;
      this.lastError = err;
    });
    client.on('close', () => {
      if (this.client !== client) return;
      this.onClose(client);
    });

    const { host, port, username } = this.server;
    try {
      client.connect({
        host,
        port: port || 22,
        username,
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_MS,
        keepaliveCountMax: KEEPALIVE_MAX,
        hostVerifier: (key, verify) => {
          this.verifyHost(key, client).then(verify, () => verify(false));
        },
        authHandler: (methodsLeft, partialSuccess, next) => {
          while (authQueue.length) {
            const method = authQueue.shift();
            if (!methodsLeft || methodsLeft.includes(method.type)) return next(method);
          }
          return next(false);
        },
      });
      client.setNoDelay(true);
      client._sock?.setKeepAlive?.(true, 10000);
    } catch (err) {
      this.lastError = err;
      this.onClose(client);
    }
  }

  async buildAuth() {
    const { auth, username, keyPath } = this.server;
    const queue = [];

    if (auth === 'agent') {
      queue.push({ type: 'agent', username, agent: agentPath() });
      return queue;
    }

    if (auth === 'key') {
      const paths = keyPath ? [keyPath.replace(/^~(?=$|[\\/])/, os.homedir())] : defaultKeyPaths();
      if (!paths.length) throw Object.assign(new Error('SSH kalit topilmadi'), { code: 'NO_KEY' });
      for (const p of paths) {
        let data;
        try {
          data = fs.readFileSync(p);
        } catch {
          throw Object.assign(new Error(`Kalit faylini o‘qib bo‘lmadi: ${p}`), { code: 'KEY_READ' });
        }
        let parsed = utils.parseKey(data, this.secrets.passphrase || undefined);
        while (parsed instanceof Error && /passphrase/i.test(parsed.message)) {
          const answer = await this.ask('passphrase', {
            server: this.server.name,
            keyPath: p,
            retry: !!this.secrets.passphrase,
          });
          if (!answer) throw Object.assign(new Error('Bekor qilindi'), { code: 'CANCELLED' });
          this.secrets.passphrase = answer.value;
          if (answer.save) this.store.setSecret(this.server.id, 'passphrase', answer.value);
          parsed = utils.parseKey(data, answer.value);
        }
        if (parsed instanceof Error) {
          throw Object.assign(new Error(`Kalit yaroqsiz: ${parsed.message}`), { code: 'KEY_PARSE' });
        }
        queue.push({ type: 'publickey', username, key: data, passphrase: this.secrets.passphrase || undefined });
      }
      return queue;
    }

    // Password auth (also covers keyboard-interactive and 2FA prompts).
    if (!this.secrets.password) {
      const answer = await this.ask('password', {
        server: this.server.name,
        user: username,
        host: this.server.host,
        retry: !!this.authRejected,
      });
      if (!answer) throw Object.assign(new Error('Bekor qilindi'), { code: 'CANCELLED' });
      this.secrets.password = answer.value;
      this.savePasswordOnSuccess = answer.save;
    }
    queue.push({ type: 'password', username, password: this.secrets.password });
    queue.push({
      type: 'keyboard-interactive',
      username,
      prompt: (name, instructions, lang, prompts, finish) => {
        if (prompts.length === 1 && /password|parol|пароль/i.test(prompts[0].prompt)) {
          return finish([this.secrets.password]);
        }
        if (!prompts.length) return finish([]);
        this.holdReadyTimeout(this.client);
        this.ask('interactive', {
          server: this.server.name,
          name,
          instructions,
          prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
        }).then((answers) => finish(answers || prompts.map(() => '')));
      },
    });
    return queue;
  }

  // ssh2 counts time spent in our dialogs against readyTimeout; a person
  // reading a fingerprint must not make the handshake time out.
  holdReadyTimeout(client) {
    clearTimeout(client?._readyTimeout);
  }

  async verifyHost(key, client) {
    const { host } = this.server;
    const port = this.server.port || 22;
    const hostport = `${host}:${port}`;
    const fp = keyFingerprint(key);
    const type = keyType(key);
    const known = this.store.getHostKey(hostport);
    if (known && known.fingerprint === fp) return true;
    if (!known && this.store.inOpenSshKnownHosts(host, port, key.toString('base64'))) {
      this.store.setHostKey(hostport, { fingerprint: fp, type });
      return true;
    }
    this.holdReadyTimeout(client);
    const accepted = await this.ask('hostkey', {
      server: this.server.name,
      host: hostport,
      type,
      fingerprint: fp,
      previous: known ? known.fingerprint : null,
    });
    if (accepted) {
      this.store.setHostKey(hostport, { fingerprint: fp, type });
      return true;
    }
    this.hostRejected = true;
    return false;
  }

  async onReady(client) {
    this.attempt = 0;
    this.lastError = null;
    this.authRejected = false;
    if (this.savePasswordOnSuccess) {
      this.store.setSecret(this.server.id, 'password', this.secrets.password);
      this.savePasswordOnSuccess = false;
    }

    // Learn what the server offers before announcing readiness.
    try {
      const { stdout } = await this.exec(PROBE_SCRIPT, 5000);
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      this.hasTmux = lines[0] === 'T';
      for (const l of lines) {
        if (SESSION_RE.test(l)) this.knownSessions.add(l);
        if (l.startsWith('H ')) this.home = l.slice(2);
      }
    } catch {
      this.hasTmux = false;
    }
    if (this.client !== client) return;

    const wasReady = this.everReady;
    this.everReady = true;
    this.setState('ready');

    for (const w of this.waiters.splice(0)) w.resolve();

    this.startMonitor(client);
    if (wasReady) {
      for (const shell of this.shells.values()) {
        if (!shell.exited && !shell.closing) this.openChannel(shell).catch(() => {});
      }
    }
  }

  onClose(client) {
    this.stopMonitor();
    this.sftpPromise = null;
    for (const shell of this.shells.values()) {
      shell.stream = null;
      shell.unacked = 0;
      shell.paused = false;
    }
    if (this.client === client) this.client = null;

    if (this.closed) {
      this.setState('closed');
      return;
    }

    const err = this.lastError;
    const authFailed = err && err.level === 'client-authentication';
    if (authFailed) {
      // Never loop on a wrong password: the next attempt asks the user again.
      if (this.server.auth !== 'key' && this.server.auth !== 'agent') {
        this.secrets.password = '';
        this.authRejected = true;
      }
      this.fail(err);
      return;
    }
    if (this.hostRejected) {
      this.fail(Object.assign(new Error('Server kaliti rad etildi'), { code: 'HOSTKEY_REJECTED' }));
      return;
    }
    if (!this.everReady) {
      // First connection never came up: report instead of looping silently.
      this.fail(err || new Error('Ulanish yopildi'));
      return;
    }
    this.scheduleReconnect();
  }

  fail(err) {
    this.lastError = err;
    this.fatal = true;
    this.attempt = 0;
    this.setState('failed');
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  scheduleReconnect() {
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.retryAt = Date.now() + delay;
    this.setState('reconnecting');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  // Skip the backoff wait (network came back, user clicked "now", etc).
  retryNow() {
    if (this.closed) return;
    if (this.state === 'reconnecting' && this.retryTimer) {
      this.connect();
    } else if (this.state === 'failed') {
      this.fatal = false;
      this.connect();
    }
  }

  // After sleep/resume the socket may be dead without anyone noticing yet.
  probe() {
    if (this.state !== 'ready' || !this.client) return;
    const client = this.client;
    const sentAt = Date.now();
    const timer = setTimeout(() => {
      if (this.client === client && this.state === 'ready' && this.lastPong < sentAt) {
        this.lastError = Object.assign(new Error('Javob yo‘q'), { code: 'PROBE_TIMEOUT' });
        client.destroy();
      }
    }, 4000);
    timer.unref?.();
    this.ping();
  }

  whenReady() {
    if (this.state === 'ready') return Promise.resolve();
    if (this.closed) return Promise.reject(new Error('Ulanish yopilgan'));
    if (this.fatal) return Promise.reject(this.lastError || new Error('Ulanib bo‘lmadi'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.stopMonitor();
    for (const w of this.waiters.splice(0)) w.reject(new Error('Ulanish yopilgan'));
    const client = this.client;
    if (client) {
      client.end();
      setTimeout(() => client.destroy(), 1500).unref?.();
    } else {
      this.setState('closed');
    }
  }

  /* ---------------- exec helper ---------------- */

  exec(script, timeoutMs = 15000) {
    const client = this.client;
    if (!client || this.state === 'closed') return Promise.reject(new Error('Ulanish yo‘q'));
    return new Promise((resolve, reject) => {
      client.exec(`sh -c ${shq(script)}`, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        let code = null;
        const timer = setTimeout(() => {
          stream.close();
          reject(Object.assign(new Error('Buyruq vaqti tugadi'), { code: 'EXEC_TIMEOUT' }));
        }, timeoutMs);
        stream.on('data', (d) => (stdout += d));
        stream.stderr.on('data', (d) => (stderr += d));
        stream.on('exit', (c) => (code = c));
        stream.on('close', () => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });
    });
  }

  /* ---------------- shells ---------------- */

  nextSessionName() {
    let n = 0;
    for (const s of this.knownSessions) n = Math.max(n, Number(s.slice(5)));
    for (const sh of this.shells.values()) if (sh.session) n = Math.max(n, Number(sh.session.slice(5)));
    return `pult-${String(n + 1).padStart(4, '0')}`;
  }

  async openShell(shellId, { cols, rows, attach }) {
    const persist = this.server.persist !== false && this.hasTmux;
    let session = null;
    if (persist) session = attach && SESSION_RE.test(attach) ? attach : this.nextSessionName();
    const shell = {
      id: shellId,
      session,
      cols: cols || 80,
      rows: rows || 24,
      stream: null,
      unacked: 0,
      paused: false,
      exited: false,
      closing: false,
    };
    this.shells.set(shellId, shell);
    if (session) this.knownSessions.add(session);
    if (this.state === 'ready') await this.openChannel(shell);
    return { session, persistent: !!session };
  }

  openChannel(shell) {
    const client = this.client;
    if (!client) return Promise.reject(new Error('Ulanish yo‘q'));
    const pty = { term: 'xterm-256color', cols: shell.cols, rows: shell.rows };
    return new Promise((resolve, reject) => {
      const onStream = (err, stream) => {
        if (err) return reject(err);
        if (shell.closing || this.client !== client) {
          stream.close();
          return resolve();
        }
        shell.stream = stream;
        shell.unacked = 0;
        shell.paused = false;
        shell.exited = false;
        let gotExit = false;
        const onData = (data) => {
          shell.unacked += data.length;
          if (!shell.paused && shell.unacked > HIGH_WATER) {
            shell.paused = true;
            stream.pause();
          }
          this.emit('shell:data', shell.id, data);
        };
        stream.on('data', onData);
        stream.stderr.on('data', onData);
        stream.on('exit', () => (gotExit = true));
        stream.on('close', () => {
          if (shell.stream !== stream) return;
          shell.stream = null;
          // Give the client a moment to report a dropped link before deciding
          // whether the remote process really ended.
          setTimeout(() => {
            const linkAlive = this.client === client && this.state === 'ready';
            if (shell.closing) return;
            if (gotExit || linkAlive) {
              shell.exited = true;
              this.emit('shell:exit', shell.id);
            }
          }, 150);
        });
        this.emit('shell:open', shell.id);
        resolve();
      };
      if (shell.session) client.exec(`sh -c ${shq(tmuxScript(shell.session, shell.cols, shell.rows))}`, { pty }, onStream);
      else client.shell(pty, onStream);
    });
  }

  async reopenShell(shellId) {
    const shell = this.shells.get(shellId);
    if (!shell) return;
    shell.exited = false;
    if (this.state === 'ready') await this.openChannel(shell);
  }

  writeShell(shellId, data) {
    const shell = this.shells.get(shellId);
    if (shell?.stream?.writable) shell.stream.write(data);
  }

  resizeShell(shellId, cols, rows) {
    const shell = this.shells.get(shellId);
    if (!shell || !cols || !rows) return;
    shell.cols = cols;
    shell.rows = rows;
    shell.stream?.setWindow(rows, cols, 0, 0);
  }

  ackShell(shellId, bytes) {
    const shell = this.shells.get(shellId);
    if (!shell) return;
    shell.unacked = Math.max(0, shell.unacked - bytes);
    if (shell.paused && shell.unacked < LOW_WATER) {
      shell.paused = false;
      shell.stream?.resume();
    }
  }

  async closeShell(shellId, { kill = true } = {}) {
    const shell = this.shells.get(shellId);
    if (!shell) return;
    shell.closing = true;
    this.shells.delete(shellId);
    shell.stream?.close();
    if (shell.session) {
      this.knownSessions.delete(shell.session);
      if (kill && this.state === 'ready') {
        await this.exec(`${TMUX} kill-session -t ${shell.session} 2>/dev/null; true`, 5000).catch(() => {});
      }
    }
  }

  /* ---------------- sftp ---------------- */

  // wait=true: transfers block until the link is back; UI calls fail fast.
  async sftp({ wait = false } = {}) {
    if (this.state !== 'ready') {
      if (!wait) throw Object.assign(new Error('Server bilan aloqa yo‘q'), { code: 'NOT_CONNECTED' });
      await this.whenReady();
    }
    if (!this.sftpPromise) {
      const client = this.client;
      const p = new Promise((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) return reject(err);
          sftp.on('close', () => {
            if (this.sftpPromise === p) this.sftpPromise = null;
          });
          resolve(sftp);
        });
      });
      p.catch(() => {
        if (this.sftpPromise === p) this.sftpPromise = null;
      });
      this.sftpPromise = p;
    }
    return this.sftpPromise;
  }

  /* ---------------- monitor (latency + load) ---------------- */

  startMonitor(client) {
    this.stopMonitor();
    this.cpuPrev = null;
    this.lastPong = Date.now();
    client.exec(`sh -c ${shq(MONITOR_SCRIPT)}`, (err, stream) => {
      if (err || this.client !== client) return;
      this.monitor = stream;
      // Titles and JSON carry UTF-8: never split a character between chunks.
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          this.onMonitorLine(line);
        }
      });
      stream.stderr.on('data', () => {});
      stream.on('close', () => {
        if (this.monitor !== stream) return;
        this.monitor = null;
        this.fetchBuf = null;
        for (const f of this.fetches.splice(0)) f(null);
      });
      this.tick();
    });
    this.monitorTimer = setInterval(() => this.tick(), MONITOR_MS);
  }

  stopMonitor() {
    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    if (this.monitor) {
      this.monitor.close();
      this.monitor = null;
    }
    this.agentScan = null;
    this.fetchBuf = null;
    for (const f of this.fetches.splice(0)) f(null);
  }

  ping() {
    if (!this.monitor?.writable) return;
    this.pingSentAt = Date.now();
    this.monitor.write('p\n');
  }

  tick() {
    if (!this.monitor?.writable) return;
    this.ping();
    this.monitor.write('s\n');
    if (this.agentPolling) this.monitor.write('a\n');
  }

  /** Read a small text file through the monitor channel (no new SSH channel). */
  monitorFetch(file) {
    if (!this.monitor?.writable || /[\r\n]/.test(file)) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.fetches.push(resolve);
      this.monitor.write(`g ${file}\n`);
    });
  }

  onMonitorLine(line) {
    // Inside a "g" reply every line is file content until "ge".
    if (this.fetchBuf) {
      if (line === 'ge') {
        const text = this.fetchBuf.join('\n');
        this.fetchBuf = null;
        this.fetches.shift()?.(text);
      } else {
        this.fetchBuf.push(line);
      }
      return;
    }
    if (line === 'gb') {
      this.fetchBuf = [];
      return;
    }
    if (line.startsWith('ap|::|')) {
      const [, session, command, cwd, ...title] = line.split('|::|');
      (this.agentScan ??= { panes: [], files: [] }).panes.push({ session, command, cwd, title: title.join('|::|') });
      return;
    }
    if (line.startsWith('af ')) {
      // "af <crc> <size> <path>"
      const m = line.match(/^af (\d+) (\d+) (.+)$/);
      if (m) (this.agentScan ??= { panes: [], files: [] }).files.push({ sum: `${m[1]}:${m[2]}`, path: m[3] });
      return;
    }
    if (line === 'aend') {
      this.emit('agents:scan', this.agentScan || { panes: [], files: [] });
      this.agentScan = null;
      return;
    }
    const [kind, ...rest] = line.trim().split(/\s+/);
    const nums = rest.map(Number);
    switch (kind) {
      case 'p':
        this.lastPong = Date.now();
        this.rtt = this.lastPong - this.pingSentAt;
        break;
      case 'cpu': {
        const total = nums.reduce((a, b) => a + (b || 0), 0);
        const idle = (nums[3] || 0) + (nums[4] || 0);
        if (this.cpuPrev && total > this.cpuPrev.total) {
          const dt = total - this.cpuPrev.total;
          this.stats.cpu = Math.max(0, Math.min(1, 1 - (idle - this.cpuPrev.idle) / dt));
        }
        this.cpuPrev = { total, idle };
        break;
      }
      case 'mem':
        if (nums[0]) {
          this.stats.memTotal = nums[0] * 1024;
          this.stats.memUsed = (nums[0] - (nums[1] || 0)) * 1024;
        }
        break;
      case 'disk':
        // Filesystem 1024-blocks Used Available Capacity Mounted
        if (rest.length >= 4 && !Number.isNaN(nums[2])) {
          this.stats.diskUsed = nums[2] * 1024;
          this.stats.diskTotal = (nums[2] + nums[3]) * 1024;
        }
        break;
      case 'up':
        if (nums[0]) this.stats.uptime = nums[0];
        break;
      case 'end':
        this.emit('stats', { ...this.stats, rtt: this.rtt });
        break;
    }
  }
}

module.exports = { Connection };
