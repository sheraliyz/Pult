'use strict';

// Checks src/main/agents.js against dev/mock-server.js (fake claude / agy):
//   MOCK_ROOT=<dir> node dev/agents-test.js
// Covers detection, the Claude status line bridge (install keeps the user's
// own status line and settings, removal restores them byte for byte), usage
// snapshots read through the monitor channel, and agy's /usage JSON.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Connection } = require('../src/main/connection');
const { AgentWatch, agentOf, parseClaudeSnapshot, parseAgyUsage, BRIDGE_COMMAND } = require('../src/main/agents');

const ROOT = process.env.MOCK_ROOT;
const HOME = '/home/demo';
const local = (p) => path.join(ROOT, ...p.split('/').filter(Boolean));
const store = { getHostKey: () => null, setHostKey() {}, inOpenSshKnownHosts: () => true, setSecret() {} };
const server = { id: 't', name: 't', host: '127.0.0.1', port: Number(process.env.MOCK_PORT || 2222), username: 'demo', auth: 'password', password: 'demo', persist: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.stack || err.message}`);
  }
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(100);
  }
}

(async () => {
  /* ---------------- pure parsing ---------------- */

  await step('agentOf: command names and titles', () => {
    assert.strictEqual(agentOf({ command: 'claude', title: 'x' }), 'claude');
    assert.strictEqual(agentOf({ command: '2.1.300', title: '✳ Fix it' }), 'claude');
    assert.strictEqual(agentOf({ command: 'node', title: '✳ Claude Code' }), 'claude');
    assert.strictEqual(agentOf({ command: 'agy', title: '' }), 'agy');
    assert.strictEqual(agentOf({ command: 'bash', title: '✳ Claude Code' }), null);
    assert.strictEqual(agentOf({ command: 'node', title: 'server.js' }), null);
  });

  await step('parseClaudeSnapshot: full and partial data', () => {
    const s = parseClaudeSnapshot(
      JSON.stringify({ t: 100, d: { model: { display_name: 'Opus' }, context_window: { used_percentage: 23 }, rate_limits: { five_hour: { used_percentage: 41.5, resets_at: 200 } } } }),
      'claude.pult-0002.json',
    );
    assert.strictEqual(s.session, 'pult-0002');
    assert.strictEqual(s.t, 100000);
    assert.deepStrictEqual(s.limits.five, { pct: 41.5, resetsAt: 200000 });
    assert.strictEqual(s.limits.week, null);
    assert.strictEqual(s.ctx, 23);
    const bare = parseClaudeSnapshot(JSON.stringify({ t: 1, d: { model: { id: 'x' }, context_window: { used_percentage: null } } }), 'claude.json');
    assert.strictEqual(bare.limits, null);
    assert.strictEqual(bare.ctx, null);
    assert.strictEqual(bare.session, null);
    assert.strictEqual(parseClaudeSnapshot('{"t":1,"d":', 'claude.json'), null);
  });

  await step('parseAgyUsage: groups, logs before JSON, untouched windows', () => {
    const json = JSON.stringify({ command: { data: { groups: [{ name: 'G', buckets: [{ window: '5h', remaining_fraction: 0.25, reset_time: '2030-01-01T00:00:00Z' }, { window: 'weekly', remaining_fraction: 1, reset_time: '2030-01-02T00:00:00Z' }] }] } } });
    const u = parseAgyUsage(`some log line\n${json}\n`);
    assert.strictEqual(u.length, 1);
    assert.strictEqual(u[0].buckets[0].window, '5h');
    assert.strictEqual(u[0].buckets[0].used, 0.75);
    assert.strictEqual(u[0].buckets[0].resetAt, Date.parse('2030-01-01T00:00:00Z'));
    assert.strictEqual(u[0].buckets[1].window, 'week');
    assert.strictEqual(u[0].buckets[1].resetAt, null, 'rolling reset of an unused window is dropped');
    assert.strictEqual(parseAgyUsage('{"status":"ERROR"}'), null);
    assert.strictEqual(parseAgyUsage('not json'), null);
  });

  /* ---------------- against the mock server ---------------- */

  // A user who already has a status line and other settings.
  const settingsFile = local(`${HOME}/.claude/settings.json`);
  const userSettings = `{\n  "model": "opus",\n  "statusLine": { "type": "command", "command": "~/.claude/my-status.sh", "padding": 1 },\n  "permissions": { "allow": ["Bash(ls:*)"] }\n}\n`;
  fs.rmSync(local(`${HOME}/.claude`), { recursive: true, force: true });
  fs.rmSync(local(`${HOME}/.pult`), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, userSettings);

  const conn = new Connection('c1', server, { ask: async () => null, store });
  const agents = new AgentWatch(conn);
  conn.start();
  await conn.whenReady();

  await step('detects claude and agy', async () => {
    await until(() => agents.detected);
    const st = agents.publicState();
    assert.strictEqual(st.claude.path, `${HOME}/.local/bin/claude`);
    assert.strictEqual(st.agy.path, `${HOME}/.local/bin/agy`);
    assert.strictEqual(st.claude.bridged, false);
  });

  await step('agy /usage → two model groups', async () => {
    const a = await agents.refreshAgy();
    assert.strictEqual(a.error, null, JSON.stringify(a.error));
    assert.deepStrictEqual(a.usage.map((g) => g.name), ['Gemini Models', 'Claude and GPT models']);
    const cg = a.usage[1].buckets.find((b) => b.window === '5h');
    assert(Math.abs(cg.used - 0.82) < 1e-9, String(cg.used));
    assert(cg.resetAt > Date.now());
  });

  await step('install bridge keeps the user status line and settings', async () => {
    await agents.installClaude();
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.strictEqual(s.statusLine.command, BRIDGE_COMMAND);
    assert.strictEqual(s.statusLine.padding, 1, 'padding kept');
    assert.strictEqual(s.model, 'opus');
    assert.deepStrictEqual(s.permissions, { allow: ['Bash(ls:*)'] });
    assert.strictEqual(s.preferredNotifChannel, 'terminal_bell');
    assert.strictEqual(fs.readFileSync(local(`${HOME}/.pult/claude-statusline.next`), 'utf8').trim(), '~/.claude/my-status.sh');
    assert.strictEqual(fs.readFileSync(local(`${HOME}/.claude/settings.json.pult-backup`), 'utf8'), userSettings);
    assert(fs.readFileSync(local(`${HOME}/.pult/bin/claude-statusline`), 'utf8').startsWith('#!/bin/sh\n# pult-bridge v'));
    assert(!fs.existsSync(`${settingsFile}.pult-tmp`), 'no temp file left');
    assert.strictEqual(agents.publicState().claude.bridged, true);
  });

  await step('installing twice does not lose the original status line', async () => {
    await agents.installClaude();
    const meta = JSON.parse(fs.readFileSync(local(`${HOME}/.pult/claude-bridge.json`), 'utf8'));
    assert.strictEqual(meta.prevStatusLine.command, '~/.claude/my-status.sh');
    assert.strictEqual(fs.readFileSync(local(`${HOME}/.pult/claude-statusline.next`), 'utf8').trim(), '~/.claude/my-status.sh');
  });

  await step('usage snapshot reaches the watcher through the monitor', async () => {
    const t = Math.floor(Date.now() / 1000);
    const snap = { t, d: { model: { display_name: 'Opus 5.5' }, context_window: { used_percentage: 31 }, rate_limits: { five_hour: { used_percentage: 64, resets_at: t + 3600 }, seven_day: { used_percentage: 20, resets_at: t + 86400 } } } };
    fs.mkdirSync(local(`${HOME}/.pult/state`), { recursive: true });
    fs.writeFileSync(local(`${HOME}/.pult/state/claude.pult-0007.json`), JSON.stringify(snap) + '\n');
    const u = await until(() => agents.publicState().claude.usage);
    assert.strictEqual(u.five.pct, 64);
    assert.strictEqual(u.week.pct, 20);
    assert.strictEqual(agents.publicState().claude.sessions['pult-0007'].ctx, 31);
    // A newer snapshot wins.
    snap.t = t + 5;
    snap.d.rate_limits.five_hour.used_percentage = 70;
    fs.writeFileSync(local(`${HOME}/.pult/state/claude.pult-0007.json`), JSON.stringify(snap) + '\n');
    await until(() => agents.publicState().claude.usage?.five.pct === 70);
  });

  await step('panes: a shell that starts claude is recognised', async () => {
    await conn.openShell('s1', { cols: 80, rows: 24 });
    const sh = conn.shells.get('s1');
    await until(() => Object.keys(agents.panes).length > 0);
    sh.stream.write('claude\r');
    const p = await until(() => Object.values(agents.panes).find((x) => x.agent === 'claude'));
    assert(p.title.includes('Claude'));
    sh.stream.write('/exit\r');
    await until(() => !Object.values(agents.panes).some((x) => x.agent === 'claude'));
  });

  await step('remove restores settings exactly and cleans up', async () => {
    await agents.removeClaude();
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.deepStrictEqual(s, JSON.parse(userSettings));
    assert(!fs.existsSync(local(`${HOME}/.pult/bin/claude-statusline`)));
    assert(!fs.existsSync(local(`${HOME}/.pult/claude-statusline.next`)));
    assert(!fs.existsSync(local(`${HOME}/.pult/state/claude.pult-0007.json`)));
    assert.strictEqual(agents.publicState().claude.bridged, false);
  });

  await step('a user preferredNotifChannel is never overwritten or removed', async () => {
    fs.writeFileSync(settingsFile, '{"preferredNotifChannel":"iterm2"}\n');
    await agents.installClaude();
    assert.strictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).preferredNotifChannel, 'iterm2');
    await agents.removeClaude();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { preferredNotifChannel: 'iterm2' });
  });

  await step('no settings file: install creates it, remove leaves a clean one', async () => {
    fs.rmSync(local(`${HOME}/.claude`), { recursive: true, force: true });
    await agents.installClaude();
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.strictEqual(s.statusLine.command, BRIDGE_COMMAND);
    await agents.removeClaude();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {});
  });

  await step('broken settings.json is left untouched', async () => {
    fs.writeFileSync(settingsFile, '{ "model": "opus", }');
    await assert.rejects(agents.installClaude(), (err) => err.code === 'BAD_SETTINGS');
    assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), '{ "model": "opus", }');
  });

  await step('pasted image lands in ~/.pult/uploads', async () => {
    const p = await agents.saveUpload('paste-test.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.strictEqual(p, `${HOME}/.pult/uploads/paste-test.png`);
    assert.strictEqual(fs.readFileSync(local(p)).length, 4);
    const dir = await agents.uploadDir();
    assert(dir.startsWith(`${HOME}/.pult/uploads/`) && fs.statSync(local(dir)).isDirectory());
  });

  console.log(results.join('\n'));
  agents.dispose();
  conn.close();
  setTimeout(() => process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0), 300);
})();
