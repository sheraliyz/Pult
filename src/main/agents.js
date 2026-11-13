'use strict';

// AI coding agents on the server: Claude Code (`claude`) and the Antigravity
// CLI (`agy`). Finds them, tells which Pult terminal runs which agent, and
// keeps the plan's usage limits at hand:
//
//  * Claude Code hands its status line command a JSON with `rate_limits`
//    (5-hour and weekly windows). With the user's consent Pult points the
//    status line at a tiny script (~/.pult/bin/claude-statusline) that saves a
//    copy to ~/.pult/state and then runs the user's own status line, if any.
//  * agy reports its quota through `agy -p /usage --output-format json`.
//
// Everything rides on the existing SSH link: the monitor channel polls panes
// and state files (no extra channel), SFTP edits files.

const EventEmitter = require('events');
const posix = require('path').posix;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const call = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

const MIN = 60 * 1000;
const SESSION_RE = /^pult-\d{4}$/;

const BRIDGE_VERSION = 1;
const BRIDGE_COMMAND = 'sh ~/.pult/bin/claude-statusline';
const REL = {
  script: '.pult/bin/claude-statusline',
  next: '.pult/claude-statusline.next',
  meta: '.pult/claude-bridge.json',
  state: '.pult/state',
  uploads: '.pult/uploads',
  settings: '.claude/settings.json',
  backup: '.claude/settings.json.pult-backup',
};

// Installers put the binaries here; `sh -c` over SSH does not read the
// profile files that add them to PATH.
const DETECT_SCRIPT = [
  'P="$HOME/.local/bin:$HOME/bin:$HOME/.claude/local:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.volta/bin:/usr/local/bin:/opt/homebrew/bin"',
  'for x in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$x" ] && P="$P:$x"; done',
  'export PATH="$P:$PATH"',
  'echo "C $(command -v claude 2>/dev/null)"',
  'echo "A $(command -v agy 2>/dev/null)"',
  `if grep -q 'pult/bin/claude-statusline' "$HOME/${REL.settings}" 2>/dev/null; then echo "B 1"; else echo "B 0"; fi`,
  `sed -n 's/^# pult-bridge v\\([0-9][0-9]*\\).*/V \\1/p' "$HOME/${REL.script}" 2>/dev/null`,
  // Old per-terminal snapshots and pasted images are not kept forever.
  `find "$HOME/${REL.state}" -name 'claude.*.json' -mtime +14 -exec rm -f {} + 2>/dev/null`,
  'true',
].join('; ');

// Runs on the server as Claude Code's status line. POSIX sh only (no jq).
const BRIDGE_SCRIPT = `#!/bin/sh
# pult-bridge v${BRIDGE_VERSION}
# Pult: Claude Code status line (https://github.com/sheraliyz/pult)
# Claude Code passes session JSON on stdin. A copy goes to ~/.pult/state so
# Pult can show the plan's usage limits (5-hour and weekly windows). Then your
# own status line runs (if you had one), or a short default line is printed.
# To undo: Pult -> status bar -> Claude -> "Uzish" (restores your settings).
in=$(cat | tr -d '\\r\\n')
d="$HOME/.pult/state"
k=claude
if [ -n "$TMUX" ]; then
  s=$(tmux display-message -p \${TMUX_PANE:+-t "$TMUX_PANE"} '#{session_name}' 2>/dev/null | tr -c '\\nA-Za-z0-9_.-' '_')
  [ -n "$s" ] && k="claude.$s"
fi
if mkdir -p "$d" 2>/dev/null; then
  printf '{"t":%s,"d":%s}\\n' "$(date +%s)" "\${in:-null}" > "$d/$k.json.$$" 2>/dev/null &&
    mv -f "$d/$k.json.$$" "$d/$k.json" 2>/dev/null
fi
n="$HOME/.pult/claude-statusline.next"
if [ -s "$n" ]; then
  printf '%s\\n' "$in" | sh -c "$(cat "$n")"
  exit
fi
num() { printf '%s' "$in" | sed -n "s/.*\\"$1\\"[[:space:]]*:[[:space:]]*{[^}]*\\"$2\\"[[:space:]]*:[[:space:]]*\\\\([0-9][0-9.]*\\\\).*/\\\\1/p"; }
hm() { date -d "@$1" +%H:%M 2>/dev/null || date -r "$1" +%H:%M 2>/dev/null; }
o=$(printf '%s' "$in" | sed -n 's/.*"model"[[:space:]]*:[[:space:]]*{[^}]*"display_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
c=$(printf '%s' "$in" | sed -n 's/.*"remaining_percentage"[[:space:]]*:[[:space:]]*\\([0-9][0-9.]*\\).*/\\1/p')
[ -n "$c" ] && o="\${o:+$o · }kontekst $((100 - \${c%%.*}))%"
f=$(num five_hour used_percentage)
r=$(num five_hour resets_at)
[ -n "$r" ] && r=$(hm "\${r%%.*}")
[ -n "$f" ] && o="\${o:+$o · }5 soat \${f%%.*}%\${r:+ ($r gacha)}"
w=$(num seven_day used_percentage)
[ -n "$w" ] && o="\${o:+$o · }hafta \${w%%.*}%"
printf '%s\\n' "$o"
`;

/* ---------------- parsing ---------------- */

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isBridge = (cmd) => typeof cmd === 'string' && cmd.includes('pult/bin/claude-statusline');

/** Which agent a tmux pane is running, from its foreground command and title. */
function agentOf({ command = '', title = '' }) {
  const cmd = command.toLowerCase();
  if (cmd === 'claude' || cmd.startsWith('claude-') || /^\d+\.\d+\.\d+$/.test(cmd)) return 'claude';
  if (cmd === 'agy' || cmd.startsWith('antigravity')) return 'agy';
  // Installs that run under node/bun keep the interpreter's name.
  if (/^(node|bun)$/.test(cmd)) {
    if (/claude code/i.test(title) || /^[\u2733\u273b\u273d\u2736\u2722\u00b7\u25d0\u25d1\u2800-\u28ff] /.test(title)) return 'claude';
    if (/antigravity|\bagy\b/i.test(title)) return 'agy';
  }
  return null;
}

/** A Claude Code status line snapshot written by the bridge script. */
function parseClaudeSnapshot(text, file) {
  let o;
  try {
    o = JSON.parse(String(text || '').trim());
  } catch {
    return null;
  }
  if (!isObj(o)) return null;
  const d = isObj(o.d) ? o.d : o;
  const win = (w) => (isObj(w) && num(w.used_percentage) != null ? { pct: num(w.used_percentage), resetsAt: num(w.resets_at) ? num(w.resets_at) * 1000 : null } : null);
  const rl = isObj(d.rate_limits) ? d.rate_limits : {};
  const five = win(rl.five_hour);
  const week = win(rl.seven_day);
  let spend = win(rl.spend_limit);
  if (spend) {
    spend = {
      ...spend,
      usedUsd: num(rl.spend_limit.used_usd),
      limitUsd: num(rl.spend_limit.limit_usd),
      period: typeof rl.spend_limit.period === 'string' ? rl.spend_limit.period : null,
    };
  }
  const base = posix.basename(file || '');
  const session = base.match(/^claude\.(.+)\.json$/)?.[1] || null;
  return {
    t: num(o.t) ? num(o.t) * 1000 : 0,
    session,
    model: (isObj(d.model) && (d.model.display_name || d.model.id)) || null,
    ctx: isObj(d.context_window) ? num(d.context_window.used_percentage) : null,
    cost: isObj(d.cost) ? num(d.cost.total_cost_usd) : null,
    cwd: (isObj(d.workspace) && d.workspace.current_dir) || d.cwd || null,
    name: typeof d.session_name === 'string' ? d.session_name : null,
    version: typeof d.version === 'string' ? d.version : null,
    limits: five || week || spend ? { five, week, spend } : null,
  };
}

const windowOf = (s) => {
  const v = String(s || '').toLowerCase();
  if (/5\s*h|five|hour/.test(v)) return '5h';
  if (/week|7\s*d|seven/.test(v)) return 'week';
  if (/day|24\s*h/.test(v)) return 'day';
  return v || '?';
};

/** `agy -p /usage --output-format json` → [{ name, buckets: [{ window, used, resetAt }] }]. */
function parseAgyUsage(stdout) {
  const text = String(stdout || '').trim();
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    // Some builds print log lines first: take the last line that is JSON.
    for (const line of text.split('\n').reverse()) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      try {
        obj = JSON.parse(l);
        break;
      } catch {
        // keep looking
      }
    }
  }
  const groups = obj?.command?.data?.groups ?? obj?.data?.groups ?? obj?.groups;
  if (!Array.isArray(groups)) return null;
  const out = [];
  for (const g of groups) {
    if (!isObj(g)) continue;
    const buckets = [];
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      if (!isObj(b)) continue;
      let remaining = num(b.remaining_fraction);
      if (remaining == null && num(b.remaining_pct) != null) remaining = num(b.remaining_pct) / 100;
      if (remaining == null) continue;
      const used = Math.max(0, Math.min(1, 1 - remaining));
      let resetAt = typeof b.reset_time === 'string' ? Date.parse(b.reset_time) : NaN;
      if (!Number.isFinite(resetAt) && num(b.reset_in_seconds) != null) resetAt = Date.now() + num(b.reset_in_seconds) * 1000;
      // An untouched window has a rolling reset time that means nothing.
      buckets.push({ window: windowOf(b.window || b.id || b.name), used, resetAt: Number.isFinite(resetAt) && used > 0 ? resetAt : null });
    }
    if (buckets.length) out.push({ name: String(g.name || g.display_name || g.id || 'agy'), buckets });
  }
  return out.length ? out : null;
}

function agyFailure(r) {
  const all = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (/auth|sign.?in|log.?in|credential|unauthori[sz]ed/i.test(all)) return { code: 'AUTH', message: 'agy’ga kirilmagan — terminalda `agy` ni bir marta ishga tushirib, hisobingizga kiring' };
  if (r.code === 127) return { code: 'NO_TOOL', message: 'agy topilmadi' };
  const line = all.split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0];
  return { code: 'FAILED', message: line ? line.slice(0, 200) : `agy /usage ishlamadi (kod ${r.code})` };
}

/* ---------------- SFTP helpers ---------------- */

const NO_SUCH_FILE = 2;

async function readText(sftp, p) {
  try {
    return (await call((cb) => sftp.readFile(p, cb))).toString('utf8');
  } catch (err) {
    if (err.code === NO_SUCH_FILE || /no such file/i.test(err.message)) return null;
    throw err;
  }
}

const statOf = (sftp, p) => call((cb) => sftp.stat(p, cb)).catch(() => null);

async function mkdirp(sftp, dir) {
  if (await statOf(sftp, dir)) return;
  await mkdirp(sftp, posix.dirname(dir));
  await call((cb) => sftp.mkdir(dir, cb)).catch(async (err) => {
    if (!(await statOf(sftp, dir))) throw err;
  });
}

async function writeFile(sftp, p, data, mode = 0o644) {
  await call((cb) => sftp.writeFile(p, data, { mode }, cb));
  await call((cb) => sftp.chmod(p, mode, cb)).catch(() => {});
}

// Write a sibling, then swap it in, so a reader never sees half a file.
async function writeAtomic(sftp, p, data, mode) {
  const tmp = `${p}.pult-tmp`;
  await writeFile(sftp, tmp, data, mode);
  try {
    await call((cb) => sftp.ext_openssh_rename(tmp, p, cb));
    return;
  } catch {
    // Server without posix-rename: plain SFTP rename refuses to overwrite.
  }
  await call((cb) => sftp.unlink(p, cb)).catch(() => {});
  await call((cb) => sftp.rename(tmp, p, cb));
}

function parseSettings(text) {
  if (text == null || !text.trim()) return {};
  let v;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw Object.assign(new Error(`~/.claude/settings.json o‘qib bo‘lmadi (JSON xato: ${err.message}). Fayl o‘zgartirilmadi.`), { code: 'BAD_SETTINGS' });
  }
  if (!isObj(v)) throw Object.assign(new Error('~/.claude/settings.json kutilgan ko‘rinishda emas. Fayl o‘zgartirilmadi.'), { code: 'BAD_SETTINGS' });
  return v;
}

/* ---------------- watcher ---------------- */

class AgentWatch extends EventEmitter {
  /** usage: false = the limits are hidden, so agy is not asked on a timer. */
  constructor(conn, { usage = true } = {}) {
    super();
    this.conn = conn;
    this.usage = usage;
    this.claude = { path: null, bridged: false, version: 0, files: new Map() };
    this.agy = { path: null, usage: null, at: 0, error: null, busy: false, noLogFlag: false, timer: null };
    this.panes = {};
    this.detected = false;
    this.scanning = false;
    this.emitTimer = null;

    conn.agentPolling = true;
    this.onState = (s) => {
      if (s.state === 'ready') this.detect();
      else clearTimeout(this.agy.timer);
    };
    this.onScan = (scan) => this.scan(scan);
    conn.on('state', this.onState);
    conn.on('agents:scan', this.onScan);
  }

  dispose() {
    clearTimeout(this.agy.timer);
    clearTimeout(this.emitTimer);
    this.conn.off('state', this.onState);
    this.conn.off('agents:scan', this.onScan);
    this.conn.agentPolling = false;
  }

  /** Settings → "Limitlarni ko‘rsatish" changed. */
  setUsage(on) {
    this.usage = !!on;
    if (!this.usage) clearTimeout(this.agy.timer);
    else if (this.agy.path && Date.now() - this.agy.at > 3 * MIN) this.refreshAgy();
    else this.scheduleAgy();
  }

  changed() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('update', this.publicState());
    }, 60);
  }

  publicState() {
    const sessions = {};
    for (const f of this.claude.files.values()) if (f.session) sessions[f.session] = f;
    let usage = null;
    for (const f of this.claude.files.values()) if (f.limits && (!usage || f.t > usage.t)) usage = { t: f.t, ...f.limits };
    return {
      detected: this.detected,
      claude: {
        path: this.claude.path,
        bridged: this.claude.bridged,
        current: this.claude.bridged && this.claude.version === BRIDGE_VERSION,
        seen: this.claude.files.size > 0,
        usage,
        sessions,
      },
      agy: {
        path: this.agy.path,
        usage: this.agy.usage,
        at: this.agy.at,
        error: this.agy.error,
        busy: this.agy.busy,
      },
      panes: this.panes,
    };
  }

  async home() {
    if (this.conn.home) return this.conn.home;
    const sftp = await this.conn.sftp();
    return call((cb) => sftp.realpath('.', cb));
  }

  /* ---------------- detection ---------------- */

  async detect() {
    let r;
    try {
      r = await this.conn.exec(DETECT_SCRIPT, 15000);
    } catch {
      return;
    }
    const val = (k) => r.stdout.split('\n').find((l) => l.startsWith(`${k} `))?.slice(2).trim() || null;
    this.claude.path = val('C');
    this.agy.path = val('A');
    this.claude.bridged = val('B') === '1';
    this.claude.version = Number(val('V')) || 0;
    this.detected = true;
    this.changed();
    // Our own script is ours to keep current; the user's settings are not touched.
    if (this.claude.bridged && this.claude.version && this.claude.version !== BRIDGE_VERSION) {
      this.updateBridgeScript().catch(() => {});
    }
    if (this.usage && this.agy.path && Date.now() - this.agy.at > 3 * MIN) this.refreshAgy();
    else this.scheduleAgy();
  }

  /* ---------------- polling (from the monitor channel) ---------------- */

  async scan({ panes, files }) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      let dirty = false;
      const next = {};
      for (const p of panes) {
        if (!SESSION_RE.test(p.session)) continue;
        next[p.session] = { agent: agentOf(p), command: p.command, cwd: p.cwd, title: p.title };
      }
      const before = this.panes;
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        const hadAgy = Object.values(before).some((p) => p.agent === 'agy');
        const hasAgy = Object.values(next).some((p) => p.agent === 'agy');
        this.panes = next;
        dirty = true;
        // An agy session just ended: its quota moved.
        if (hadAgy && !hasAgy && this.agy.path && this.usage) setTimeout(() => this.refreshAgy(), 4000);
        // agy is running somewhere we did not find it: look again.
        if (hasAgy && !this.agy.path && this.detected) this.detect();
      }

      const seen = new Set();
      for (const f of files) {
        const name = posix.basename(f.path);
        if (!/^claude[.\w-]*\.json$/.test(name)) continue;
        seen.add(name);
        const known = this.claude.files.get(name);
        if (known && known.sum === f.sum) continue;
        const text = await this.conn.monitorFetch(f.path);
        if (text == null) continue;
        const snap = parseClaudeSnapshot(text, name);
        if (!snap) continue;
        this.claude.files.set(name, { ...snap, sum: f.sum });
        dirty = true;
      }
      for (const name of [...this.claude.files.keys()]) {
        if (!seen.has(name)) {
          this.claude.files.delete(name);
          dirty = true;
        }
      }
      if (dirty) this.changed();
    } finally {
      this.scanning = false;
    }
  }

  /* ---------------- agy ---------------- */

  scheduleAgy() {
    clearTimeout(this.agy.timer);
    if (!this.usage || !this.agy.path || this.conn.state !== 'ready') return;
    const active = Object.values(this.panes).some((p) => p.agent === 'agy');
    const ms = this.agy.error ? 15 * MIN : active ? 3 * MIN : 10 * MIN;
    this.agy.timer = setTimeout(() => this.refreshAgy(), ms);
    this.agy.timer.unref?.();
  }

  /** Ask agy for its quota; a call while one is running waits for that one. */
  refreshAgy() {
    if (this.agyRun) return this.agyRun;
    if (!this.agy.path || this.conn.state !== 'ready') return Promise.resolve(this.publicState().agy);
    this.agyRun = this.runAgyUsage().finally(() => {
      this.agyRun = null;
    });
    return this.agyRun;
  }

  async runAgyUsage() {
    const a = this.agy;
    a.busy = true;
    this.changed();
    try {
      const run = (logFlag) =>
        this.conn.exec(`${shq(a.path)} -p /usage --output-format json${logFlag ? ' --log-file /dev/null' : ''} < /dev/null`, 90000);
      let r = await run(!a.noLogFlag);
      let usage = r.code === 0 ? parseAgyUsage(r.stdout) : null;
      if (!usage && !a.noLogFlag && agyFailure(r).code === 'FAILED') {
        // Older builds may not know --log-file.
        const r2 = await run(false);
        const u2 = r2.code === 0 ? parseAgyUsage(r2.stdout) : null;
        if (u2) a.noLogFlag = true;
        r = r2;
        usage = u2;
      }
      if (usage) {
        a.usage = usage;
        a.error = null;
      } else {
        a.error = r.code === 0 ? { code: 'FORMAT', message: 'agy /usage javobini tushunib bo‘lmadi (agy yangilanganmi?)' } : agyFailure(r);
      }
    } catch (err) {
      a.error = { code: err.code || 'FAILED', message: String(err.message || err) };
    } finally {
      a.busy = false;
      a.at = Date.now();
      this.scheduleAgy();
      this.changed();
    }
    return this.publicState().agy;
  }

  /* ---------------- Claude status line bridge ---------------- */

  async updateBridgeScript() {
    const sftp = await this.conn.sftp();
    const home = await this.home();
    await mkdirp(sftp, posix.join(home, '.pult/bin'));
    await writeFile(sftp, posix.join(home, REL.script), BRIDGE_SCRIPT, 0o755);
    this.claude.version = BRIDGE_VERSION;
    this.changed();
  }

  async installClaude() {
    const sftp = await this.conn.sftp();
    const home = await this.home();
    const P = (rel) => posix.join(home, rel);

    // Read and validate first: a settings file we cannot parse stays as is.
    const settingsPath = P(REL.settings);
    const original = await readText(sftp, settingsPath);
    const settings = parseSettings(original);
    const st = original != null ? await statOf(sftp, settingsPath) : null;
    const mode = st ? st.mode & 0o777 : 0o644;
    let meta = {};
    try {
      meta = JSON.parse((await readText(sftp, P(REL.meta))) || '{}') || {};
    } catch {
      meta = {};
    }

    await mkdirp(sftp, P('.pult/bin'));
    await mkdirp(sftp, P(REL.state));
    await mkdirp(sftp, P('.claude'));
    await writeFile(sftp, P(REL.script), BRIDGE_SCRIPT, 0o755);

    const cur = settings.statusLine;
    if (!isBridge(cur?.command)) {
      // Keep the user's own status line: it keeps running, chained after ours.
      meta.prevStatusLine = isObj(cur) ? cur : null;
      const prevCmd = isObj(cur) && typeof cur.command === 'string' ? cur.command.trim() : '';
      if (prevCmd) await writeFile(sftp, P(REL.next), `${prevCmd}\n`, 0o600);
      else await call((cb) => sftp.unlink(P(REL.next), cb)).catch(() => {});
    }
    settings.statusLine = { ...(isObj(cur) ? cur : {}), type: 'command', command: BRIDGE_COMMAND };
    // A bell when Claude finishes or asks for permission lets Pult notify you.
    if (!('preferredNotifChannel' in settings)) {
      settings.preferredNotifChannel = 'terminal_bell';
      meta.notifChannel = true;
    }
    meta.v = BRIDGE_VERSION;
    meta.installedAt = new Date().toISOString();

    if (original != null && !(await statOf(sftp, P(REL.backup)))) await writeFile(sftp, P(REL.backup), original, mode);
    await writeAtomic(sftp, settingsPath, `${JSON.stringify(settings, null, 2)}\n`, mode);
    await writeFile(sftp, P(REL.meta), `${JSON.stringify(meta, null, 2)}\n`, 0o600);

    this.claude.bridged = true;
    this.claude.version = BRIDGE_VERSION;
    this.changed();
    return this.publicState().claude;
  }

  async removeClaude() {
    const sftp = await this.conn.sftp();
    const home = await this.home();
    const P = (rel) => posix.join(home, rel);
    const settingsPath = P(REL.settings);
    const original = await readText(sftp, settingsPath);
    const settings = parseSettings(original);
    let meta = {};
    try {
      meta = JSON.parse((await readText(sftp, P(REL.meta))) || '{}') || {};
    } catch {
      meta = {};
    }
    let touched = false;
    if (isBridge(settings.statusLine?.command)) {
      if (isObj(meta.prevStatusLine)) settings.statusLine = meta.prevStatusLine;
      else delete settings.statusLine;
      touched = true;
    }
    if (meta.notifChannel && settings.preferredNotifChannel === 'terminal_bell') {
      delete settings.preferredNotifChannel;
      touched = true;
    }
    if (touched && original != null) {
      const st = await statOf(sftp, settingsPath);
      await writeAtomic(sftp, settingsPath, `${JSON.stringify(settings, null, 2)}\n`, st ? st.mode & 0o777 : 0o644);
    }
    for (const rel of [REL.script, REL.next, REL.meta]) await call((cb) => sftp.unlink(P(rel), cb)).catch(() => {});
    const list = await call((cb) => sftp.readdir(P(REL.state), cb)).catch(() => []);
    for (const e of list) if (/^claude.*\.json/.test(e.filename)) await call((cb) => sftp.unlink(P(`${REL.state}/${e.filename}`), cb)).catch(() => {});
    this.claude.files.clear();
    this.claude.bridged = false;
    this.claude.version = 0;
    this.changed();
    return this.publicState().claude;
  }

  /* ---------------- files handed to agents ---------------- */

  /** A fresh folder under ~/.pult/uploads for files dropped or pasted into a terminal. */
  async uploadDir() {
    const sftp = await this.conn.sftp();
    const home = await this.home();
    const dir = posix.join(home, REL.uploads, stamp());
    await mkdirp(sftp, dir);
    this.prune();
    return dir;
  }

  /** Save bytes (a pasted screenshot) next to other uploads; returns the remote path. */
  async saveUpload(name, data) {
    const sftp = await this.conn.sftp();
    const home = await this.home();
    const dir = posix.join(home, REL.uploads);
    await mkdirp(sftp, dir);
    const target = posix.join(dir, name);
    await call((cb) => sftp.writeFile(target, data, cb));
    this.prune();
    return target;
  }

  prune() {
    if (this.pruned) return;
    this.pruned = true;
    this.conn.exec(`find "$HOME/${REL.uploads}" -mindepth 1 -mtime +7 -delete 2>/dev/null; true`, 30000).catch(() => {});
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = { AgentWatch, agentOf, parseClaudeSnapshot, parseAgyUsage, parseSettings, stamp, BRIDGE_SCRIPT, BRIDGE_VERSION, BRIDGE_COMMAND };
