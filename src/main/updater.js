'use strict';

// Updates from GitHub Releases: is there a newer Pult? If so, download the
// installer and run it (the one-click installer replaces this version and
// starts the new one). The portable build only links to the release page.

const fs = require('fs');
const path = require('path');
const { app, net, shell } = require('electron');

const REPO = 'sheraliyz/Pult';

const parse = (v) =>
  String(v || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10) || 0);

/** true when version a is newer than b ("1.10.0" > "1.9.3"). */
function newer(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;

async function latest() {
  const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Pult/${app.getVersion()}` },
  });
  if (!r.ok) throw new Error(`GitHub javob bermadi (${r.status})`);
  const j = await r.json();
  const assets = (j.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
  return {
    version: String(j.tag_name || '').replace(/^v/i, ''),
    name: j.name || j.tag_name,
    notes: String(j.body || '').slice(0, 6000),
    page: j.html_url,
    date: j.published_at,
    installer: assets.find((a) => /setup.*\.exe$/i.test(a.name)) || null,
  };
}

/** { current, available, release } — available when the latest release is newer. */
async function check() {
  const current = app.getVersion();
  const release = await latest();
  return { current, available: newer(release.version, current), portable: isPortable(), release };
}

/** Download the installer (progress(done, total)), start it, and quit so it can replace us. */
async function install(release, progress) {
  if (!release?.installer?.url || !/^https:\/\/github\.com\//.test(release.installer.url)) throw new Error('O‘rnatish fayli topilmadi');
  const dir = path.join(app.getPath('temp'), 'pult-update');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(release.installer.name).replace(/[^\w.-]/g, '_'));
  const r = await net.fetch(release.installer.url, { headers: { 'User-Agent': `Pult/${app.getVersion()}` } });
  if (!r.ok || !r.body) throw new Error(`Yuklab bo‘lmadi (${r.status})`);
  const total = Number(r.headers.get('content-length')) || release.installer.size || 0;
  const out = fs.createWriteStream(`${file}.part`);
  let done = 0;
  let last = 0;
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      done += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
      if (Date.now() - last > 200) {
        last = Date.now();
        progress?.(done, total);
      }
    }
  } finally {
    await new Promise((res) => out.end(res));
  }
  if (total && done < total) throw new Error('Yuklash to‘liq tugamadi');
  fs.renameSync(`${file}.part`, file);
  progress?.(done, total);
  const problem = await shell.openPath(file);
  if (problem) throw new Error(problem);
  setTimeout(() => app.quit(), 1500);
  return file;
}

module.exports = { check, install, newer };
