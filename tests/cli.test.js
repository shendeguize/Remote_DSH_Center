/** CLI 纯函数单测（11 §8.1「CLI parseArgv / resolveHostArg / SSE 行解析」）。 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COMMANDS, EXIT, TERMINAL, UsageError, buildDefaultsPatchFor, buildHostPatchFor, coerceConfigValue, createSseParser,
  exitCodeFor, formatTable, parseArgv, parseSseFrame, resolveHostArg, tailFile, usageText,
} from '../src/cli.js';

test('parseArgv 支持 --key value / --key=value / 短旗标', () => {
  assert.deepEqual(parseArgv(['up', '--port', '7799']), { positionals: ['up'], flags: { port: 7799 } });
  assert.deepEqual(parseArgv(['--port=7799']), { positionals: [], flags: { port: 7799 } });
  assert.deepEqual(parseArgv(['--foreground']), { positionals: [], flags: { foreground: true } });
  assert.deepEqual(parseArgv(['-f', '-n', '50']), { positionals: [], flags: { f: true, n: 50 } });
  assert.deepEqual(parseArgv(['gpu-1', '--no-wait']), { positionals: ['gpu-1'], flags: { 'no-wait': true } });
});

test('parseArgv：`--` 之后全归 positionals', () => {
  const parsed = parseArgv(['config', 'set', '--', '--weird-key', '-x']);
  assert.deepEqual(parsed.positionals, ['config', 'set', '--weird-key', '-x']);
  assert.deepEqual(parsed.flags, {});
});

test('parseArgv 对坏用法抛 UsageError（→ 退出码 3）', () => {
  assert.throws(() => parseArgv(['--nope']), UsageError);
  assert.throws(() => parseArgv(['--port']), UsageError, '缺值');
  assert.throws(() => parseArgv(['--port', 'abc']), UsageError, '非整数');
  assert.throws(() => parseArgv(['--port', '--json']), UsageError, '值位上是另一个旗标');
  assert.throws(() => parseArgv(['--foreground=maybe']), UsageError, '布尔旗标不接受任意值');
  assert.equal(EXIT.usage, 3);
});

test('exitCodeFor：说不上话算 2，被受理后失败算 1', () => {
  // README 与 cli.js 文件头都写着「2 = 超时/通信失败」，那超时就必须真的给 2——
  // 脚本按退出码分流「重试」与「别重试」，混成 1 会让调用方无从判断。
  assert.equal(exitCodeFor({ status: 0, code: 'INTERNAL' }), EXIT.comm, '连 manager 都没连上');
  assert.equal(exitCodeFor({ status: 504, code: 'SSH_TIMEOUT' }), EXIT.comm);
  assert.equal(exitCodeFor({ status: 502, code: 'SSH_UNREACHABLE' }), EXIT.comm);
  assert.equal(exitCodeFor({ status: 409, code: 'KILL_REFUSED' }), EXIT.failed, '拒杀是动作失败，不是通信失败');
  assert.equal(exitCodeFor({ status: 400, code: 'VALIDATION' }), EXIT.failed);
  assert.equal(exitCodeFor({ status: 409, code: 'PORT_EXHAUSTED' }), EXIT.failed);
  assert.equal(exitCodeFor({ status: 500, code: 'LAUNCH_FAILED' }), EXIT.failed);
});

test('resolveHostArg：精确优先、唯一前缀通过、歧义列候选', () => {
  const hosts = ['gpu-1', 'gpu-12', 'cpu-1'];
  assert.deepEqual(resolveHostArg('gpu-1', hosts), { ok: true, name: 'gpu-1' }, '精确命中不该被前缀歧义拖累');
  assert.deepEqual(resolveHostArg('cpu', hosts), { ok: true, name: 'cpu-1' });

  const ambiguous = resolveHostArg('gpu', hosts);
  assert.equal(ambiguous.ok, false);
  assert.deepEqual(ambiguous.candidates, ['gpu-1', 'gpu-12']);

  const missing = resolveHostArg('zzz', hosts);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.candidates, hosts);
});

test('SSE 分帧器：跨 chunk、心跳注释、坏 JSON', () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push('event: host-changed\ndata: {"revi'), []);

  const frames = parser.push('sion":1}\n\n: heartbeat\n\nevent: log-line\ndata: {"msg":"hi"}\n\n');
  assert.deepEqual(frames.map((f) => f.type), ['host-changed', 'log-line']);
  assert.equal(frames[0].data.revision, 1);
  assert.equal(frames[1].data.msg, 'hi');

  assert.deepEqual(parser.push('event: x\ndata: {oops}\n\n'), [], '坏 JSON 丢弃而不炸');
  assert.equal(parseSseFrame('event: x'), null, '没有 data 字段不成帧');
});

test('终态表覆盖五个受理型操作（11 §6.2）', () => {
  assert.deepEqual(Object.keys(TERMINAL).sort(), ['probe', 'reconnect', 'restart', 'start', 'stop']);
  assert.deepEqual(TERMINAL.start, { success: ['running'], fail: ['ready', 'crashed'], afterStarting: true });
  assert.equal(TERMINAL.restart.afterStarting, true, 'ready 只有在 starting 之后才算回滚失败');
  assert.equal(TERMINAL.probe.afterStarting, undefined, 'probe 的 ready 就是成功，不需延后');
  assert.deepEqual(TERMINAL.probe.success, ['ready', 'no_dsh', 'unreachable']);
  assert.deepEqual(TERMINAL.stop.fail, [], 'stop 的失败靠 HTTP 409 KILL_REFUSED，不等 SSE');
});

test('命令表覆盖 02 §9.2 与 §10 的全部子命令', () => {
  for (const name of ['init', 'up', 'down', 'restart', 'status', 'logs', 'service']) {
    assert.ok(COMMANDS[name], `缺生命周期命令 ${name}`);
    assert.equal(COMMANDS[name].needsServer, false, `${name} 必须在 manager 未运行时也能用`);
  }
  for (const name of ['ls', 'probe', 'start', 'stop', 'reconnect', 'log']) {
    assert.equal(COMMANDS[name].needsServer, true, `${name} 应先探活 manager`);
  }
  assert.match(usageText(), /退出码/);
});

test('config set 的 defaults 侧只放行三个可写键', () => {
  assert.deepEqual(buildDefaultsPatchFor('manager.port', 7799), { manager: { port: 7799 } });
  assert.deepEqual(buildDefaultsPatchFor('defaults.remoteWebPort', 9000), { remoteWebPort: 9000 });
  assert.deepEqual(buildDefaultsPatchFor('defaults.localPortRange', [1, 2]), { localPortRange: [1, 2] });
  assert.equal(buildDefaultsPatchFor('hosts.gpu-1.autoStart', true), null, 'localPort/主机配置不走这里');
});

test('config set hosts.<主机>.workdir 路由到主机配置端点', () => {
  assert.deepEqual(buildHostPatchFor('hosts.gpu-1.workdir', '/root/proj'), {
    name: 'gpu-1',
    body: { workdir: '/root/proj' },
  });
  // 主机名本身可含点（ssh Host 名允许）
  assert.deepEqual(buildHostPatchFor('hosts.a.b.workdir', '~/x'), { name: 'a.b', body: { workdir: '~/x' } });
  // 命令行给不出 JSON null，故空串与字面 null 都表示回落远端家目录
  assert.deepEqual(buildHostPatchFor('hosts.gpu-1.workdir', ''), { name: 'gpu-1', body: { workdir: null } });
  assert.deepEqual(buildHostPatchFor('hosts.gpu-1.workdir', 'null'), { name: 'gpu-1', body: { workdir: null } });

  for (const key of ['manager.port', 'hosts.gpu-1.autoStart', 'hosts..workdir', 'workdir', 'hosts.gpu-1']) {
    assert.equal(buildHostPatchFor(key, 'x'), null, `不该路由：${key}`);
  }
});

test('coerceConfigValue 识别整数/布尔/区间', () => {
  assert.equal(coerceConfigValue('7788'), 7788);
  assert.equal(coerceConfigValue('true'), true);
  assert.deepEqual(coerceConfigValue('17701-17799'), [17_701, 17_799]);
  assert.deepEqual(coerceConfigValue('17701,17799'), [17_701, 17_799]);
  assert.equal(coerceConfigValue('abc'), 'abc');
});

test('formatTable 按中文宽度对齐（列起点的显示宽度一致）', () => {
  const displayWidth = (s) => [...s].reduce((w, ch) => w + (/[\u2E80-\uA4CF\uFF00-\uFF60\u2014]/.test(ch) ? 2 : 1), 0);
  const colStart = (line, cell) => displayWidth(line.slice(0, line.indexOf(cell)));

  const table = formatTable(['主机', '状态'], [['gpu-1', '运行中'], ['a', '—']]);
  const [head, row1, row2] = table.split('\n');

  assert.equal(colStart(row1, '运行中'), colStart(head, '状态'));
  assert.equal(colStart(row2, '—'), colStart(head, '状态'));
});

test('tailFile 只取尾部 N 行', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'manager.log');
  fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));

  const tail = tailFile(file, 3).trim().split('\n');
  assert.deepEqual(tail, ['line 497', 'line 498', 'line 499']);

  // 请求多于总行数时不报错
  assert.equal(tailFile(file, 10_000).split('\n').length, 500);
});

test('V-3 演练：故意判红，验证 required checks 能封锁合入（随后回滚）', () => {
  assert.equal(1, 2, '这条断言是演练用的，必红');
});
