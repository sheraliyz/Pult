'use strict';

// Headless check of Connection + TransferManager against dev/mock-server.js:
// download, drop the link mid-transfer, verify resume and byte equality.
//   node dev/xfer-test.js <outDir>

const { Connection } = require('../src/main/connection');
const { TransferManager } = require('../src/main/transfers');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const outDir = process.argv[2];
const mockRoot = process.env.MOCK_ROOT;
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const store = { getHostKey: () => null, setHostKey() {}, inOpenSshKnownHosts: () => true, setSecret() {} };
const server = { id: 't', name: 't', host: '127.0.0.1', port: 2222, username: 'demo', auth: 'password', password: 'demo', persist: true };
const conn = new Connection('c1', server, { ask: async () => null, store });
const states = [];
conn.on('state', (s) => states.push(`${Date.now() % 100000} ${s.state}`));
const xm = new TransferManager(() => conn);
const t0 = Date.now();
const log = (...a) => console.log(`${String(Date.now() - t0).padStart(6)}ms`, ...a);

let lastLog = 0;
xm.on('update', (j) => {
  if (Date.now() - lastLog > 500 || j.state !== 'running') {
    lastLog = Date.now();
    log(j.state, `${(j.doneBytes / 1048576).toFixed(1)}MB / ${(j.totalBytes / 1048576).toFixed(1)}MB`, `${(j.speed / 1048576).toFixed(2)}MB/s`, `${j.doneFiles}/${j.totalFiles}`);
  }
});

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);

conn.start();
conn.whenReady().then(async () => {
  log('ready, tmux:', conn.hasTmux, 'home:', conn.home);
  const id = xm.download('c1', ['/home/demo/backups'], outDir);
  setTimeout(() => {
    log('>>> cutting the link for 4s');
    conn.exec('echo MOCK_OUTAGE 4').catch(() => {});
  }, 1500);
  await new Promise((resolve) => xm.on('done', resolve));
  log('done');
  for (const f of fs.readdirSync(path.join(outDir, 'backups'))) {
    const a = sha(path.join(outDir, 'backups', f));
    const b = sha(path.join(mockRoot, 'home', 'demo', 'backups', f));
    log(f, a === b ? 'OK' : `MISMATCH ${a} != ${b}`);
  }
  console.log(states.join('\n'));
  conn.close();
  setTimeout(() => process.exit(0), 300);
});
setTimeout(() => {
  log('TIMEOUT');
  console.log(states.join('\n'));
  process.exit(1);
}, 90000);
