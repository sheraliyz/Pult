'use strict';

// Persistent local data: servers, settings, trusted host keys, window state.
// Secrets (passwords, passphrases) are sealed with the OS keychain (DPAPI on Windows).

const { app, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const file = (name) => path.join(app.getPath('userData'), name);

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function write(name, data) {
  const target = file(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

async function seal(value) {
  if (!value) return '';
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    return 'v2:' + (await safeStorage.encryptStringAsync(value)).toString('base64');
  }
  return 'b64:' + Buffer.from(value, 'utf8').toString('base64');
}

async function unseal(value) {
  if (!value) return '';
  try {
    if (value.startsWith('v2:')) return (await safeStorage.decryptStringAsync(Buffer.from(value.slice(3), 'base64'))).result;
    if (value.startsWith('b64:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
  } catch {
    // Sealed on another machine or user profile: treat as missing.
  }
  return '';
}

/* ---------------- servers ---------------- */

let servers = null;
const allServers = () => (servers ??= read('servers.json', []));
const saveServers = () => write('servers.json', allServers());

function publicServer(s) {
  const { password, passphrase, ...rest } = s;
  return { ...rest, hasPassword: !!password, hasPassphrase: !!passphrase };
}

const SERVER_FIELDS = ['name', 'host', 'port', 'username', 'auth', 'keyPath', 'persist', 'startDir'];

module.exports.listServers = () => allServers().map(publicServer);

module.exports.getServer = async (id) => {
  const s = allServers().find((x) => x.id === id);
  if (!s) return null;
  return { ...s, password: await unseal(s.password), passphrase: await unseal(s.passphrase) };
};

module.exports.saveServer = async (input) => {
  const password = typeof input.password === 'string' ? await seal(input.password) : undefined;
  const passphrase = typeof input.passphrase === 'string' ? await seal(input.passphrase) : undefined;
  const list = allServers();
  let s = list.find((x) => x.id === input.id);
  if (!s) {
    s = { id: crypto.randomUUID(), createdAt: Date.now(), lastUsed: 0, persist: true, auth: 'password' };
    list.push(s);
  }
  for (const k of SERVER_FIELDS) if (k in input) s[k] = input[k];
  s.host = String(s.host || '').trim();
  s.username = String(s.username || '').trim();
  s.name = String(s.name || '').trim() || s.host;
  s.port = Number(s.port) || 22;
  if (password !== undefined) s.password = password;
  if (passphrase !== undefined) s.passphrase = passphrase;
  saveServers();
  return publicServer(s);
};

module.exports.setSecret = async (id, field, value) => {
  if (!['password', 'passphrase'].includes(field)) return;
  const sealed = await seal(value);
  const s = allServers().find((x) => x.id === id);
  if (!s) return;
  s[field] = sealed;
  saveServers();
};

module.exports.deleteServer = (id) => {
  servers = allServers().filter((x) => x.id !== id);
  saveServers();
};

module.exports.touchServer = (id) => {
  const s = allServers().find((x) => x.id === id);
  if (!s) return;
  s.lastUsed = Date.now();
  saveServers();
};

/* ---------------- ~/.ssh/config import ---------------- */

function parseSshConfig() {
  let text;
  try {
    text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
  } catch {
    return [];
  }
  const hosts = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s*=?\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = null;
      const alias = value.split(/\s+/).find((a) => !/[*?!]/.test(a));
      if (alias) {
        current = { name: alias, host: alias, port: 22, username: '', keyPath: '' };
        hosts.push(current);
      }
    } else if (key === 'match') {
      current = null;
    } else if (current) {
      if (key === 'hostname') current.host = value;
      else if (key === 'port') current.port = Number(value) || 22;
      else if (key === 'user') current.username = value;
      else if (key === 'identityfile' && !current.keyPath) {
        current.keyPath = value.replace(/^~(?=$|[\\/])/, os.homedir());
      }
    }
  }
  return hosts;
}

module.exports.sshConfigHosts = () => {
  const existing = new Set(allServers().map((s) => `${s.username}@${s.host}:${s.port}`));
  return parseSshConfig().filter((h) => !existing.has(`${h.username}@${h.host}:${h.port}`));
};

module.exports.importSshConfig = async () => {
  const hosts = module.exports.sshConfigHosts();
  for (const h of hosts) {
    await module.exports.saveServer({
      ...h,
      username: h.username || os.userInfo().username,
      auth: h.keyPath ? 'key' : 'agent',
      persist: true,
    });
  }
  return hosts.length;
};

/* ---------------- settings ---------------- */

const DEFAULT_SETTINGS = {
  theme: 'system',
  fontSize: 13,
  cursorStyle: 'bar',
  cursorBlink: true,
  copyOnSelect: false,
  scrollback: 10000,
  downloadDir: '',
  // AI agents (Claude Code, agy)
  agentUsage: true,
  agentNotify: true,
  shiftEnterNewline: true,
  claudeCmd: 'claude',
  agyCmd: 'agy',
};

let settings = null;
module.exports.getSettings = () => (settings ??= { ...DEFAULT_SETTINGS, ...read('settings.json', {}) });
module.exports.setSettings = (patch) => {
  settings = { ...module.exports.getSettings(), ...patch };
  write('settings.json', settings);
  return settings;
};

/* ---------------- host keys ---------------- */

let hostKeys = null;
const allHostKeys = () => (hostKeys ??= read('known_hosts.json', {}));
module.exports.getHostKey = (hostport) => allHostKeys()[hostport] || null;
module.exports.setHostKey = (hostport, rec) => {
  allHostKeys()[hostport] = { ...rec, addedAt: Date.now() };
  write('known_hosts.json', allHostKeys());
};

// Is this key already trusted by the user's OpenSSH known_hosts?
module.exports.inOpenSshKnownHosts = (host, port, keyB64) => {
  let text;
  try {
    text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'known_hosts'), 'utf8');
  } catch {
    return false;
  }
  const name = port === 22 ? host : `[${host}]:${port}`;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;
    const [hosts, , key] = line.split(/\s+/);
    if (key !== keyB64 || !hosts) continue;
    for (const pattern of hosts.split(',')) {
      if (pattern === name) return true;
      if (pattern.startsWith('|1|')) {
        const [, , salt, hash] = pattern.split('|');
        const mac = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64');
        if (mac === hash) return true;
      }
    }
  }
  return false;
};

/* ---------------- window ---------------- */

module.exports.getWindowState = () => read('window.json', {});
module.exports.setWindowState = (state) => write('window.json', state);
