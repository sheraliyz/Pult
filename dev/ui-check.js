'use strict';

// Screenshots of the file-manager features (menus, copy bar, search,
// properties, code editor) against dev/mock-server.js:
//   electron dev/ui-check.js <outDir>      (env MOCK_PORT, SHOT_THEME=light)

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const outDir = path.resolve(process.argv[2] || 'ui-shots');
const theme = process.env.SHOT_THEME || 'dark';
const profile = path.join(outDir, `profile-ui-${theme}`);
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

const b64 = (s) => 'b64:' + Buffer.from(s).toString('base64');
fs.writeFileSync(
  path.join(profile, 'servers.json'),
  JSON.stringify([
    { id: 'demo', name: 'acme-prod', host: '127.0.0.1', port: Number(process.env.MOCK_PORT || 2222), username: 'demo', auth: 'password', password: b64('demo'), persist: true, createdAt: Date.now(), lastUsed: Date.now() },
  ]),
);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme, downloadDir: outDir }));
fs.writeFileSync(path.join(profile, 'window.json'), JSON.stringify({ width: 1280, height: 800, x: 40, y: 40 }));

const S = 'window.__pult.activeSession()';
const F = `${S}.files`;
const steps = [
  { js: 'window.__pult.openServer(window.__pult.servers[0])', wait: 2500 },
  { js: `${S}.setMode("files")`, wait: 1000 },
  { js: `${F}.go("/home/demo/downloads")`, wait: 900 },
  {
    js: `(() => { ${F}.select("site-backup.zip"); const r = ${F}.list.querySelector('[data-name="site-backup.zip"]').getBoundingClientRect(); ${F}.rowMenu(r.left + 160, r.top + 10); })()`,
    wait: 400,
    shot: 'menu-archive',
  },
  { key: 'Escape', wait: 100 },
  { js: `(() => { ${F}.select("install.sh"); ${F}.copySelection(false); })()`, wait: 200 },
  { js: `${F}.go("/home/demo/scripts")`, wait: 900, shot: 'clipbar' },
  { js: `${F}.paste()`, wait: 1500, shot: 'pasted' },
  { js: `${F}.go("/home/demo")`, wait: 900 },
  {
    js: `(() => { ${F}.openSearch(); const i = document.querySelector('.srch-modal input'); i.value = '8080'; document.querySelectorAll('.srch-modal .segmented button')[1].click(); })()`,
    wait: 1800,
    shot: 'search-content',
  },
  { key: 'Escape', wait: 300 },
  // Alt+Enter on the selected row opens its properties (not the folder).
  { js: `(() => { ${F}.select("backups"); ${F}.list.focus(); })()`, wait: 200 },
  { key: 'Alt+Return', wait: 1500 },
  { js: `document.querySelector('.modal .link-btn')?.click()`, wait: 1500, shot: 'properties' },
  { key: 'Escape', wait: 300 },
  { js: `${F}.edit(${F}.entries.find(x => x.name === "docker-compose.yml"))`, wait: 1200 },
  { key: 'Control+F', wait: 300 },
  // The search field commits on keyup: Enter jumps to the first match.
  { type: 'image', wait: 200 },
  { key: 'Return', wait: 600, shot: 'editor-search' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 3) console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  win.webContents.once('did-finish-load', async () => {
    await sleep(1200);
    for (const s of steps) {
      try {
        if (s.js) await win.webContents.executeJavaScript(`void (${s.js})`, true);
        if (s.key) {
          const [mod, key] = s.key.includes('+') ? s.key.split('+') : [null, s.key];
          const modifiers = mod ? [mod.toLowerCase()] : [];
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
        }
        if (s.type) for (const ch of s.type) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
        if (s.wait) await sleep(s.wait);
        if (s.shot) {
          const img = await win.webContents.capturePage();
          const file = path.join(outDir, `${s.shot}${theme === 'light' ? '-light' : ''}.png`);
          fs.writeFileSync(file, img.toPNG());
          console.log('shot', file);
        }
      } catch (err) {
        console.log('step failed', JSON.stringify(s), err.message);
      }
    }
    setTimeout(() => app.exit(0), 300);
  });
});

require('../src/main/connection').Connection.prototype.verifyHost = async () => true;
require('../src/main/main.js');
