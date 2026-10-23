'use strict';

// Checks src/main/fsops.js against dev/mock-server.js running with MOCK_SH
// (real cp / mv / tar / find / grep on MOCK_ROOT):
//   MOCK_ROOT=<dir> node dev/fsops-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Connection } = require('../src/main/connection');
const fsops = require('../src/main/fsops');

const ROOT = process.env.MOCK_ROOT;
const local = (p) => path.join(ROOT, ...p.split('/').filter(Boolean));
const store = { getHostKey: () => null, setHostKey() {}, inOpenSshKnownHosts: () => true, setSecret() {} };
const server = { id: 't', name: 't', host: '127.0.0.1', port: Number(process.env.MOCK_PORT || 2222), username: 'demo', auth: 'password', password: 'demo', persist: false };

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
  }
}

(async () => {
  const conn = new Connection('c1', server, { ask: async () => null, store });
  conn.start();
  await conn.whenReady();

  // Fresh playground.
  const play = '/home/demo/play';
  fs.rmSync(local(play), { recursive: true, force: true });
  fs.mkdirSync(local(`${play}/src/sub`), { recursive: true });
  fs.mkdirSync(local(`${play}/dst`), { recursive: true });
  fs.writeFileSync(local(`${play}/src/a.txt`), 'alpha\nNEEDLE here\n');
  fs.writeFileSync(local(`${play}/src/sub/b.conf`), 'listen 80;\n');
  fs.writeFileSync(local(`${play}/report.tar.gz`), 'x');

  await step('copy file + folder', async () => {
    await fsops.copyItems(conn, [{ path: `${play}/src`, type: 'dir' }], `${play}/dst`);
    assert(fs.existsSync(local(`${play}/dst/src/sub/b.conf`)));
  });
  await step('copy again → unique name "src (1)"', async () => {
    await fsops.copyItems(conn, [{ path: `${play}/src`, type: 'dir' }], `${play}/dst`);
    assert(fs.existsSync(local(`${play}/dst/src (1)/a.txt`)));
  });
  await step('duplicate keeps .tar.gz together', async () => {
    await fsops.copyItems(conn, [{ path: `${play}/report.tar.gz`, type: 'file' }], play);
    assert(fs.existsSync(local(`${play}/report (1).tar.gz`)), fs.readdirSync(local(play)).join(','));
  });
  await step('refuses to copy a folder into itself', async () => {
    await assert.rejects(fsops.copyItems(conn, [{ path: `${play}/src`, type: 'dir' }], `${play}/src/sub`));
  });
  await step('move', async () => {
    await fsops.copyItems(conn, [{ path: `${play}/dst/src (1)`, type: 'dir' }], play, { move: true });
    assert(fs.existsSync(local(`${play}/src (1)/a.txt`)) && !fs.existsSync(local(`${play}/dst/src (1)`)));
  });
  await step('compress .tar.gz', async () => {
    const name = await fsops.compress(conn, play, ['src', 'report.tar.gz'], 'backup', 'tar.gz');
    assert.strictEqual(name, 'backup.tar.gz');
    assert(fs.statSync(local(`${play}/backup.tar.gz`)).size > 50);
  });
  await step('extract into a folder', async () => {
    const out = await fsops.extract(conn, `${play}/backup.tar.gz`, 'folder');
    assert.strictEqual(out, 'backup');
    assert.strictEqual(fs.readFileSync(local(`${play}/backup/src/a.txt`), 'utf8'), 'alpha\nNEEDLE here\n');
  });
  await step('zip without zip/python → clear message', async () => {
    await assert.rejects(fsops.compress(conn, play, ['src'], 'x', 'zip'), /zip/);
  });
  await step('search by name', async () => {
    const r = await fsops.search(conn, play, 'B.CONF', 'name');
    assert(r.some((x) => x.path === `${play}/src/sub/b.conf` && x.type === 'file'), JSON.stringify(r));
  });
  await step('search folders by name', async () => {
    const r = await fsops.search(conn, play, 'sub', 'name');
    assert(r.some((x) => x.path === `${play}/src/sub` && x.type === 'dir'), JSON.stringify(r));
  });
  await step('search inside files', async () => {
    const r = await fsops.search(conn, play, 'needle', 'content');
    const hit = r.find((x) => x.path === `${play}/src/a.txt`);
    assert(hit && hit.line === 2 && hit.text.includes('NEEDLE'), JSON.stringify(r));
  });
  await step('info (stat may be missing → partial, no crash)', async () => {
    const i = await fsops.info(conn, `${play}/src/a.txt`);
    assert(i && typeof i === 'object');
  });

  console.log(results.join('\n'));
  conn.close();
  setTimeout(() => process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0), 300);
})();
