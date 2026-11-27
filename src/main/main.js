'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  dialog,
  shell,
  clipboard,
  powerMonitor,
  nativeTheme,
  Menu,
  Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const { Connection } = require('./connection');
const { TransferManager } = require('./transfers');
const { AgentWatch, stamp } = require('./agents');
const { Tunnels } = require('./tunnels');
const system = require('./system');
const { LocalEdits } = require('./localedit');
const updater = require('./updater');
const fsops = require('./fsops');

const ROOT = path.join(__dirname, '..', '..');
const SERVED = ['src', 'node_modules', 'assets'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Window background and the Windows caption buttons, matched to the chassis
// colour the renderer paints (see --body in styles.css).
const BODY = { gray: '#e2e1db', mint: '#d9e3da', sky: '#d8e1ea', sand: '#e9dccb' };
const COLORS = {
  dark: { bg: '#121314', symbol: '#ecece8' },
  light: { bg: BODY.gray, symbol: '#121314' },
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
const connections = new Map();
const agentWatches = new Map();
const tunnelSets = new Map();
const transfers = new TransferManager((id) => connections.get(id));
const localEdits = new LocalEdits((id) => connections.get(id));

const send = (channel, ...args) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

/* ---------------- prompts (main asks, renderer answers) ---------------- */

let promptSeq = 0;
const prompts = new Map();

function ask(kind, data) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(null);
    const id = `q${++promptSeq}`;
    prompts.set(id, resolve);
    send('prompt', { id, kind, ...data });
    if (win.isMinimized()) win.restore();
    win.flashFrame(!win.isFocused());
  });
}

ipcMain.handle('prompt:answer', (_e, id, answer) => {
  const resolve = prompts.get(id);
  prompts.delete(id);
  resolve?.(answer ?? null);
});

/* ---------------- window ---------------- */

const isDark = () => nativeTheme.shouldUseDarkColors;

function overlayColors() {
  if (isDark()) return { color: COLORS.dark.bg, symbolColor: COLORS.dark.symbol, height: 40 };
  const bg = BODY[store.getSettings().body] || COLORS.light.bg;
  return { color: bg, symbolColor: COLORS.light.symbol, height: 40 };
}

function paintWindow() {
  if (!win || win.isDestroyed()) return;
  win.setTitleBarOverlay(overlayColors());
  win.setBackgroundColor(overlayColors().color);
}

function createWindow() {
  const saved = store.getWindowState();
  win = new BrowserWindow({
    width: saved.width || 1240,
    height: saved.height || 780,
    x: saved.x,
    y: saved.y,
    minWidth: 860,
    minHeight: 540,
    show: false,
    backgroundColor: overlayColors().color,
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColors(),
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    if (saved.maximized) win.maximize();
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (!app.isPackaged && input.key === 'F12') win.webContents.toggleDevTools();
    if (!app.isPackaged && input.control && input.shift && input.key.toLowerCase() === 'r') win.reload();
  });

  win.on('close', (e) => {
    if (transfers.activeCount > 0) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Chiqish', 'Bekor qilish'],
        defaultId: 1,
        cancelId: 1,
        title: 'Pult',
        message: 'Fayl uzatish hali tugamagan',
        detail: 'Hozir chiqsangiz, tugallanmagan yuklashlar to‘xtatiladi.',
      });
      if (choice === 1) {
        e.preventDefault();
        return;
      }
    }
    const bounds = win.getNormalBounds();
    store.setWindowState({ ...bounds, maximized: win.isMaximized() });
  });

  win.on('focus', () => win.flashFrame(false));

  win.on('closed', () => {
    win = null;
  });

  win.loadURL('app://pult/src/renderer/index.html');
}

function registerProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(ROOT, rel));
    const top = path.relative(ROOT, file).split(path.sep)[0];
    if (!file.startsWith(ROOT + path.sep) || !SERVED.includes(top)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, {
        headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/* ---------------- helpers ---------------- */

const call = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
const posix = path.posix;

function conn(id) {
  const c = connections.get(id);
  if (!c) throw new Error('Ulanish topilmadi');
  return c;
}

const S_IFMT = 0o170000;
function entryType(mode) {
  switch (mode & S_IFMT) {
    case 0o040000:
      return 'dir';
    case 0o120000:
      return 'link';
    case 0o100000:
      return 'file';
    default:
      return 'other';
  }
}

function downloadDir() {
  const dir = store.getSettings().downloadDir;
  if (dir && fs.existsSync(dir)) return dir;
  return app.getPath('downloads');
}

// IPC handlers that fail turn into { error } so the renderer can show them.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: { message: String(err?.message || err), code: err?.code ?? null } };
    }
  });
}

/* ---------------- IPC: app & settings ---------------- */

const VERSION = require(path.join(ROOT, 'package.json')).version;

handle('app:info', () => ({
  version: VERSION,
  platform: process.platform,
  sshConfigHosts: store.sshConfigHosts().length,
}));

handle('settings:get', () => store.getSettings());
handle('settings:set', (patch) => {
  const s = store.setSettings(patch);
  if ('theme' in patch) nativeTheme.themeSource = s.theme;
  if ('body' in patch) paintWindow();
  if ('transferPace' in patch) transfers.setFast(s.transferPace === 'fast');
  if ('agentUsage' in patch) for (const a of agentWatches.values()) a.setUsage(s.agentUsage !== false);
  return s;
});

handle('clip:read', () => clipboard.readText());
handle('clip:write', (text) => clipboard.writeText(String(text)));
handle('clip:hasImage', async () => {
  try {
    return clipboard.readImage ? !clipboard.readImage().isEmpty() : await clipboard.has('image/png');
  } catch {
    return false;
  }
});

/** The clipboard image as PNG bytes, or null (Electron's async clipboard API). */
async function clipboardPng() {
  if (clipboard.readImage) {
    const img = clipboard.readImage();
    return img.isEmpty() ? null : img.toPNG();
  }
  let items = [];
  try {
    items = await clipboard.read();
  } catch {
    return null;
  }
  for (const item of items) {
    const type = item.types.find((t) => t === 'image/png') || item.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    if (blob && typeof blob.arrayBuffer === 'function') return Buffer.from(await blob.arrayBuffer());
  }
  return null;
}
handle('open:external', (url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});
handle('reveal', (p) => shell.showItemInFolder(p));
handle('open:path', (p) => shell.openPath(p));

handle('dialog:keyFile', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'SSH kalit faylini tanlang',
    defaultPath: path.join(app.getPath('home'), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? null : r.filePaths[0];
});

handle('dialog:uploadFiles', async (dirs) => {
  const r = await dialog.showOpenDialog(win, {
    title: dirs ? 'Yuklanadigan papkani tanlang' : 'Yuklanadigan fayllarni tanlang',
    properties: dirs ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});

handle('dialog:folder', async (title) => {
  const r = await dialog.showOpenDialog(win, {
    title: title || 'Papkani tanlang',
    defaultPath: downloadDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

handle('downloads:dir', () => downloadDir());

/* ---------------- IPC: servers ---------------- */

handle('servers:list', () => store.listServers());
handle('servers:save', (server) => store.saveServer(server));
handle('servers:delete', (id) => store.deleteServer(id));
handle('servers:import', () => store.importSshConfig());

/* ---------------- IPC: connections ---------------- */

handle('conn:open', async (connId, serverId) => {
  const server = await store.getServer(serverId);
  if (!server) throw new Error('Server topilmadi');
  const c = new Connection(connId, server, { ask, store });
  connections.set(connId, c);
  const agents = new AgentWatch(c, { usage: store.getSettings().agentUsage !== false });
  agentWatches.set(connId, agents);
  agents.on('update', (s) => send('agents', connId, s));
  const tunnels = new Tunnels(c);
  tunnelSets.set(connId, tunnels);
  tunnels.on('update', (list) => send('tun:update', connId, list));
  let tunnelsStarted = false;
  c.on('state', (s) => {
    send('conn:state', connId, s);
    if (s.state === 'ready' && !tunnelsStarted) {
      // Ports saved for this server open again on every connect.
      tunnelsStarted = true;
      for (const t of Array.isArray(server.tunnels) ? server.tunnels : []) tunnels.add(t).catch(() => {});
    }
    if (s.state === 'closed') {
      connections.delete(connId);
      agents.dispose();
      agentWatches.delete(connId);
      tunnels.closeAll();
      tunnelSets.delete(connId);
      localEdits.dropConnection(connId);
    }
  });
  c.on('stats', (s) => send('conn:stats', connId, s));
  c.on('shell:data', (shellId, data) => send('shell:data', shellId, data));
  c.on('shell:exit', (shellId) => send('shell:exit', shellId));
  c.on('shell:open', (shellId) => send('shell:open', shellId));
  store.touchServer(serverId);
  c.start();
  return true;
});

handle('conn:close', (connId) => {
  const c = connections.get(connId);
  if (!c) return;
  transfers.cancelForConnection(connId);
  c.close();
});

handle('conn:retry', (connId) => conn(connId).retryNow());

/* ---------------- IPC: shells ---------------- */

handle('shell:open', (connId, shellId, opts) => conn(connId).openShell(shellId, opts || {}));
handle('shell:reopen', (connId, shellId) => conn(connId).reopenShell(shellId));
handle('shell:close', (connId, shellId, opts) => conn(connId).closeShell(shellId, opts || {}));
handle('shell:history', (connId, session, lines) => conn(connId).history(session, lines));

// Hot paths use fire-and-forget messages.
ipcMain.on('shell:write', (_e, connId, shellId, data, binary) => {
  const c = connections.get(connId);
  if (!c) return;
  c.writeShell(shellId, binary ? Buffer.from(data, 'binary') : data);
});
ipcMain.on('shell:resize', (_e, connId, shellId, cols, rows) => connections.get(connId)?.resizeShell(shellId, cols, rows));
ipcMain.on('shell:ack', (_e, connId, shellId, bytes) => connections.get(connId)?.ackShell(shellId, bytes));

/* ---------------- IPC: files ---------------- */

handle('sftp:home', async (connId) => {
  const c = conn(connId);
  if (c.home) return c.home;
  const sftp = await c.sftp();
  return call((cb) => sftp.realpath('.', cb));
});

handle('sftp:realpath', async (connId, p) => {
  const sftp = await conn(connId).sftp();
  return call((cb) => sftp.realpath(p, cb));
});

handle('sftp:list', async (connId, dir) => {
  const sftp = await conn(connId).sftp();
  const real = await call((cb) => sftp.realpath(dir, cb));
  const list = await call((cb) => sftp.readdir(real, cb));
  const entries = await Promise.all(
    list.map(async (e) => {
      const a = e.attrs;
      let type = entryType(a.mode);
      let target = null;
      if (type === 'link') {
        const st = await call((cb) => sftp.stat(posix.join(real, e.filename), cb)).catch(() => null);
        target = st ? entryType(st.mode) : 'broken';
      }
      const parts = (e.longname || '').split(/\s+/);
      return {
        name: e.filename,
        type,
        target,
        size: a.size,
        mtime: a.mtime,
        mode: a.mode & 0o7777,
        owner: parts[2] || String(a.uid ?? ''),
        group: parts[3] || String(a.gid ?? ''),
      };
    }),
  );
  return { path: real, entries };
});

handle('sftp:mkdir', async (connId, p) => {
  const sftp = await conn(connId).sftp();
  await call((cb) => sftp.mkdir(p, cb));
});

handle('sftp:touch', async (connId, p) => {
  const sftp = await conn(connId).sftp();
  const handle = await call((cb) => sftp.open(p, 'wx', cb));
  await call((cb) => sftp.close(handle, cb));
});

handle('sftp:rename', async (connId, from, to) => {
  const sftp = await conn(connId).sftp();
  await call((cb) => sftp.rename(from, to, cb));
});

handle('sftp:chmod', async (connId, p, mode) => {
  const sftp = await conn(connId).sftp();
  await call((cb) => sftp.chmod(p, mode, cb));
});

handle('sftp:delete', async (connId, items) => {
  const c = conn(connId);
  const sftp = await c.sftp();
  const removeTree = async (p) => {
    const list = await call((cb) => sftp.readdir(p, cb));
    for (const e of list) {
      const child = posix.join(p, e.filename);
      if (entryType(e.attrs.mode) === 'dir') await removeTree(child);
      else await call((cb) => sftp.unlink(child, cb));
    }
    await call((cb) => sftp.rmdir(p, cb));
  };
  for (const { path: p, type } of items) {
    if (type !== 'dir') {
      await call((cb) => sftp.unlink(p, cb));
      continue;
    }
    // `rm -rf` is far faster for big trees; SFTP walk is the portable fallback.
    const quoted = `'${p.replace(/'/g, `'\\''`)}'`;
    const r = await c.exec(`rm -rf -- ${quoted}`, 120000).catch(() => null);
    if (r && r.code === 0) continue;
    await removeTree(p);
  }
});

handle('fs:copy', (connId, items, destDir) => fsops.copyItems(conn(connId), items, destDir));
handle('fs:move', (connId, items, destDir) => fsops.copyItems(conn(connId), items, destDir, { move: true }));
handle('fs:compress', (connId, cwd, names, archiveName, format) => fsops.compress(conn(connId), cwd, names, archiveName, format));
handle('fs:extract', (connId, filePath, mode) => fsops.extract(conn(connId), filePath, mode));
handle('fs:search', (connId, dir, query, mode) => fsops.search(conn(connId), dir, query, mode));
handle('fs:info', (connId, p) => fsops.info(conn(connId), p));
handle('fs:dirSize', (connId, p) => fsops.dirSize(conn(connId), p));

/* ---------------- IPC: updates (GitHub Releases) ---------------- */

let lastRelease = null;
handle('update:check', async () => {
  const r = await updater.check();
  lastRelease = r.release;
  return r;
});
handle('update:install', () => updater.install(lastRelease, (done, total) => send('update:progress', done, total)));
handle('update:page', () => {
  if (lastRelease?.page && /^https:\/\/github\.com\//.test(lastRelease.page)) shell.openExternal(lastRelease.page);
});

/* ---------------- IPC: preview / open on this computer ---------------- */

const PREVIEW_MAX = 25 * 1024 * 1024;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif' };

// An image as a data: URL (the page's CSP allows data: images, nothing else).
handle('fs:preview', async (connId, p) => {
  const mime = IMAGE_MIME[path.posix.extname(p).slice(1).toLowerCase()];
  if (!mime) throw Object.assign(new Error('Bu turdagi faylni ko‘rib bo‘lmaydi'), { code: 'NO_PREVIEW' });
  const sftp = await conn(connId).sftp();
  const st = await call((cb) => sftp.stat(p, cb));
  if (st.size > PREVIEW_MAX) throw Object.assign(new Error('Rasm juda katta (25 MB dan ortiq)'), { code: 'TOO_BIG' });
  const data = await call((cb) => sftp.readFile(p, cb));
  return { url: `data:${mime};base64,${data.toString('base64')}`, size: st.size, mtime: st.mtime };
});

handle('fs:openLocal', (connId, p) => localEdits.open(connId, p));
handle('edit:force', (local) => localEdits.force(local));
localEdits.on('synced', (item) => send('edit:synced', item));
localEdits.on('conflict', (item) => send('edit:conflict', item));
localEdits.on('failed', (item, message) => send('edit:failed', item, message));

/* ---------------- IPC: port forwarding ---------------- */

function tunnelsOf(connId) {
  const t = tunnelSets.get(connId);
  if (!t) throw new Error('Ulanish topilmadi');
  return t;
}

/** Remember the forwarded ports on the server record, so they reopen next time. */
async function saveTunnels(connId) {
  const c = conn(connId);
  const list = tunnelsOf(connId)
    .publicList()
    .map((t) => ({ remoteHost: t.remoteHost, remotePort: t.remotePort, localPort: t.wanted }));
  c.server.tunnels = list;
  await store.saveServer({ id: c.server.id, tunnels: list });
}

handle('tun:list', (connId) => tunnelsOf(connId).publicList());
handle('tun:add', async (connId, spec) => {
  const list = await tunnelsOf(connId).add(spec || {});
  await saveTunnels(connId);
  return list;
});
handle('tun:remove', async (connId, id) => {
  const list = tunnelsOf(connId).remove(id);
  await saveTunnels(connId);
  return list;
});
handle('tun:scan', (connId) => tunnelsOf(connId).scan());

/* ---------------- IPC: server health ---------------- */

// Processes using the most CPU. No --sort: busybox ps lacks it.
handle('sys:top', async (connId) => {
  const r = await conn(connId).exec('ps -eo pid=,user=,pcpu=,pmem=,rss=,etimes=,args= 2>/dev/null', 10000);
  const rows = [];
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const args = m[7].trim();
    if (/^ps -eo pid=/.test(args)) continue; // ourselves
    rows.push({ pid: Number(m[1]), user: m[2], cpu: Number(m[3]), mem: Number(m[4]), rss: Number(m[5]), etime: Number(m[6]), args: args.slice(0, 400) });
  }
  return rows.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem).slice(0, 15);
});

handle('sys:kill', async (connId, pid, force = false) => {
  const p = Number(pid);
  if (!Number.isInteger(p) || p < 2) throw new Error('Noto‘g‘ri jarayon raqami');
  const r = await conn(connId).exec(`kill -${force ? 'KILL' : 'TERM'} ${p}`, 8000);
  if (r.code !== 0) throw new Error(String(r.stderr || '').trim() || 'Jarayonni to‘xtatib bo‘lmadi (ruxsat yo‘qdir)');
});

/* ---------------- server administration: services, Docker, disk, logs ---------------- */

handle('sys:services', (connId) => system.services(conn(connId)));
handle('sys:service', (connId, unit, action) => system.serviceAction(conn(connId), unit, action));
handle('sys:containers', (connId) => system.containers(conn(connId)));
handle('sys:containerStats', (connId) => system.containerStats(conn(connId)));
handle('sys:container', (connId, id, action) => system.containerAction(conn(connId), id, action));
handle('sys:mounts', (connId) => system.mounts(conn(connId)));
handle('sys:usage', (connId, dir) => system.usage(conn(connId), dir));
handle('sys:bigFiles', (connId, dir) => system.bigFiles(conn(connId), dir));

// Live logs: one exec channel each; text goes to the window as it arrives.
const logStreams = new Map(); // id → { close }
let logSeq = 0;
handle('logs:open', async (connId, source) => {
  const cmd = system.logCommand(source);
  const id = `log${++logSeq}`;
  let buf = '';
  let timer = null;
  const flush = () => {
    timer = null;
    if (buf) send('logs:data', id, buf);
    buf = '';
  };
  const handleObj = await conn(connId).stream(cmd, {
    onData: (text) => {
      buf += text;
      if (!timer) timer = setTimeout(flush, 80); // batch bursts
    },
    onEnd: (code) => {
      clearTimeout(timer);
      flush();
      logStreams.delete(id);
      send('logs:end', id, code);
    },
  });
  logStreams.set(id, handleObj);
  return id;
});
handle('logs:close', (id) => {
  logStreams.get(id)?.close();
  logStreams.delete(id);
});

const MAX_EDIT_BYTES = 5 * 1024 * 1024;

handle('sftp:readText', async (connId, p) => {
  const sftp = await conn(connId).sftp();
  const st = await call((cb) => sftp.stat(p, cb));
  if (st.size > MAX_EDIT_BYTES) throw Object.assign(new Error('Fayl tahrirlash uchun juda katta (5 MB dan ortiq)'), { code: 'TOO_BIG' });
  const data = await call((cb) => sftp.readFile(p, cb));
  if (data.includes(0)) throw Object.assign(new Error('Bu matnli fayl emas'), { code: 'BINARY' });
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  return { text, size: st.size, mtime: st.mtime };
});

handle('sftp:writeText', async (connId, p, text) => {
  const sftp = await conn(connId).sftp();
  await call((cb) => sftp.writeFile(p, Buffer.from(text, 'utf8'), cb));
});

/* ---------------- IPC: transfers ---------------- */

handle('xfer:upload', (connId, localPaths, remoteDir, opts) => transfers.upload(connId, localPaths, remoteDir, opts || {}));
handle('xfer:download', (connId, remotePaths, localDir) => transfers.download(connId, remotePaths, localDir || downloadDir()));
handle('xfer:cancel', (id) => transfers.cancel(id));
handle('xfer:clear', () => transfers.clearFinished());
handle('xfer:list', () => transfers.list());

transfers.on('update', (job) => send('xfer:update', job));
transfers.on('done', (job) => send('xfer:done', job));
transfers.on('cleared', () => send('xfer:cleared', transfers.list()));

/* ---------------- IPC: AI agents (Claude Code, agy) ---------------- */

function agentsOf(connId) {
  const a = agentWatches.get(connId);
  if (!a) throw new Error('Ulanish topilmadi');
  return a;
}

handle('agents:get', (connId) => agentsOf(connId).publicState());
handle('agents:detect', async (connId) => {
  await agentsOf(connId).detect();
  return agentsOf(connId).publicState();
});
handle('agents:installClaude', (connId) => agentsOf(connId).installClaude());
handle('agents:removeClaude', (connId) => agentsOf(connId).removeClaude());
handle('agents:refreshAgy', (connId) => agentsOf(connId).refreshAgy());

// A screenshot on the clipboard, pasted into a terminal: the remote program
// cannot read this computer's clipboard, so the image goes to the server and
// the terminal gets its path. Returns null when there is no image.
handle('term:pasteImage', async (connId) => {
  const png = await clipboardPng();
  if (!png) return null;
  return agentsOf(connId).saveUpload(`paste-${stamp()}.png`, png);
});
handle('term:uploadDir', (connId) => agentsOf(connId).uploadDir());

// Desktop notification (e.g. Claude finished or asks for permission in a
// terminal you are not looking at). Clicking it brings that terminal back.
let notifySeq = 0;
const notices = new Map();
handle('notify', ({ title, body, tag }) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: String(title || 'Pult'), body: String(body || ''), silent: false });
  const id = ++notifySeq;
  notices.set(id, n); // keep a reference so the click handler survives GC
  n.on('click', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    send('notify:click', tag);
  });
  n.on('close', () => notices.delete(id));
  n.show();
  if (notices.size > 20) notices.delete(notices.keys().next().value);
  if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
  return true;
});

/* ---------------- app lifecycle ---------------- */

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  app.setAppUserModelId('uz.pult.app');
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = store.getSettings().theme || 'system';
  nativeTheme.on('updated', paintWindow);

  registerProtocol();
  transfers.setFast(store.getSettings().transferPace === 'fast');
  createWindow();

  // After sleep or a network change the old socket may be silently dead.
  powerMonitor.on('resume', () => {
    for (const c of connections.values()) {
      c.probe();
      c.retryNow();
    }
  });
  ipcMain.on('net:online', () => {
    for (const c of connections.values()) {
      c.retryNow();
      c.probe();
    }
  });
});

app.on('window-all-closed', () => {
  for (const c of connections.values()) c.close();
  app.quit();
});
