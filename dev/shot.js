'use strict';

// Dev harness: launches the real app with a throwaway profile, drives it with
// a scripted scenario and saves screenshots.
//   electron dev/shot.js <scenario> <outDir>

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const scenario = process.argv[2] || 'home';
const outDir = path.resolve(process.argv[3] || 'shots');
const profile = path.join(outDir, `profile-${scenario}`);
const theme = process.env.SHOT_THEME || 'dark';

fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

const b64 = (s) => 'b64:' + Buffer.from(s).toString('base64');
const now = Date.now();
const servers = [
  { id: 'demo', name: 'acme-prod', host: '127.0.0.1', port: 2222, username: 'demo', auth: 'password', password: b64('demo'), persist: true, createdAt: now, lastUsed: now - 2 * 3600e3 },
  { id: 's2', name: 'db-01', host: 'db.acme.uz', port: 22, username: 'postgres', auth: 'key', keyPath: '', persist: true, createdAt: now, lastUsed: now - 26 * 3600e3 },
  { id: 's3', name: 'staging', host: '10.0.8.21', port: 2200, username: 'deploy', auth: 'agent', persist: true, createdAt: now, lastUsed: now - 5 * 86400e3 },
  { id: 's4', name: 'vpn-gateway', host: 'vpn.acme.uz', port: 22, username: 'root', auth: 'password', persist: false, createdAt: now, lastUsed: 0 },
];
if (scenario === 'prompt') {
  servers.push({ id: 's6', name: 'acme-prod (parolsiz)', host: '127.0.0.1', port: 2222, username: 'demo', auth: 'password', persist: true, createdAt: now, lastUsed: 0 });
}
if (scenario === 'failed') {
  servers.push({ id: 's5', name: 'backup-nas', host: '127.0.0.1', port: 2299, username: 'admin', auth: 'password', password: b64('x'), persist: true, createdAt: now, lastUsed: 0 });
}
if (scenario !== 'empty') fs.writeFileSync(path.join(profile, 'servers.json'), JSON.stringify(servers));
const downloads = path.join(outDir, 'downloads');
fs.mkdirSync(downloads, { recursive: true });
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme, downloadDir: downloads }));
// SHOT_SIZE=1600x1000 for larger captures (default 1280x800).
const [winW, winH] = (process.env.SHOT_SIZE || '1280x800').split('x').map(Number);
fs.writeFileSync(path.join(profile, 'window.json'), JSON.stringify({ width: winW, height: winH, x: 40, y: 40 }));
// Trust the mock server's key without a prompt (it changes every run).
const trustAll = scenario !== 'hostkey';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = {
  empty: [{ shot: 'empty' }],
  home: [{ shot: 'home' }],
  form: [
    { js: 'void window.__pult.editServer()' },
    { wait: 500 },
    { shot: 'form' },
    { js: 'document.querySelectorAll(".segmented button")[1].click()' },
    { wait: 300 },
    { shot: 'form-key' },
  ],
  edit: [{ js: 'void window.__pult.editServer(window.__pult.servers[0])' }, { wait: 500 }, { shot: 'form-edit' }],
  menu: [
    { js: 'document.querySelector(".srv").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 700, clientY: 190 }))' },
    { wait: 300 },
    { shot: 'menu' },
  ],
  settings: [{ js: 'document.querySelector(".tb-settings").click()' }, { wait: 500 }, { shot: 'settings' }],
  connect: [
    { js: 'window.__pult.openServer(window.__pult.servers.find(s => s.id === "demo"))' },
    { wait: 2500 },
    { type: 'docker ps\r' },
    { wait: 400 },
    { type: 'systemctl status nginx\r' },
    { wait: 400 },
    { type: 'df -h\r' },
    { wait: 3500 },
    { shot: 'terminal' },
    { js: 'window.__pult.activeSession().addShell()' },
    { wait: 1200 },
    { js: 'window.__pult.activeSession().select(window.__pult.activeSession().shells[0])' },
    { wait: 300 },
    { shot: 'terminal-2' },
    { js: 'window.__pult.activeSession().setMode("files")' },
    { wait: 1500 },
    { shot: 'files' },
    { js: 'window.__pult.activeSession().setMode("split")' },
    { wait: 1200 },
    { shot: 'split' },
    { js: 'window.__pult.activeSession().files.go("/home/demo/backups")' },
    { wait: 800 },
    { js: 'window.__pult.activeSession().files.download(window.__pult.activeSession().files.entries)' },
    { wait: 1500 },
    { shot: 'transfer' },
    // Kill the network mid-download: the job must wait, then resume.
    { type: 'outage 6\r' },
    { wait: 2500 },
    { shot: 'reconnecting' },
    { wait: 9000 },
    { shot: 'reconnected' },
    { wait: 12000 },
    { shot: 'transfer-done' },
    { js: 'window.__pult.activeSession().files.go("/home/demo")' },
    { wait: 800 },
    { js: 'window.__pult.activeSession().files.edit(window.__pult.activeSession().files.entries.find(e => e.name === "docker-compose.yml"))' },
    { wait: 900 },
    { shot: 'editor' },
    { js: 'window.__pult.activeSession().editor.close()' },
    { wait: 400 },
    { js: 'window.__pult.activate("home")' },
    { wait: 500 },
    { shot: 'home-live' },
  ],
  files: [
    { js: 'window.__pult.openServer(window.__pult.servers.find(s => s.id === "demo"))' },
    { wait: 2500 },
    { js: 'window.__pult.activeSession().setMode("files")' },
    { wait: 1200 },
    { js: 'window.__pult.activeSession().files.go("/home/demo/downloads")' },
    { wait: 1000 },
    { shot: 'files-kinds' },
    { js: 'window.__pult.activeSession().setMode("split")' },
    { wait: 1000 },
    { shot: 'files-kinds-split' },
  ],
  osc52: [
    { js: 'window.__pult.openServer(window.__pult.servers.find(s => s.id === "demo"))' },
    { wait: 2500 },
    { type: 'copytest\r' },
    { wait: 600 },
    { shot: 'osc52' },
  ],
  prompt: [
    { js: 'window.__pult.openServer(window.__pult.servers.find(s => s.id === "s6"))' },
    { wait: 800 },
    { shot: 'prompt' },
    { js: 'const i = document.querySelector(".modal input[type=password]"); i.value = "demo"; document.querySelector(".modal [data-primary]").click()' },
    { wait: 2500 },
    { shot: 'prompt-done' },
    // Saved (encrypted) password must be used on the next connect: no prompt.
    { js: 'window.__pult.closeSession(window.__pult.activeSession())' },
    { wait: 800 },
    { js: 'window.__pult.reloadServers().then(() => window.__pult.openServer(window.__pult.servers.find(s => s.id === "s6")))' },
    { wait: 2500 },
    { js: 'console.warn("CHECK modal-open=" + !!document.querySelector(".modal") + " state=" + window.__pult.activeSession().state.state)' },
  ],
  failed: [
    { js: 'window.__pult.openServer(window.__pult.servers.find(s => s.id === "s5"))' },
    { wait: 2500 },
    { shot: 'failed' },
  ],
  // AI agents against the mock's fake `claude` / `agy` (start it with a fresh
  // MOCK_ROOT, or remove ~/.claude and ~/.pult there, to see the setup step).
  agents: [
    { js: 'window.__pult.openServer(window.__pult.servers.find(s => s.id === "demo"))' },
    { wait: 3000 },
    { shot: 'ai-statusbar-setup' },
    { js: 'document.querySelector(".sb-agent").click()' },
    { wait: 900 },
    { shot: 'ai-panel-setup' },
    { js: '[...document.querySelectorAll(".ai-panel .btn-primary")].find(b => b.textContent === "Ulash")?.click()' },
    { wait: 1500 },
    { js: 'document.querySelector(".ai-panel .icon-btn")?.click()' },
    { js: 'window.__pult.activeSession().launchAgent("claude")' },
    { wait: 1500 },
    { type: 'README ga o‘rnatish bo‘limini qo‘sh\r' },
    { wait: 2600 },
    { shot: 'ai-claude' },
    { js: 'window.__pult.activeSession().openAgentMenu()' },
    { wait: 300 },
    { shot: 'ai-menu' },
    { key: 'Escape' },
    { js: 'document.querySelector(".sb-agent").click()' },
    { wait: 900 },
    { shot: 'ai-panel' },
    { js: 'document.querySelector(".ai-panel .icon-btn")?.click()' },
    // Ask Claude something, then look at another terminal: its bell marks the tab.
    { type: 'testlarni ishga tushir\r' },
    { js: 'window.__pult.activeSession().select(window.__pult.activeSession().shells[0])' },
    { wait: 2200 },
    { shot: 'ai-attention' },
    { js: 'window.__pult.activeSession().launchAgent("agy")' },
    { wait: 1200 },
    { type: 'deploy skriptini tekshir\r' },
    { wait: 2200 },
    { shot: 'ai-agy' },
    { js: 'window.__pult.activeSession().setMode("files")' },
    { wait: 1200 },
    { js: '(() => { const f = window.__pult.activeSession().files; f.select("apps"); const r = f.list.querySelector(\'[data-name="apps"]\').getBoundingClientRect(); f.rowMenu(r.left + 120, r.top + 10); })()' },
    { wait: 400 },
    { shot: 'ai-files-menu' },
    { key: 'Escape' },
    { js: 'document.querySelector(".tb-settings").click()' },
    { wait: 600 },
    { js: 'document.querySelector(".modal .m-body").scrollTop = 9999' },
    { wait: 300 },
    { shot: 'ai-settings' },
  ],
  // Typing into an agent: Shift+Enter, files handed over, a pasted screenshot.
  'agent-input': [
    { js: 'window.__pult.openServer(window.__pult.servers.find(s => s.id === "demo"))' },
    { wait: 3000 },
    { js: 'window.__pult.activeSession().launchAgent("claude")' },
    { wait: 1500 },
    { chars: 'birinchi qator' },
    { key: 'Shift+Return' },
    { chars: 'ikkinchi qator' },
    { wait: 400 },
    { shot: 'input-newline' },
    { key: 'Return' },
    { wait: 1800 },
    { js: `window.__pult.activeSession().active.sendFiles([${JSON.stringify(path.join(__dirname, '..', 'README.md'))}])` },
    { wait: 2500 },
    { shot: 'input-files' },
    { clipboardImage: true },
    { js: 'window.__pult.activeSession().active.pasteImage()' },
    { wait: 1500 },
    { shot: 'input-image' },
  ],
  hostkey: [
    { js: 'window.__pult.openServer(window.__pult.servers.find(s => s.id === "demo"))' },
    { wait: 2000 },
    { shot: 'hostkey' },
  ],
};

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event;
    if (level === 'error' || level === 'warning' || level === 3 || level === 2) console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
  });
  win.webContents.once('did-finish-load', async () => {
    await sleep(1200);
    const steps = SCENARIOS[scenario] || [];
    for (const step of steps) {
      try {
        if (step.js) await win.webContents.executeJavaScript(step.js, true);
        if (step.type) {
          await win.webContents.executeJavaScript(
            `(() => { const v = window.__pult.activeSession()?.active; if (v) v.write(${JSON.stringify(step.type)}); })()`,
            true,
          );
        }
        if (step.key) {
          // "Escape", "Shift+Return", "Control+Shift+A"
          const parts = step.key.split('+');
          const keyCode = parts.pop();
          const modifiers = parts.map((m) => m.toLowerCase());
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
          if (keyCode.length === 1 && !modifiers.length) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
        }
        if (step.chars) for (const ch of step.chars) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
        if (step.clipboardImage) {
          const { clipboard, ClipboardItem } = require('electron');
          const png = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png'));
          await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
        }
        if (step.wait) await sleep(step.wait);
        if (step.shot) {
          const img = await win.webContents.capturePage();
          const file = path.join(outDir, `${step.shot}${theme === 'light' ? '-light' : ''}.png`);
          fs.writeFileSync(file, img.toPNG());
          console.log('shot', file);
        }
      } catch (err) {
        console.log('step failed', JSON.stringify(step), err.message);
      }
    }
    setTimeout(() => app.exit(0), 300);
  });
});

// PULT_APP lets the same scenarios run against a packaged app.asar.
const APP = process.env.PULT_APP || path.join(__dirname, '..');

if (trustAll) {
  // Pre-accept any host key for the dev profile.
  require(path.join(APP, 'src', 'main', 'connection')).Connection.prototype.verifyHost = async () => true;
}

require(path.join(APP, 'src', 'main', 'main.js'));

// Never touch the real Windows clipboard from tests: record writes instead.
const { ipcMain } = require('electron');
ipcMain.removeHandler('clip:write');
ipcMain.handle('clip:write', (_e, text) => {
  console.log('CLIPBOARD <=', JSON.stringify(text));
  return { ok: true, value: undefined };
});
ipcMain.removeHandler('clip:read');
ipcMain.handle('clip:read', () => ({ ok: true, value: '' }));
ipcMain.removeHandler('clip:hasImage');
ipcMain.handle('clip:hasImage', () => ({ ok: true, value: false }));
// Desktop notifications are logged, not shown.
ipcMain.removeHandler('notify');
ipcMain.handle('notify', (_e, n) => {
  console.log('NOTIFY', JSON.stringify(n));
  return { ok: true, value: true };
});
