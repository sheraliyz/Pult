'use strict';

// Server administration over the existing SSH link: systemd services, Docker
// containers, disk usage and live logs. Everything is plain shell, parsed
// here; a non-root login uses passwordless sudo when it has it.

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// $S is "sudo -n" for a non-root user who may use sudo without a password.
const SUDO = 'if [ "$(id -u)" != 0 ] && sudo -n true 2>/dev/null; then S="sudo -n"; else S=""; fi; ';

const UNIT_RE = /^[\w@.:\\-]+\.service$/;
const CONTAINER_RE = /^[\w][\w.-]{0,127}$/;
const ABS_PATH_RE = /^\/[^\0\n\r]*$/;

const fail = (message, code = 'FAILED') => Object.assign(new Error(message), { code });

/** What a failed command said, in one line. */
const said = (r) => String(r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0] || `xato (kod ${r.code})`;

/* ---------------- systemd ---------------- */

/** `systemctl list-units` + `list-unit-files` → services, broken ones first. */
function parseServices(units, files) {
  const enabled = new Map();
  for (const line of String(files || '').split('\n')) {
    const [unit, state] = line.trim().split(/\s+/);
    if (unit && UNIT_RE.test(unit) && !unit.includes('@.')) enabled.set(unit, state);
  }
  const list = new Map();
  for (const line of String(units || '').split('\n')) {
    const m = line.trim().match(/^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m || m[2] === 'not-found') continue;
    list.set(m[1], { unit: m[1], load: m[2], active: m[3], sub: m[4], description: m[5].trim(), enabled: enabled.get(m[1]) || null });
  }
  // Installed but never loaded (disabled, not needed by anything): inactive.
  for (const [unit, state] of enabled) {
    if (!list.has(unit) && state !== 'masked' && state !== 'static' && state !== 'alias') {
      list.set(unit, { unit, load: 'loaded', active: 'inactive', sub: 'dead', description: '', enabled: state });
    }
  }
  const rank = (s) => (s.active === 'failed' ? 0 : s.active === 'active' || s.active === 'activating' || s.active === 'reloading' ? 1 : 2);
  return [...list.values()].sort((a, b) => rank(a) - rank(b) || a.unit.localeCompare(b.unit));
}

async function services(conn) {
  const r = await conn.exec(
    'command -v systemctl >/dev/null 2>&1 || { echo NO_SYSTEMD; exit 0; }; ' +
      'systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null; echo @@FILES; ' +
      'systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null; true',
    20000,
  );
  if (/^NO_SYSTEMD/m.test(r.stdout)) throw fail('Bu serverda systemd yo‘q', 'NO_SYSTEMD');
  const [units, files] = String(r.stdout).split('@@FILES');
  return parseServices(units, files);
}

async function serviceAction(conn, unit, action) {
  if (!UNIT_RE.test(String(unit))) throw fail('Xizmat nomi noto‘g‘ri');
  if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) throw fail('Noma’lum amal');
  const r = await conn.exec(`${SUDO}$S systemctl ${action} -- ${shq(unit)} 2>&1`, 60000);
  if (r.code !== 0) throw fail(/authentication|access denied|permission/i.test(r.stdout + r.stderr) ? 'Ruxsat yo‘q: bu amal uchun root yoki parolsiz sudo kerak' : said(r));
}

/* ---------------- docker ---------------- */

function parseContainers(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    out.push({
      id: String(o.ID || '').slice(0, 12),
      name: String(o.Names || '').split(',')[0],
      image: String(o.Image || ''),
      state: String(o.State || '').toLowerCase(), // running | exited | paused | restarting | created | dead
      status: String(o.Status || ''),
      ports: String(o.Ports || ''),
      created: String(o.RunningFor || ''),
    });
  }
  const rank = (c) => (c.state === 'running' ? 0 : c.state === 'restarting' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function parseDockerStats(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const o = JSON.parse(line);
      const id = String(o.ID || o.Container || '').slice(0, 12);
      out[id] = { cpu: String(o.CPUPerc || ''), mem: String(o.MemUsage || '').split('/')[0].trim(), memPerc: String(o.MemPerc || '') };
    } catch {
      // skip
    }
  }
  return out;
}

async function containers(conn) {
  const r = await conn.exec(`${SUDO}command -v docker >/dev/null 2>&1 || { echo NO_DOCKER; exit 0; }; $S docker ps -a --no-trunc --format '{{json .}}' 2>&1`, 20000);
  if (/^NO_DOCKER/m.test(r.stdout)) throw fail('Bu serverda Docker o‘rnatilmagan', 'NO_DOCKER');
  if (/permission denied|cannot connect to the docker daemon/i.test(r.stdout)) {
    throw fail(/permission/i.test(r.stdout) ? 'Docker’ga ruxsat yo‘q: foydalanuvchi docker guruhida emas' : 'Docker ishlamayapti (dockerd to‘xtagan)', 'DOCKER_DENIED');
  }
  return parseContainers(r.stdout);
}

async function containerStats(conn) {
  const r = await conn.exec(`${SUDO}$S docker stats --no-stream --no-trunc --format '{{json .}}' 2>/dev/null; true`, 25000);
  return parseDockerStats(r.stdout);
}

async function containerAction(conn, id, action) {
  if (!CONTAINER_RE.test(String(id))) throw fail('Konteyner nomi noto‘g‘ri');
  if (!['start', 'stop', 'restart'].includes(action)) throw fail('Noma’lum amal');
  const r = await conn.exec(`${SUDO}$S docker ${action} ${shq(id)} 2>&1`, 90000);
  if (r.code !== 0) throw fail(said(r));
}

/* ---------------- disk ---------------- */

/** `df -PkT` → mounted filesystems (pseudo ones dropped). */
function parseMounts(text) {
  const out = [];
  for (const line of String(text || '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 7) continue;
    const [fs, type, size, used, avail] = f;
    const mount = f.slice(6).join(' ');
    if (!/^\d+$/.test(size) || Number(size) === 0) continue;
    if (/^(tmpfs|devtmpfs|squashfs|overlay|efivarfs|proc|sysfs|cgroup2?|nsfs|ramfs)$/.test(type)) continue;
    out.push({ fs, type, size: Number(size) * 1024, used: Number(used) * 1024, avail: Number(avail) * 1024, mount });
  }
  return out.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
}

async function mounts(conn) {
  const r = await conn.exec('df -PkT 2>/dev/null', 15000);
  return parseMounts(r.stdout);
}

/** `du -x -k -d1 -a` (+ the folder names after @@DIRS) → the folder's total and its biggest entries. */
function parseUsage(text, dir) {
  const [du, dirList = ''] = String(text || '').split('@@DIRS');
  const dirs = new Set(dirList.split('\n').map((l) => l.trim()).filter(Boolean));
  let total = 0;
  const items = [];
  for (const line of du.split('\n')) {
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const bytes = Number(m[1]) * 1024;
    if (m[2] === '.') {
      total = bytes;
      continue;
    }
    const name = m[2].replace(/^\.\//, '');
    items.push({ name, path: dir === '/' ? `/${name}` : `${dir}/${name}`, bytes, dir: dirs.has(name) });
  }
  items.sort((a, b) => b.bytes - a.bytes);
  return { dir, total, items };
}

async function usage(conn, dir) {
  if (!ABS_PATH_RE.test(String(dir))) throw fail('Yo‘l noto‘g‘ri');
  // Folders and files directly inside, this disk only; gentle on the server.
  const r = await conn.exec(
    `${SUDO}cd -- ${shq(dir)} || exit 3; T=$(command -v timeout >/dev/null 2>&1 && echo "timeout 150"); ` +
      `$S $T nice -n 19 du -x -k -d1 -a -- . 2>/dev/null | sort -rn | head -n 120; echo @@DIRS; ` +
      `$S find . -mindepth 1 -maxdepth 1 -xdev -type d -printf '%f\\n' 2>/dev/null | head -n 5000`,
    170000,
  );
  if (r.code === 3) throw fail('Papka ochilmadi');
  return parseUsage(r.stdout, dir);
}

/** Files of 100 MB and more under a folder (this disk only). */
async function bigFiles(conn, dir) {
  if (!ABS_PATH_RE.test(String(dir))) throw fail('Yo‘l noto‘g‘ri');
  const r = await conn.exec(
    `${SUDO}T=$(command -v timeout >/dev/null 2>&1 && echo "timeout 120"); $S $T nice -n 19 find ${shq(dir)} -xdev -type f -size +100M -printf '%s\\t%T@\\t%p\\n' 2>/dev/null | sort -rn | head -n 40`,
    140000,
  );
  const out = [];
  for (const line of String(r.stdout || '').split('\n')) {
    const [size, mtime, ...p] = line.split('\t');
    if (!/^\d+$/.test(size || '') || !p.length) continue;
    out.push({ bytes: Number(size), mtime: Math.round(Number(mtime) * 1000) || 0, path: p.join('\t') });
  }
  return out;
}

/* ---------------- logs ---------------- */

/** The shell command that follows one log source (see Connection.stream). */
function logCommand(source) {
  const n = 400;
  switch (source?.kind) {
    case 'journal':
      return `${SUDO}exec $S journalctl -n ${n} -f -l --no-pager -o short-iso`;
    case 'unit':
      if (!UNIT_RE.test(String(source.unit))) throw fail('Xizmat nomi noto‘g‘ri');
      return `${SUDO}exec $S journalctl -u ${shq(source.unit)} -n ${n} -f -l --no-pager -o short-iso`;
    case 'docker':
      if (!CONTAINER_RE.test(String(source.id))) throw fail('Konteyner nomi noto‘g‘ri');
      return `${SUDO}exec $S docker logs -f --tail ${n} --timestamps ${shq(source.id)}`;
    case 'file':
      if (!ABS_PATH_RE.test(String(source.path))) throw fail('Yo‘l noto‘g‘ri');
      return `${SUDO}if [ -r ${shq(source.path)} ]; then S=""; fi; exec $S tail -n ${n} -F -- ${shq(source.path)}`;
    default:
      throw fail('Noma’lum log manbasi');
  }
}

module.exports = {
  services,
  serviceAction,
  containers,
  containerStats,
  containerAction,
  mounts,
  usage,
  bigFiles,
  logCommand,
  parseServices,
  parseContainers,
  parseDockerStats,
  parseMounts,
  parseUsage,
};
