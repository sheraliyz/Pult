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

/* ---------------- security check ---------------- */

const NEED_ROOT = '[ "$(id -u)" = 0 ] || [ -n "$S" ] || { echo NO_ROOT; exit 3; }; ';

// One round trip: every section is printed after an @@NAME line.
const SECURITY_SCRIPT = [
  SUDO,
  'echo @@OS; (. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-$(uname -sr)}")',
  'echo @@WHO; id -un; id -u; [ -n "$S" ] && echo SUDO',
  'echo @@LISTEN; ($S ss -ltnupH 2>/dev/null || $S netstat -ltnup 2>/dev/null) | head -n 300',
  'echo @@UFW; if command -v ufw >/dev/null 2>&1; then $S ufw status 2>&1 | head -n 80; else echo NO_UFW; fi',
  "echo @@NFT; if command -v nft >/dev/null 2>&1; then $S nft list ruleset 2>/dev/null | grep -cE '\\b(drop|reject)\\b'; fi",
  'echo @@IPT; if command -v iptables >/dev/null 2>&1; then $S iptables -S INPUT 2>/dev/null | head -n 1; fi',
  "echo @@SSHD; $S sshd -T 2>/dev/null | grep -iE '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|permitemptypasswords|kbdinteractiveauthentication|maxauthtries) '",
  "echo @@SSHDINC; grep -qiE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/' /etc/ssh/sshd_config 2>/dev/null && echo INCLUDE; [ -f /etc/ssh/sshd_config.d/01-pult.conf ] && echo PULT_DROPIN",
  "echo @@F2B; if command -v fail2ban-client >/dev/null 2>&1; then echo INSTALLED; systemctl is-active fail2ban 2>/dev/null; $S fail2ban-client status sshd 2>/dev/null | grep -E 'Currently failed|Total failed|Currently banned|Total banned'; else echo NO_F2B; fi",
  'if $S journalctl -n 1 -u ssh -u sshd --no-pager >/dev/null 2>&1; then SRC=journal; else SRC=authlog; fi',
  'echo @@FAILS; echo "SRC $SRC"; if [ "$SRC" = journal ]; then $S journalctl -u ssh -u sshd --since "-24h" --no-pager -o cat 2>/dev/null; else $S tail -n 20000 /var/log/auth.log /var/log/secure 2>/dev/null; fi | ' +
    "awk '/Failed password for/{u=\"\";ip=\"\";for(i=1;i<=NF;i++){if($i==\"for\"){u=$(i+1);if(u==\"invalid\"){u=$(i+3)}}if($i==\"from\"){ip=$(i+1)}}print \"F\",u,ip;next} /Invalid user /{u=\"\";ip=\"\";for(i=1;i<=NF;i++){if($i==\"user\"){u=$(i+1)}if($i==\"from\"){ip=$(i+1)}}print \"I\",u,ip}' | sort | uniq -c | sort -rn | head -n 400",
  "echo @@OK; if [ \"$SRC\" = journal ]; then $S journalctl -u ssh -u sshd --since '-7d' --no-pager -o short-iso 2>/dev/null | grep 'Accepted ' | tail -n 12; else $S grep -h 'Accepted ' /var/log/auth.log /var/log/secure 2>/dev/null | tail -n 12; fi",
  "echo @@UPD; if command -v apt-get >/dev/null 2>&1; then apt list --upgradable 2>/dev/null | grep -c '/'; apt list --upgradable 2>/dev/null | grep -c -- '-security'; else echo NO_APT; fi",
  'echo @@AUTO; systemctl is-enabled unattended-upgrades 2>/dev/null; grep -hs "Unattended-Upgrade" /etc/apt/apt.conf.d/20auto-upgrades /etc/apt/apt.conf.d/10periodic',
  'echo @@REBOOT; if [ -f /var/run/reboot-required ]; then echo YES; head -n 12 /var/run/reboot-required.pkgs 2>/dev/null; fi',
  "echo @@UID0; awk -F: '$3==0{print $1}' /etc/passwd",
  "echo @@EMPTY; if [ \"$(id -u)\" = 0 ] || [ -n \"$S\" ]; then $S awk -F: '($2==\"\"){print $1}' /etc/shadow 2>/dev/null; echo DONE; fi",
  'echo @@END',
].join('\n');

const RISKY_PORTS = {
  21: 'FTP (parol ochiq matnda)',
  23: 'Telnet (shifrsiz)',
  2375: 'Docker API — shifrsiz, serverni to‘liq boshqarish mumkin',
  3306: 'MySQL',
  3389: 'RDP',
  5432: 'PostgreSQL',
  5900: 'VNC',
  5984: 'CouchDB',
  6379: 'Redis',
  8086: 'InfluxDB',
  9200: 'Elasticsearch',
  11211: 'Memcached',
  27017: 'MongoDB',
  1433: 'MS SQL',
};

function sections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^@@([A-Z0-9]+)$/);
    if (m) {
      cur = m[1];
      out[cur] = [];
    } else if (cur) out[cur].push(line);
  }
  return out;
}

const isLoopback = (a) => /^(127\.|::1$|localhost$|0:0:0:0:0:0:0:1$)/.test(a);
const isPrivate = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fe80:|fd|fc|169\.254\.)/i.test(a);

/** The security script's output → structured facts (the window turns them into checks). */
function parseSecurity(text) {
  const sec = sections(text);
  const lines = (k) => (sec[k] || []).map((l) => l.trim()).filter(Boolean);
  const who = lines('WHO');
  const listen = new Map();
  for (const line of lines('LISTEN')) {
    const c = line.split(/\s+/);
    // ss: Netid State Recv Send Local Peer Process | netstat: Proto Recv Send Local Foreign [State] PID/Program
    const proto = /^(tcp|udp)/.test(c[0]) ? c[0].replace(/6$/, '') : null;
    const local = /^(tcp|udp)/.test(c[0]) && /^(LISTEN|UNCONN)$/.test(c[1]) ? c[4] : c[3];
    const m = String(local || '').match(/^(.*):(\d+)$/);
    if (!proto || !m) continue;
    const addr = m[1].replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    if (isLoopback(addr)) continue;
    const port = Number(m[2]);
    const proc = (line.match(/users:\(\("([^"]+)"/) || line.match(/\d+\/(\S+)\s*$/) || [])[1] || null;
    const key = `${proto}/${port}`;
    const scope = addr === '*' || addr === '0.0.0.0' || addr === '::' || !isPrivate(addr) ? 'public' : 'lan';
    const prev = listen.get(key);
    if (!prev || (prev.scope === 'lan' && scope === 'public')) listen.set(key, { proto, port, addr, proc: proc || prev?.proc || null, scope, risk: proto === 'tcp' ? RISKY_PORTS[port] || null : null });
  }
  const sshd = {};
  for (const line of lines('SSHD')) {
    const [k, ...v] = line.split(/\s+/);
    sshd[k.toLowerCase()] = v.join(' ').toLowerCase();
  }
  const f2bLines = lines('F2B');
  const f2bNum = (re) => Number((f2bLines.find((l) => re.test(l)) || '').split(/:\s*/).pop()) || 0;
  const fails = { source: null, total: 0, byIp: [], byUser: [] };
  const perIp = new Map();
  const perUser = new Map();
  for (const line of lines('FAILS')) {
    if (line.startsWith('SRC ')) {
      fails.source = line.slice(4);
      continue;
    }
    const m = line.match(/^(\d+)\s+([FI])\s+(\S+)\s+(\S+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    const ip = perIp.get(m[4]) || { F: 0, I: 0 };
    ip[m[2]] += n;
    perIp.set(m[4], ip);
    perUser.set(m[3], (perUser.get(m[3]) || 0) + n);
  }
  // A bad user name logs both "Invalid user" and "Failed password": count the larger one.
  for (const [ip, c] of perIp) fails.byIp.push({ ip, n: Math.max(c.F, c.I) });
  fails.byIp.sort((a, b) => b.n - a.n);
  fails.total = fails.byIp.reduce((a, x) => a + x.n, 0);
  fails.byUser = [...perUser].map(([user, n]) => ({ user, n })).sort((a, b) => b.n - a.n).slice(0, 8);
  fails.byIp = fails.byIp.slice(0, 10);
  const logins = [];
  for (const line of lines('OK')) {
    const m = line.match(/Accepted (\S+) for (\S+) from (\S+)/);
    if (!m) continue;
    const iso = line.match(/^(\d{4}-\d\d-\d\dT[\d:]+(?:[+-]\d{2}:?\d{2}|Z)?)/);
    const t = iso ? Date.parse(iso[1].replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : Date.parse(`${line.slice(0, 15)} ${new Date().getFullYear()}`);
    logins.push({ t: Number.isFinite(t) ? t : null, method: m[1], user: m[2], ip: m[3] });
  }
  logins.reverse();
  const upd = lines('UPD');
  const reboot = lines('REBOOT');
  const empty = lines('EMPTY');
  return {
    os: lines('OS')[0] || '',
    user: who[0] || '',
    root: who[1] === '0',
    sudo: who.includes('SUDO'),
    listen: [...listen.values()].sort((a, b) => (b.risk ? 1 : 0) - (a.risk ? 1 : 0) || a.port - b.port),
    ufw: lines('UFW')[0] === 'NO_UFW' ? null : { active: /Status:\s*active/i.test(lines('UFW').join('\n')), rules: lines('UFW').filter((l) => /ALLOW|DENY|REJECT|LIMIT/.test(l)).length },
    nftDrops: lines('NFT').length ? Number(lines('NFT')[0]) || 0 : null,
    iptablesPolicy: (lines('IPT')[0] || '').match(/^-P INPUT (\w+)/)?.[1] || null,
    sshd: Object.keys(sshd).length ? sshd : null,
    sshdInclude: lines('SSHDINC').includes('INCLUDE'),
    pultDropin: lines('SSHDINC').includes('PULT_DROPIN'),
    f2b: f2bLines[0] === 'NO_F2B' ? { installed: false } : { installed: true, active: f2bLines[1] === 'active', banned: f2bNum(/Currently banned/), totalBanned: f2bNum(/Total banned/) },
    fails,
    logins,
    updates: upd[0] === 'NO_APT' || !upd.length ? null : { total: Number(upd[0]) || 0, security: Number(upd[1]) || 0 },
    auto: lines('AUTO').length ? { enabled: lines('AUTO')[0] === 'enabled' || lines('AUTO').some((l) => /Unattended-Upgrade\s+"1"/.test(l)) } : { enabled: false },
    reboot: { required: reboot[0] === 'YES', pkgs: reboot.slice(1) },
    uid0: lines('UID0'),
    emptyPw: empty.includes('DONE') ? empty.filter((l) => l !== 'DONE') : null,
  };
}

async function security(conn) {
  const r = await conn.exec(SECURITY_SCRIPT, 60000);
  const res = parseSecurity(r.stdout);
  res.auth = conn.server?.auth || null; // how Pult itself logs in (password / key / agent)
  return res;
}

const DROPIN = '/etc/ssh/sshd_config.d/01-pult.conf';
const SSHD_RELOAD = '$S systemctl reload ssh 2>/dev/null || $S systemctl reload sshd 2>/dev/null || $S kill -HUP "$(cat /var/run/sshd.pid 2>/dev/null)"';

/** Set sshd options in Pult's own drop-in (first match wins, so it is named 01-…), check, reload. */
function sshdSetScript(settings) {
  const keys = Object.keys(settings);
  const drop = keys.map((k) => `| grep -viE '^[[:space:]]*${k}[[:space:]]'`).join(' ');
  const add = keys.map((k) => `echo '${k} ${settings[k]}'`).join('; ');
  return (
    SUDO +
    NEED_ROOT +
    "grep -qiE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/' /etc/ssh/sshd_config || { echo NO_INCLUDE; exit 4; }; " +
    'T=$(mktemp) && B=$(mktemp) || exit 5; ' +
    `if $S test -f ${DROPIN}; then $S cat ${DROPIN} > "$B"; HAD=1; else HAD=0; fi; ` +
    `{ cat "$B" ${drop}; ${add}; } > "$T"; ` +
    `$S mkdir -p /etc/ssh/sshd_config.d && $S install -m 644 "$T" ${DROPIN} || exit 5; ` +
    `if ! E=$($S sshd -t 2>&1); then if [ "$HAD" = 1 ]; then $S install -m 644 "$B" ${DROPIN}; else $S rm -f ${DROPIN}; fi; rm -f "$T" "$B"; echo "BAD_CONFIG $E"; exit 6; fi; ` +
    `rm -f "$T" "$B"; ${SSHD_RELOAD}; echo APPLIED`
  );
}

async function securityFix(conn, fix) {
  const keysOnly = ['ssh-password-off', 'ssh-root-keys'].includes(fix);
  if (keysOnly && conn.server?.auth === 'password') {
    throw fail('Pult bu serverga parol bilan ulangan. Avval SSH kalit bilan ulanishni sozlang, aks holda serverga kira olmay qolishingiz mumkin.');
  }
  let script;
  if (fix === 'ssh-password-off') script = sshdSetScript({ PasswordAuthentication: 'no', ChallengeResponseAuthentication: 'no' });
  else if (fix === 'ssh-root-keys') script = sshdSetScript({ PermitRootLogin: 'prohibit-password' });
  else if (fix === 'ssh-undo') script = `${SUDO}${NEED_ROOT}$S rm -f ${DROPIN} && $S sshd -t && { ${SSHD_RELOAD}; echo APPLIED; }`;
  else throw fail('Noma’lum tuzatish');
  const r = await conn.exec(script, 40000);
  if (/NO_ROOT/.test(r.stdout)) throw fail('Bu amal uchun root yoki parolsiz sudo kerak');
  if (/NO_INCLUDE/.test(r.stdout)) throw fail('Bu serverning sshd_config fayli sshd_config.d papkasini o‘qimaydi — sozlamani qo‘lda o‘zgartirish kerak');
  if (/BAD_CONFIG/.test(r.stdout)) throw fail(`SSH sozlamasi tekshiruvdan o‘tmadi, hech narsa o‘zgarmadi: ${r.stdout.replace(/.*BAD_CONFIG\s*/s, '').trim()}`);
  if (!/APPLIED/.test(r.stdout)) throw fail(said(r));
}

/* ---------------- package updates (apt) ---------------- */

const PKG_RE = /^[a-z0-9][a-z0-9+.-]*(:[a-z0-9]+)?$/;

function parseUpgradable(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([^/\s]+)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from:\s*([^\]]+)\]/);
    if (!m) continue;
    out.push({ name: m[1], suites: m[2], to: m[3], arch: m[4], from: m[5].trim(), security: /-security\b/.test(m[2]) });
  }
  return out.sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name));
}

async function updates(conn) {
  const r = await conn.exec(
    [
      SUDO,
      'echo @@OS; (. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-$(uname -sr)}")',
      'if ! command -v apt-get >/dev/null 2>&1; then echo @@NOAPT; exit 0; fi',
      'echo @@STAMP; stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || stat -c %Y /var/lib/apt/lists 2>/dev/null',
      'echo @@LIST; apt list --upgradable 2>/dev/null',
      'echo @@REBOOT; if [ -f /var/run/reboot-required ]; then echo YES; head -n 20 /var/run/reboot-required.pkgs 2>/dev/null; fi',
      'echo @@JOB; L=$(cat "$HOME/.pult/jobs/current" 2>/dev/null); if [ -n "$L" ] && [ -f "$L" ]; then echo "$L"; grep -m1 "^PULT_EXIT=" "$L"; fi',
      'echo @@ROOT; [ "$(id -u)" = 0 ] && echo ROOT; [ -n "$S" ] && echo SUDO',
      'echo @@END',
    ].join('\n'),
    60000,
  );
  const sec = sections(r.stdout);
  const os = (sec.OS || [])[0] || '';
  if ('NOAPT' in sec) return { apt: false, os };
  const job = (sec.JOB || []).filter(Boolean);
  return {
    apt: true,
    os,
    checkedAt: Number((sec.STAMP || [])[0]) * 1000 || null,
    items: parseUpgradable(sec.LIST || []),
    reboot: { required: (sec.REBOOT || [])[0] === 'YES', pkgs: (sec.REBOOT || []).slice(1).filter(Boolean) },
    job: job[0] ? { log: job[0], done: job.some((l) => l.startsWith('PULT_EXIT=')), code: Number((job.find((l) => l.startsWith('PULT_EXIT=')) || '').split('=')[1]) } : null,
    canRoot: (sec.ROOT || []).some((l) => l === 'ROOT' || l === 'SUDO'),
  };
}

const APT = 'export DEBIAN_FRONTEND=noninteractive; apt-get -o DPkg::Lock::Timeout=180 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -y';

function jobScript(kind, pkgs) {
  switch (kind) {
    case 'apt-update':
      return 'export DEBIAN_FRONTEND=noninteractive; apt-get -o DPkg::Lock::Timeout=180 update';
    case 'apt-upgrade':
      return `${APT} upgrade`;
    case 'apt-install': {
      const list = (pkgs || []).filter((p) => PKG_RE.test(p));
      if (!list.length || list.length !== (pkgs || []).length) throw fail('Paket nomi noto‘g‘ri');
      return `${APT} install --only-upgrade ${list.join(' ')}`;
    }
    case 'fail2ban':
      return `${APT} install fail2ban && systemctl enable --now fail2ban && sleep 2 && fail2ban-client status`;
    case 'auto-updates':
      return (
        `${APT} install unattended-upgrades && ` +
        `printf 'APT::Periodic::Update-Package-Lists "1";\\nAPT::Periodic::Unattended-Upgrade "1";\\n' > /etc/apt/apt.conf.d/20auto-upgrades && ` +
        'systemctl enable --now unattended-upgrades && echo "Avtomatik xavfsizlik yangilanishlari yoqildi."'
      );
    default:
      throw fail('Noma’lum amal');
  }
}

/**
 * Start a long job (apt) on the server, detached from SSH: it keeps running
 * if the link drops or Pult closes, and writes to ~/.pult/jobs/<id>.log with
 * a final "PULT_EXIT=<code>" line. The window follows the log.
 */
async function jobStart(conn, kind, pkgs = []) {
  const inner = jobScript(kind, pkgs);
  const id = `${kind}-${Date.now().toString(36)}`;
  const r = await conn.exec(
    SUDO +
      NEED_ROOT +
      `D="$HOME/.pult/jobs"; mkdir -p "$D"; L="$D/${id}.log"; : > "$L"; echo "$L" > "$D/current"; ` +
      `find "$D" -name '*.log' -mtime +14 -delete 2>/dev/null; ` +
      'SS=$(command -v setsid >/dev/null 2>&1 && echo setsid); ' +
      `$S nohup $SS sh -c ${shq(`${inner}; echo "PULT_EXIT=$?"`)} >> "$L" 2>&1 < /dev/null & ` +
      'echo "LOG $L"',
    20000,
  );
  if (/NO_ROOT/.test(r.stdout)) throw fail('Bu amal uchun root yoki parolsiz sudo kerak');
  const log = r.stdout.match(/^LOG (.+)$/m)?.[1];
  if (!log) throw fail(said(r));
  return { id, kind, log };
}

/** Reboot the server (the link drops; Pult reconnects when it is back). */
async function reboot(conn) {
  const r = await conn.exec(`${SUDO}${NEED_ROOT}( sleep 1; $S systemctl reboot || $S shutdown -r now ) >/dev/null 2>&1 & echo OK`, 15000);
  if (/NO_ROOT/.test(r.stdout)) throw fail('Qayta yuklash uchun root yoki parolsiz sudo kerak');
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
    case 'job':
      // A job's own log (see jobStart): from the first line, until it ends.
      if (!/^\/[^\0\n\r]*\/\.pult\/jobs\/[\w.-]+\.log$/.test(String(source.path))) throw fail('Yo‘l noto‘g‘ri');
      return `exec tail -n +1 -F -- ${shq(source.path)}`;
    case 'file':
      if (!ABS_PATH_RE.test(String(source.path))) throw fail('Yo‘l noto‘g‘ri');
      return `${SUDO}if [ -r ${shq(source.path)} ]; then S=""; fi; exec $S tail -n ${n} -F -- ${shq(source.path)}`;
    default:
      throw fail('Noma’lum log manbasi');
  }
}

module.exports = {
  security,
  securityFix,
  parseSecurity,
  updates,
  parseUpgradable,
  jobStart,
  reboot,
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
