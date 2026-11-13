'use strict';

// Local SSH + SFTP server for development. Pretends to be a small Linux box:
// password "demo" for user "demo", a toy shell, tmux/monitor probes, and an
// SFTP view of a real temp folder. Type `drop` in the shell to simulate the
// network dying (the app should reconnect by itself).

const { Server, utils } = require('ssh2');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.MOCK_PORT || 2222);
const ROOT = process.env.MOCK_ROOT || path.join(os.tmpdir(), 'pult-mock-root');
const HOME = '/home/demo';

const { private: hostKey } = utils.generateKeyPairSync('ed25519');

function seedFiles() {
  const home = path.join(ROOT, 'home', 'demo');
  const mk = (p, content) => {
    const full = path.join(ROOT, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (content !== undefined && !fs.existsSync(full)) fs.writeFileSync(full, content);
  };
  fs.mkdirSync(home, { recursive: true });
  for (const d of ['apps/api/src', 'apps/web/public', 'backups', 'logs', '.ssh', '.config/htop', 'scripts']) fs.mkdirSync(path.join(home, d), { recursive: true });
  mk('home/demo/.bashrc', '# ~/.bashrc\nexport EDITOR=vim\nalias ll="ls -alF"\n');
  mk('home/demo/.profile', '# ~/.profile\n');
  mk('home/demo/.ssh/authorized_keys', 'ssh-ed25519 AAAA... demo@laptop\n');
  mk('home/demo/docker-compose.yml', [
    'services:',
    '  api:',
    '    image: ghcr.io/acme/api:2.4.1',
    '    restart: unless-stopped',
    '    env_file: .env',
    '    ports:',
    '      - "8080:8080"',
    '  db:',
    '    image: postgres:16',
    '    volumes:',
    '      - pgdata:/var/lib/postgresql/data',
    '',
    'volumes:',
    '  pgdata: {}',
    '',
  ].join('\n'));
  mk('home/demo/.env', 'DATABASE_URL=postgres://app:secret@db:5432/app\nNODE_ENV=production\n');
  mk('home/demo/README.md', '# Server\n\nDeploy: `./scripts/deploy.sh`\n');
  mk('home/demo/scripts/deploy.sh', '#!/usr/bin/env bash\nset -euo pipefail\ncd ~/apps/api\ngit pull --ff-only\ndocker compose up -d --build\n');
  mk('home/demo/scripts/backup.sh', '#!/usr/bin/env bash\npg_dump app | gzip > ~/backups/app-$(date +%F).sql.gz\n');
  mk('home/demo/logs/nginx-access.log', Array.from({ length: 400 }, (_, i) => `10.0.0.${i % 250} - - [22/Oct/2026:10:${String(i % 60).padStart(2, '0')}:00 +0500] "GET /api/v1/items HTTP/1.1" 200 512`).join('\n'));
  mk('home/demo/logs/app.log', 'info  server started on :8080\ninfo  connected to postgres\n');
  mk('home/demo/apps/api/package.json', '{\n  "name": "api",\n  "version": "2.4.1"\n}\n');
  mk('home/demo/apps/api/src/index.js', 'import http from "node:http";\n\nhttp.createServer((req, res) => res.end("ok")).listen(8080);\n');
  mk('home/demo/apps/web/public/index.html', '<!doctype html><title>acme</title>\n');
  // One of each kind, for the file-type icons.
  mk('home/demo/downloads/Pult.apk', Buffer.alloc(36 * 1024, 1));
  mk('home/demo/downloads/Pult Setup 1.0.0.exe', Buffer.alloc(110 * 1024, 2));
  mk('home/demo/downloads/site-backup.zip', Buffer.alloc(64 * 1024, 3));
  mk('home/demo/downloads/logo.png', Buffer.alloc(12 * 1024, 4));
  mk('home/demo/downloads/demo.mp4', Buffer.alloc(80 * 1024, 5));
  mk('home/demo/downloads/song.mp3', Buffer.alloc(40 * 1024, 6));
  mk('home/demo/downloads/report.pdf', Buffer.alloc(20 * 1024, 7));
  mk('home/demo/downloads/users.csv', 'id,name\n1,Ali\n');
  mk('home/demo/downloads/dump.sql', 'select 1;\n');
  mk('home/demo/downloads/server.pem', '-----BEGIN CERTIFICATE-----\n');
  mk('home/demo/downloads/nginx-1.24.0.deb', Buffer.alloc(30 * 1024, 8));
  mk('home/demo/downloads/index.js', 'console.log(1)\n');
  mk('home/demo/downloads/install.sh', '#!/bin/sh\necho ok\n');
  mk('home/demo/downloads/notes.txt', 'salom\n');
  mk('home/demo/downloads/error.log', 'oops\n');
  mk('home/demo/downloads/.env', 'A=1\n');
  for (const d of ['images', 'videos']) fs.mkdirSync(path.join(home, 'downloads', d), { recursive: true });
  const big = path.join(home, 'backups', 'app-2026-10-21.sql.gz');
  if (!fs.existsSync(big)) fs.writeFileSync(big, Buffer.alloc(24 * 1024 * 1024, 7));
  if (!fs.existsSync(path.join(home, 'backups', 'app-2026-10-20.sql.gz'))) fs.writeFileSync(path.join(home, 'backups', 'app-2026-10-20.sql.gz'), Buffer.alloc(3 * 1024 * 1024, 3));
}

seedFiles();

/* ---------------- path mapping ---------------- */

const norm = (p) => {
  let s = path.posix.normalize(p.startsWith('/') ? p : path.posix.join(HOME, p));
  if (s === '.') s = HOME;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
};
const local = (p) => path.join(ROOT, ...norm(p).split('/').filter(Boolean));

function attrsOf(st) {
  return {
    mode: st.isDirectory() ? 0o040755 : st.isSymbolicLink() ? 0o120777 : (st.mode & 0o111 ? 0o100755 : 0o100644),
    uid: 1000,
    gid: 1000,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function longname(name, a) {
  const t = (a.mode & 0o170000) === 0o040000 ? 'd' : '-';
  return `${t}rwxr-xr-x    1 demo     demo     ${a.size} Oct 22 10:00 ${name}`;
}

/* ---------------- SFTP ---------------- */

function serveSftp(sftp) {
  const { STATUS_CODE } = require('ssh2').utils.sftp;
  const handles = new Map();
  let next = 0;
  const newHandle = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(++next);
    handles.set(next, v);
    return b;
  };
  const get = (h) => handles.get(h.readUInt32BE(0));
  const fail = (id, err) => sftp.status(id, err && err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : err && err.code === 'EEXIST' ? STATUS_CODE.FAILURE : STATUS_CODE.FAILURE, err ? err.message : undefined);

  sftp.on('REALPATH', (id, p) => {
    const n = norm(p);
    sftp.name(id, [{ filename: n, longname: n, attrs: {} }]);
  });
  const stat = (id, p, link) => {
    try {
      const st = link ? fs.lstatSync(local(p)) : fs.statSync(local(p));
      sftp.attrs(id, attrsOf(st));
    } catch (e) {
      fail(id, e);
    }
  };
  sftp.on('STAT', (id, p) => stat(id, p, false));
  sftp.on('LSTAT', (id, p) => stat(id, p, true));
  sftp.on('OPENDIR', (id, p) => {
    try {
      const names = fs.readdirSync(local(p));
      sftp.handle(id, newHandle({ dir: norm(p), names, done: false }));
    } catch (e) {
      fail(id, e);
    }
  });
  sftp.on('READDIR', (id, h) => {
    const d = get(h);
    if (!d || d.done) return sftp.status(id, STATUS_CODE.EOF);
    d.done = true;
    const list = d.names.map((n) => {
      const st = fs.lstatSync(path.join(local(d.dir), n));
      const a = attrsOf(st);
      return { filename: n, longname: longname(n, a), attrs: a };
    });
    sftp.name(id, list);
  });
  sftp.on('OPEN', (id, p, flags) => {
    const F = require('ssh2').utils.sftp.OPEN_MODE;
    let mode = 'r';
    if (flags & F.WRITE) mode = flags & F.TRUNC ? 'w' : flags & F.CREAT && !fs.existsSync(local(p)) ? 'w' : 'r+';
    if (flags & F.EXCL && fs.existsSync(local(p))) return sftp.status(id, STATUS_CODE.FAILURE, 'exists');
    try {
      const fd = fs.openSync(local(p), mode);
      sftp.handle(id, newHandle({ fd }));
    } catch (e) {
      fail(id, e);
    }
  });
  sftp.on('READ', (id, h, offset, len) => {
    const f = get(h);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(f.fd, buf, 0, len, offset);
    if (!n) return sftp.status(id, STATUS_CODE.EOF);
    // A little latency makes the progress UI visible.
    setTimeout(() => sftp.data(id, buf.subarray(0, n)), Number(process.env.MOCK_SLOW || 0));
  });
  sftp.on('WRITE', (id, h, offset, data) => {
    const f = get(h);
    fs.writeSync(f.fd, data, 0, data.length, offset);
    sftp.status(id, STATUS_CODE.OK);
  });
  sftp.on('FSTAT', (id, h) => sftp.attrs(id, attrsOf(fs.fstatSync(get(h).fd))));
  sftp.on('CLOSE', (id, h) => {
    const v = get(h);
    if (v && v.fd !== undefined) fs.closeSync(v.fd);
    handles.delete(h.readUInt32BE(0));
    sftp.status(id, STATUS_CODE.OK);
  });
  const simple = (fn) => (id, ...args) => {
    try {
      fn(...args);
      sftp.status(id, STATUS_CODE.OK);
    } catch (e) {
      fail(id, e);
    }
  };
  sftp.on('MKDIR', simple((p) => fs.mkdirSync(local(p))));
  sftp.on('RMDIR', simple((p) => fs.rmdirSync(local(p))));
  sftp.on('REMOVE', simple((p) => fs.unlinkSync(local(p))));
  sftp.on('RENAME', simple((a, b) => fs.renameSync(local(a), local(b))));
  sftp.on('SETSTAT', simple(() => {}));
  sftp.on('FSETSTAT', simple(() => {}));
}

/* ---------------- AI agents (fake Claude Code / agy) ---------------- */

// What runs in each "tmux" session, for the monitor's pane listing.
const panes = new Map(); // session → { command, cwd, title }
const AGENTS_OFF = process.env.MOCK_AGENTS === 'none';
const usage = { five: 38.4, week: 12.2, fiveReset: Date.now() + 2.2 * 3600e3, weekReset: Date.now() + 3.4 * 86400e3 };

const bridged = () => {
  try {
    return fs.readFileSync(local(`${HOME}/.claude/settings.json`), 'utf8').includes('pult/bin/claude-statusline');
  } catch {
    return false;
  }
};

// What Pult's status line bridge would write when Claude Code runs it.
function claudeSnapshot(session, cwd, ctx) {
  if (!bridged()) return null;
  const d = {
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    workspace: { current_dir: cwd, project_dir: cwd },
    version: '2.1.300',
    cost: { total_cost_usd: 0.18 + ctx / 40 },
    context_window: { context_window_size: 200000, used_percentage: ctx, remaining_percentage: 100 - ctx },
    rate_limits: {
      five_hour: { used_percentage: usage.five, resets_at: Math.floor(usage.fiveReset / 1000) },
      seven_day: { used_percentage: usage.week, resets_at: Math.floor(usage.weekReset / 1000) },
    },
  };
  const dir = local(`${HOME}/.pult/state`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `claude.${session || 'none'}.json`), JSON.stringify({ t: Math.floor(Date.now() / 1000), d }) + '\n');
  return d;
}

const statusLine = (d) =>
  d ? `Opus 5.5 · kontekst ${d.context_window.used_percentage}% · 5 soat ${Math.floor(usage.five)}% · hafta ${Math.floor(usage.week)}%` : '';

function agyUsage() {
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  return JSON.stringify({
    num_turns: 0,
    total_tokens: 0,
    conversation_id: '',
    command: {
      name: 'usage',
      data: {
        groups: [
          { name: 'Gemini Models', buckets: [
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0.714, reset_time: iso(Date.now() + 3.1 * 3600e3) },
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.917, reset_time: iso(Date.now() + 5.2 * 86400e3) },
          ] },
          { name: 'Claude and GPT models', buckets: [
            { id: 'cg-5h', window: '5h', remaining_fraction: 0.18, reset_time: iso(Date.now() + 1.4 * 3600e3) },
            { id: 'cg-weekly', window: 'weekly', remaining_fraction: 0.64, reset_time: iso(Date.now() + 5.2 * 86400e3) },
          ] },
        ],
      },
    },
  });
}

/* ---------------- toy shell ---------------- */

const C = { g: '\x1b[1;32m', b: '\x1b[1;34m', c: '\x1b[36m', y: '\x1b[33m', d: '\x1b[2m', r: '\x1b[0m', m: '\x1b[35m' };

function runShell(stream, client, session = null) {
  let cwd = HOME;
  let line = '';
  let agent = null; // 'claude' | 'agy' while a fake agent "runs"
  let ctx = 6;
  const pane = { command: 'bash', cwd, title: 'acme-prod' };
  if (session) panes.set(session, pane);
  stream.on('close', () => {
    if (session && panes.get(session) === pane) panes.delete(session);
  });
  const setPane = (command, title) => {
    pane.command = command;
    pane.title = title;
    pane.cwd = cwd;
  };
  const prompt = () => {
    if (agent) {
      stream.write(`\r\n${C.d}────────────────────────────────────────────────────────${C.r}\r\n> `);
      return;
    }
    const p = cwd === HOME ? '~' : cwd.startsWith(HOME) ? `~${cwd.slice(HOME.length)}` : cwd;
    stream.write(`${C.g}demo@acme-prod${C.r}:${C.b}${p}${C.r}$ `);
  };
  const out = (s) => stream.write(s.replace(/\n/g, '\r\n'));
  const enterAgent = (kind) => {
    if (AGENTS_OFF) return out(`${kind}: command not found\n`);
    agent = kind;
    if (kind === 'claude') {
      setPane('claude', '✳ Claude Code');
      stream.write('\x1b]0;✳ Claude Code\x07');
      out(`${C.m}✻${C.r} Claude Code ${C.d}(demo)${C.r}\n\n  ${C.d}cwd: ${cwd}${C.r}\n`);
      const d = claudeSnapshot(session, cwd, ctx);
      if (d) out(`\n${C.d}${statusLine(d)}${C.r}\n`);
    } else {
      setPane('agy', 'agy');
      out(`${C.c}▲${C.r} Antigravity CLI ${C.d}(demo)${C.r}\n\n  ${C.d}workspace: ${cwd}${C.r}\n`);
    }
  };
  const leaveAgent = () => {
    agent = null;
    setPane('bash', 'acme-prod');
    out('\n');
  };
  const agentAnswer = (text) => {
    const topic = text.split(/\s+/).slice(0, 4).join(' ');
    if (agent === 'claude') {
      setPane('claude', `✳ ${topic}`);
      stream.write(`\x1b]0;✳ ${topic}\x07`);
    }
    out(`\n${C.d}● ${agent === 'claude' ? 'Ishlayapman' : 'Thinking'}…${C.r}`);
    setTimeout(() => {
      ctx = Math.min(95, ctx + 9);
      usage.five = Math.min(100, usage.five + 3.5);
      usage.week = Math.min(100, usage.week + 0.6);
      out(`\r\x1b[2K${C.g}●${C.r} Bajarildi: “${topic}”.\n`);
      if (agent === 'claude') {
        const d = claudeSnapshot(session, cwd, ctx);
        if (d) out(`${C.d}${statusLine(d)}${C.r}\n`);
      }
      stream.write('\x07'); // what Claude Code sends with preferredNotifChannel = terminal_bell
      prompt();
    }, Number(process.env.MOCK_AGENT_MS || 1200));
  };

  const commands = {
    ls(args) {
      const target = args.find((a) => !a.startsWith('-')) || cwd;
      const all = args.some((a) => a.includes('a'));
      try {
        const names = fs.readdirSync(local(path.posix.resolve(cwd, target))).filter((n) => all || !n.startsWith('.')).sort();
        out(names.map((n) => (fs.statSync(path.join(local(path.posix.resolve(cwd, target)), n)).isDirectory() ? `${C.b}${n}${C.r}` : n.endsWith('.sh') ? `${C.g}${n}${C.r}` : n)).join('  ') + '\n');
      } catch {
        out(`ls: cannot access '${target}': No such file or directory\n`);
      }
    },
    cd(args) {
      const t = args[0] ? path.posix.resolve(cwd, args[0].replace(/^~/, HOME)) : HOME;
      if (fs.existsSync(local(t)) && fs.statSync(local(t)).isDirectory()) cwd = norm(t);
      else out(`cd: ${args[0]}: No such file or directory\n`);
    },
    pwd: () => out(`${cwd}\n`),
    whoami: () => out('demo\n'),
    uname: () => out('Linux acme-prod 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux\n'),
    clear: () => stream.write('\x1b[H\x1b[2J'),
    echo: (args) => out(args.join(' ') + '\n'),
    cat(args) {
      try {
        out(fs.readFileSync(local(path.posix.resolve(cwd, args[0] || ''))).toString().slice(0, 4000) + '\n');
      } catch {
        out(`cat: ${args[0]}: No such file or directory\n`);
      }
    },
    uptime: () => out(' 10:42:07 up 12 days,  3:41,  1 user,  load average: 0.21, 0.18, 0.12\n'),
    'docker': () =>
      out(
        `${C.d}CONTAINER ID   IMAGE                      STATUS          PORTS${C.r}\n` +
          `3f1c2a9d8b7e   ghcr.io/acme/api:2.4.1     Up 12 days      0.0.0.0:8080->8080/tcp\n` +
          `9a8b7c6d5e4f   postgres:16                Up 12 days      5432/tcp\n` +
          `1b2c3d4e5f6a   nginx:1.27                 Up 12 days      0.0.0.0:80->80/tcp, 443/tcp\n`,
      ),
    systemctl: () =>
      out(
        `${C.g}●${C.r} nginx.service - A high performance web server\n` +
          `     Loaded: loaded (/usr/lib/systemd/system/nginx.service; ${C.g}enabled${C.r})\n` +
          `     Active: ${C.g}active (running)${C.r} since Thu 2026-10-10 07:01:12 +05; 12 days ago\n` +
          `   Main PID: 912 (nginx)\n      Tasks: 3 (limit: 4557)\n     Memory: 6.1M\n`,
      ),
    df: () =>
      out(
        'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        40G   17G   21G  44% /\ntmpfs           1.9G     0  1.9G   0% /dev/shm\n',
      ),
    free: () =>
      out(
        '               total        used        free      shared  buff/cache   available\nMem:           3.8Gi       1.5Gi       412Mi        12Mi       1.9Gi       2.1Gi\nSwap:          2.0Gi          0B       2.0Gi\n',
      ),
    colors() {
      let s = '';
      for (let i = 0; i < 16; i++) s += `\x1b[48;5;${i}m   `;
      out(s + `${C.r}\n`);
    },
    copytest() {
      // What tmux / Claude Code send to put text on the user's clipboard.
      const b64 = Buffer.from('Salom, dunyo! oʻzbekcha ✓', 'utf8').toString('base64');
      stream.write(`\x1b]52;c;${b64}\x07`);
      stream.write(`\x1b]52;c;?\x07`); // read request: must be ignored
      out('(sent OSC 52)\n');
    },
    drop() {
      out(`${C.y}(simulating network loss)${C.r}\n`);
      setTimeout(() => client._sock?.destroy(), 100);
    },
    outage(args) {
      out(`${C.y}(network down for ${args[0] || 8}s)${C.r}\n`);
      refuseUntil = Date.now() + Number(args[0] || 8) * 1000;
      setTimeout(() => client._sock?.destroy(), 100);
    },
    exit() {
      stream.exit(0);
      stream.end();
      return 'stop';
    },
    claude: () => enterAgent('claude'),
    agy: () => enterAgent('agy'),
  };

  out(`Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)\n\n`);
  out(`${C.d}  System load:  0.21               Processes:             142\n  Usage of /:   44.1% of 39.25GB   Users logged in:       1\n  Memory usage: 38%                IPv4 address for eth0: 10.0.0.4${C.r}\n\n`);
  out(`Last login: Wed Oct 21 22:14:09 2026 from 84.54.70.12\n`);
  prompt();

  stream.on('data', (d) => {
    for (const ch of d.toString('utf8')) {
      if (agent && ch === '\n') {
        // Shift+Enter in Pult sends LF: a new line inside the prompt.
        line += '\n';
        stream.write('\r\n  ');
      } else if (agent && ch === '\r') {
        const text = line.trim();
        line = '';
        if (text === '/exit' || text === 'exit') {
          leaveAgent();
          prompt();
        } else if (text) agentAnswer(text.replace(/\s+/g, ' '));
        else prompt();
      } else if (agent && ch === '\x03') {
        line = '';
        leaveAgent();
        prompt();
      } else if (ch === '\r') {
        stream.write('\r\n');
        // Just enough shell for `cd -- '/some dir' && claude` (what Pult types).
        const parts = line.split('&&');
        line = '';
        for (const part of parts) {
          const [cmd, ...args] = (part.match(/'[^']*'|"[^"]*"|\S+/g) || []).map((w) => w.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'));
          if (!cmd) continue;
          const fn = commands[cmd];
          if (fn) {
            if (fn(cmd === 'cd' ? args.filter((a) => a !== '--') : args) === 'stop') return;
          } else {
            out(`${cmd}: command not found\n`);
            break;
          }
        }
        pane.cwd = cwd;
        prompt();
      } else if (ch === '\x7f' || ch === '\b') {
        if (line.length) {
          line = line.slice(0, -1);
          stream.write('\b \b');
        }
      } else if (ch === '\x03') {
        line = '';
        stream.write('^C\r\n');
        prompt();
      } else if (ch === '\x0c') {
        stream.write('\x1b[H\x1b[2J');
        prompt();
        stream.write(line);
      } else if (ch >= ' ') {
        line += ch;
        stream.write(ch);
      }
    }
  });
}

/* ---------------- monitor / probe ---------------- */

function runMonitor(stream) {
  let buf = '';
  let cpu = [100000, 500, 30000, 800000, 2000];
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l === 'a') {
        // Panes of the pult tmux server + checksums of ~/.pult/state/*.json.
        let s = '';
        for (const [name, p] of panes) s += `ap|::|${name}|::|${p.command}|::|${p.cwd}|::|${p.title}\n`;
        const dir = local(`${HOME}/.pult/state`);
        for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
          const data = fs.readFileSync(path.join(dir, f));
          const sum = parseInt(require('crypto').createHash('md5').update(data).digest('hex').slice(0, 8), 16);
          s += `af ${sum} ${data.length} ${HOME}/.pult/state/${f}\n`;
        }
        stream.write(`${s}aend\n`);
      }
      if (l.startsWith('g ')) {
        let text = '';
        try {
          text = fs.readFileSync(local(l.slice(2)), 'utf8');
        } catch {
          // missing: empty reply, like `cat` of a vanished file
        }
        stream.write(`gb\n${text}\nge\n`);
      }
      if (l === 'p') setTimeout(() => stream.write('p\n'), 18 + Math.random() * 10);
      if (l === 's') {
        const busy = 300 + Math.random() * 900;
        cpu = [cpu[0] + busy, cpu[1], cpu[2] + busy / 3, cpu[3] + 4000 - busy, cpu[4] + 20];
        stream.write(
          `cpu ${cpu.map(Math.round).join(' ')} 0 0 0 0 0\nmem 3989504 2391040\ndisk /dev/sda1 41152736 18154292 22998444 45% /\nup ${1043200 + process.uptime()} 0\nend\n`,
        );
      }
    }
  });
}

/* ---------------- server ---------------- */

let refuseUntil = 0;

/* ---------------- real commands (optional) ---------------- */

// With MOCK_SH=<path to a POSIX sh.exe, e.g. MinGit's usr\bin\sh.exe> the
// file-operation commands (cp, mv, tar, find, grep…) really run against
// MOCK_ROOT: quoted absolute paths are mapped into it and back.
const MOCK_SH = process.env.MOCK_SH;
const MSYS_ROOT = '/' + ROOT.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase());

function unwrapSh(cmd) {
  const m = cmd.match(/^sh -c '([\s\S]*)'$/);
  return m ? m[1].replace(/'\\''/g, "'") : cmd;
}

function runReal(stream, cmd) {
  const { spawn } = require('child_process');
  const script = unwrapSh(cmd).replace(/'\//g, `'${MSYS_ROOT}/`);
  const binDir = path.dirname(MOCK_SH);
  const p = spawn(MOCK_SH, ['-c', script], {
    env: { ...process.env, PATH: `${binDir};C:\\Windows\\System32` },
    windowsHide: true,
  });
  const back = (d) => Buffer.from(d.toString('utf8').split(MSYS_ROOT).join(''), 'utf8');
  p.stdout.on('data', (d) => stream.write(back(d)));
  p.stderr.on('data', (d) => stream.stderr.write(back(d)));
  p.on('close', (code) => {
    stream.exit(code ?? 1);
    stream.end();
  });
}

new Server({ hostKeys: [hostKey] }, (client, info) => {
  if (Date.now() < refuseUntil) {
    client._sock?.destroy();
    return;
  }
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'demo' && ctx.password === 'demo') return ctx.accept();
    if (ctx.method === 'keyboard-interactive') return ctx.reject();
    ctx.reject(['password', 'keyboard-interactive']);
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      let pty = false;
      session.on('pty', (acc) => {
        pty = true;
        acc && acc();
      });
      session.on('window-change', (acc) => acc && acc());
      session.on('env', (acc) => acc && acc());
      session.on('shell', (acc) => runShell(acc(), client));
      session.on('sftp', (acc) => serveSftp(acc()));
      session.on('exec', (acc, rej, info) => {
        const stream = acc();
        const cmd = info.command;
        if (cmd.includes('while IFS= read -r l')) return runMonitor(stream);
        if (cmd.includes('ls -F')) {
          stream.write('T\n');
          stream.write(`H ${HOME}\n`);
          stream.exit(0);
          return stream.end();
        }
        if (pty && cmd.includes('tmux')) return runShell(stream, client, cmd.match(/S=(pult-\d{4})/)?.[1] || null);
        if (cmd.includes('kill-session')) panes.delete(cmd.match(/-t (pult-\d{4})/)?.[1]);
        if (cmd.includes('command -v claude')) {
          // agents.js detection
          let v = '';
          try {
            v = fs.readFileSync(local(`${HOME}/.pult/bin/claude-statusline`), 'utf8').match(/^# pult-bridge v(\d+)/m)?.[1] || '';
          } catch {
            // not installed
          }
          stream.write(`C ${AGENTS_OFF ? '' : `${HOME}/.local/bin/claude`}\nA ${AGENTS_OFF ? '' : `${HOME}/.local/bin/agy`}\nB ${bridged() ? 1 : 0}\n${v ? `V ${v}\n` : ''}`);
          stream.exit(0);
          return stream.end();
        }
        if (cmd.includes('/usage') && cmd.includes('agy')) {
          setTimeout(() => {
            if (process.env.MOCK_AGY === 'auth') {
              stream.write('{"status":"ERROR"}\n');
              stream.stderr.write('Error: authentication required. Run `agy` to sign in.\n');
              stream.exit(1);
            } else {
              stream.write(`${agyUsage()}\n`);
              stream.exit(0);
            }
            stream.end();
          }, 300);
          return;
        }
        const outage = cmd.match(/MOCK_OUTAGE (\d+)/);
        if (outage) {
          refuseUntil = Date.now() + Number(outage[1]) * 1000;
          setTimeout(() => client._sock?.destroy(), 50);
          return;
        }
        if (MOCK_SH && !cmd.includes('rm -rf') && !cmd.includes('kill-session')) return runReal(stream, cmd);
        // No rm here: the app must fall back to deleting over SFTP.
        stream.exit(cmd.includes('rm -rf') ? 1 : 0);
        stream.end();
      });
    });
  });
  client.on('error', () => {});
}).listen(PORT, '127.0.0.1', () => console.log(`mock ssh on 127.0.0.1:${PORT}, root ${ROOT}`));
