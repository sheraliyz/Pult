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

/* ---------------- toy shell ---------------- */

const C = { g: '\x1b[1;32m', b: '\x1b[1;34m', c: '\x1b[36m', y: '\x1b[33m', d: '\x1b[2m', r: '\x1b[0m', m: '\x1b[35m' };

function runShell(stream, client) {
  let cwd = HOME;
  let line = '';
  const prompt = () => {
    const p = cwd === HOME ? '~' : cwd.startsWith(HOME) ? `~${cwd.slice(HOME.length)}` : cwd;
    stream.write(`${C.g}demo@acme-prod${C.r}:${C.b}${p}${C.r}$ `);
  };
  const out = (s) => stream.write(s.replace(/\n/g, '\r\n'));

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
  };

  out(`Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)\n\n`);
  out(`${C.d}  System load:  0.21               Processes:             142\n  Usage of /:   44.1% of 39.25GB   Users logged in:       1\n  Memory usage: 38%                IPv4 address for eth0: 10.0.0.4${C.r}\n\n`);
  out(`Last login: Wed Oct 21 22:14:09 2026 from 84.54.70.12\n`);
  prompt();

  stream.on('data', (d) => {
    for (const ch of d.toString('utf8')) {
      if (ch === '\r') {
        stream.write('\r\n');
        const [cmd, ...args] = line.trim().split(/\s+/);
        line = '';
        if (cmd) {
          const fn = commands[cmd];
          if (fn) {
            if (fn(args) === 'stop') return;
          } else out(`${cmd}: command not found\n`);
        }
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
        if (pty && cmd.includes('tmux')) return runShell(stream, client);
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
