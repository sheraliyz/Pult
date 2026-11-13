// Unit tests for the AI agents core (no server needed):
//   flutter test test/agents_test.dart

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pult/core/agents.dart';
import 'package:pult/core/format.dart';

void main() {
  test('agentOf: command names and titles', () {
    expect(agentOf('claude', 'x'), Agent.claude);
    expect(agentOf('2.1.300', '✳ Fix it'), Agent.claude);
    expect(agentOf('node', '✳ Claude Code'), Agent.claude);
    expect(agentOf('agy', ''), Agent.agy);
    expect(agentOf('bash', '✳ Claude Code'), isNull);
    expect(agentOf('node', 'server.js'), isNull);
  });

  test('cleanTitle drops the status glyph', () {
    expect(cleanTitle('✳ Refactor auth'), 'Refactor auth');
    expect(cleanTitle('agy'), 'agy');
  });

  test('parseClaudeSnapshot: full and partial data', () {
    final s = parseClaudeSnapshot(
      jsonEncode({
        't': 100,
        'd': {
          'model': {'display_name': 'Opus'},
          'context_window': {'used_percentage': 23},
          'rate_limits': {
            'five_hour': {'used_percentage': 41.5, 'resets_at': 200},
          },
        },
      }),
      '/home/demo/.pult/state/claude.pult-0002.json',
    )!;
    expect(s.session, 'pult-0002');
    expect(s.t, 100000);
    expect(s.five!.used, closeTo(0.415, 1e-9));
    expect(s.five!.resetAt, 200000);
    expect(s.week, isNull);
    expect(s.ctx, 23);
    final bare = parseClaudeSnapshot('{"t":1,"d":{"model":{"id":"x"},"context_window":{"used_percentage":null}}}', 'claude.json')!;
    expect(bare.hasLimits, isFalse);
    expect(bare.ctx, isNull);
    expect(bare.session, isNull);
    expect(parseClaudeSnapshot('{"t":1,"d":', 'claude.json'), isNull);
  });

  test('a window past its reset time starts from zero', () {
    final past = UsageWindow(0.8, DateTime.now().millisecondsSinceEpoch - 1000).now;
    expect(past.used, 0);
    expect(past.wasReset, isTrue);
    final future = UsageWindow(0.8, DateTime.now().millisecondsSinceEpoch + 60000).now;
    expect(future.used, 0.8);
  });

  test('parseAgyUsage: groups, logs before JSON, untouched windows', () {
    final json = jsonEncode({
      'command': {
        'data': {
          'groups': [
            {
              'name': 'G',
              'buckets': [
                {'window': '5h', 'remaining_fraction': 0.25, 'reset_time': '2030-01-01T00:00:00Z'},
                {'window': 'weekly', 'remaining_fraction': 1, 'reset_time': '2030-01-02T00:00:00Z'},
              ],
            },
          ],
        },
      },
    });
    final u = parseAgyUsage('some log line\n$json\n')!;
    expect(u.single.buckets.first.window, '5h');
    expect(u.single.buckets.first.usage.used, 0.75);
    expect(u.single.buckets.first.usage.resetAt, DateTime.parse('2030-01-01T00:00:00Z').millisecondsSinceEpoch);
    expect(u.single.buckets.last.window, 'week');
    expect(u.single.buckets.last.usage.resetAt, isNull, reason: 'rolling reset of an unused window is dropped');
    expect(parseAgyUsage('{"status":"ERROR"}'), isNull);
    expect(parseAgyUsage('not json'), isNull);
  });

  test('settings: broken JSON is refused, nothing else', () {
    expect(parseSettings(null), isEmpty);
    expect(parseSettings('{"model":"opus"}'), {'model': 'opus'});
    expect(() => parseSettings('{ "model": "opus", }'), throwsA(anything));
    expect(() => parseSettings('[1]'), throwsA(anything));
  });

  test('time formatting (Uzbek)', () {
    final now = DateTime.now().millisecondsSinceEpoch;
    expect(fmtUntil(now + (2 * 3600 + 10 * 60 + 30) * 1000), '2 soat 10 daq');
    expect(fmtUntil(now + (3 * 86400 + 4 * 3600 + 60) * 1000), '3 kun 4 soat');
    expect(fmtUntil(now + 20 * 1000), '1 daq');
    expect(pathArg('/home/demo/a.png'), '/home/demo/a.png');
    expect(pathArg('/home/demo/my shot.png'), "'/home/demo/my shot.png'");
  });

  test('status line script is the same one the desktop app installs', () async {
    final js = File('../src/main/agents.js');
    ProcessResult? r;
    try {
      r = await Process.run('node', ['-e', 'process.stdout.write(require(process.argv[1]).BRIDGE_SCRIPT)', js.absolute.path], stdoutEncoding: utf8);
    } on ProcessException {
      r = null;
    }
    if (r == null || r.exitCode != 0) {
      markTestSkipped('node or ../src/main/agents.js not available');
      return;
    }
    expect(bridgeScript, r.stdout);
    expect(bridgeScript, startsWith('#!/bin/sh\n# pult-bridge v$bridgeVersion\n'));
  });
}
