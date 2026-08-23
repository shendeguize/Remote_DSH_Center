/** CLI 纯函数单测（11 §8.1「CLI parseArgv / resolveHostArg / SSE 行解析」）。 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COMMANDS, EXIT, TERMINAL, UsageError, assertCliSetupLocalIdentities, buildDefaultsPatchFor, buildHostPatchFor,
  classifyConfigFile, coerceConfigValue, createSseParser, exitCodeFor, formatTable, parseArgv, parseSseFrame,
  persistSetup, resolveHostArg, tailFile, upToDateLines, usageText, withLocalCandidate,
} from '../src/cli.js';
import { newFactoryConfig, newHostConfig } from '../src/defaults.js';

test('update 的「已是最新」：跟着 rc 的人得看到新 rc，装正式版的人不受打扰', () => {
  assert.deepEqual(upToDateLines({ from: '0.1.0' }), ['已是最新：v0.1.0。']);

  const onRc = upToDateLines({ from: '0.2.0-rc.3', newerPrerelease: '0.2.0-rc.4' });
  assert.equal(onRc.length, 2);
  assert.match(onRc[1], /v0\.2\.0-rc\.4/);
  assert.match(onRc[1], /--pre/, '必须给出下一步怎么做');

  assert.deepEqual(
    upToDateLines({ from: '0.2.0-rc.4', pre: true }),
    ['已是最新：v0.2.0-rc.4（含预发布口径）。'],
    '已经在 --pre 口径上就别再啰嗦',
  );
});

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

test('exitCodeFor：超时/说不上话算 2，其余操作失败算 1', () => {
  // README 与 cli.js 文件头都写着「2 = 超时/通信失败」，那超时就必须真的给 2——
  // 脚本按退出码分流「重试」与「别重试」，混成 1 会让调用方无从判断。
  assert.equal(exitCodeFor({ status: 0, code: 'INTERNAL' }), EXIT.comm, '连 manager 都没连上');
  assert.equal(exitCodeFor({ status: 504, code: 'SSH_TIMEOUT' }), EXIT.comm);
  assert.equal(exitCodeFor({ status: 502, code: 'SSH_UNREACHABLE' }), EXIT.comm);
  assert.equal(exitCodeFor({ status: 504, code: 'LOCAL_TIMEOUT' }), EXIT.comm, '本机执行超时仍属于超时');
  assert.equal(exitCodeFor({ status: 500, code: 'LOCAL_EXEC_FAILED' }), EXIT.failed, '本机执行失败是操作失败');
  assert.equal(exitCodeFor({ status: 500, code: 'LOCAL_COPY_FAILED' }), EXIT.failed, '本机复制失败是操作失败');
  assert.equal(exitCodeFor({ status: 409, code: 'KILL_REFUSED' }), EXIT.failed, '拒杀是动作失败，不是通信失败');
  // 值不合法是「你敲错了」，不是「操作没成」——重试一万次也还是这个结果（issue #63）
  assert.equal(exitCodeFor({ status: 400, code: 'VALIDATION' }), EXIT.usage);
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

test('withLocalCandidate：CLI init 始终只补一台本机，且避开 SSH 名称冲突', () => {
  const candidates = withLocalCandidate(['workstation', 'gpu-1'], 'workstation');
  assert.deepEqual(candidates, [
    { name: 'workstation', local: false },
    { name: 'gpu-1', local: false },
    { name: 'workstation-local', local: true },
  ]);
  assert.equal(candidates.filter((candidate) => candidate.local).length, 1);

  const current = {
    hosts: {
      'saved-local': { local: true },
      'gpu-1': { local: false },
    },
  };
  const reused = withLocalCandidate(['gpu-1'], 'new-hostname', current);
  assert.deepEqual(reused, [
    { name: 'gpu-1', local: false },
    { name: 'saved-local', local: true },
  ], '--force 应复用已经配置的本机名称');
});

test('withLocalCandidate：非法 hostname 回退为 safe-host，并稳定避让冲突', () => {
  for (const hostname of ['研发 Mac', '-option', '']) {
    const candidates = withLocalCandidate([], hostname);
    assert.deepEqual(candidates, [{ name: 'local-host', local: true }], JSON.stringify(hostname));
  }

  const collided = withLocalCandidate(
    ['local-host', 'local-host-local', 'local-host-local-2'],
    '研发 Mac',
  );
  assert.equal(collided.at(-1).name, 'local-host-local-3');
  assert.match(collided.at(-1).name, /^[A-Za-z0-9._-]+$/);
  assert.equal(collided.at(-1).name.startsWith('-'), false);
});

test('运行中 setup 只保留单次原子提交，不再预登记本机', () => {
  const source = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"]\/api\/hosts\/local['"]/, 'init 不得先持久化本机身份');
  const persistSource = source.slice(
    source.indexOf('export async function persistSetup'),
    source.indexOf('function raceWithDeadline'),
  );
  assert.equal(
    [...persistSource.matchAll(/\bapiRequest\(/g)].length,
    1,
    '运行中 manager 路径只能发出一次请求',
  );
  assert.match(persistSource, /apiRequest\(port, 'POST', '\/api\/setup', config\)/);
});

test('CLI setup 可信身份只允许 canonical 候选，并拒绝把任意 SSH host 翻成本机', () => {
  const context = {
    current: { hosts: { 'gpu-1': { local: false } } },
    preferredLocalName: 'workstation',
    sshNames: ['gpu-1'],
  };
  assert.doesNotThrow(() => assertCliSetupLocalIdentities(
    { hosts: { workstation: { local: true } } },
    context,
  ));
  assert.throws(
    () => assertCliSetupLocalIdentities(
      { hosts: { 'client-picked-local': { local: true } } },
      context,
    ),
    (err) => err.code === 'NOT_ALLOWED' && /未经 CLI 认可/.test(err.message),
  );
  assert.throws(
    () => assertCliSetupLocalIdentities(
      { hosts: { 'gpu-1': { local: true } } },
      context,
    ),
    (err) => err.code === 'NOT_ALLOWED' && /SSH 主机/.test(err.message),
  );
});

test('persistSetup：manager 未运行时原子写入；写盘失败保留原文件并返回人话', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-persist-'));
  const savedHome = process.env.DSHC_HOME;
  t.after(() => {
    if (savedHome === undefined) delete process.env.DSHC_HOME;
    else process.env.DSHC_HOME = savedHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  let stdout = '';
  let stderr = '';
  t.mock.method(process.stdout, 'write', (chunk) => { stdout += String(chunk); return true; });
  t.mock.method(process.stderr, 'write', (chunk) => { stderr += String(chunk); return true; });

  const config = newFactoryConfig();
  config.manager.port = 7881;
  config.hosts.workstation = { ...newHostConfig(), local: true };

  const successDir = path.join(root, 'success');
  fs.mkdirSync(successDir);
  process.env.DSHC_HOME = successDir;
  const success = await persistSetup(config, {}, {
    preferredLocalName: 'workstation',
    sshNames: [],
  });

  const expected = structuredClone(config);
  expected.setupCompleted = true;
  const expectedBytes = `${JSON.stringify(expected, null, 2)}\n`;
  const successFile = path.join(successDir, 'config.json');
  assert.equal(success, EXIT.ok);
  assert.equal(fs.readFileSync(successFile, 'utf8'), expectedBytes, '磁盘上只能出现完整的新配置');
  assert.equal(fs.statSync(successFile).mode & 0o777, 0o600, '原子临时文件的私有权限要随 rename 保留');
  assert.deepEqual(fs.readdirSync(successDir), ['config.json'], '成功后不留原子写临时文件');
  assert.match(stdout, /已写入 .*config\.json。执行 dshc up/);
  assert.equal(stderr, '');
  assert.equal(fs.existsSync(path.join(successDir, 'manager.pid')), false, '离线路径不该拉起 manager');

  stdout = '';
  stderr = '';
  const failureDir = path.join(root, 'failure');
  fs.mkdirSync(failureDir);
  process.env.DSHC_HOME = failureDir;
  const failureFile = path.join(failureDir, 'config.json');
  const originalBytes = `${JSON.stringify(newFactoryConfig(), null, 2)}\n`;
  fs.writeFileSync(failureFile, originalBytes);
  fs.mkdirSync(`${failureFile}.tmp.${process.pid}`);

  const failed = await persistSetup(config, {}, {
    preferredLocalName: 'workstation',
    sshNames: [],
  });
  assert.equal(failed, EXIT.failed);
  assert.equal(stdout, '', '失败不能谎报已写入');
  assert.match(stderr, /^错误：配置没能写入磁盘，本次修改已放弃/m);
  assert.doesNotMatch(stderr, /内部错误|at persistSetup/, '面向用户的错误不能泄漏栈');
  assert.equal(fs.readFileSync(failureFile, 'utf8'), originalBytes, '原文件字节必须原封不动');
  assert.equal(fs.existsSync(path.join(failureDir, 'manager.pid')), false, '失败路径也不该拉起 manager');
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
  for (const name of ['init', 'up', 'down', 'restart', 'status', 'logs', 'service', 'version', 'update']) {
    assert.ok(COMMANDS[name], `缺生命周期命令 ${name}`);
    assert.equal(COMMANDS[name].needsServer, false, `${name} 必须在 manager 未运行时也能用`);
  }
  // version / update 得出现在用法里，否则装了也没人知道有这两条
  assert.match(usageText(), /dshc version/);
  assert.match(usageText(), /dshc update/);
  for (const name of ['ls', 'probe', 'start', 'stop', 'reconnect', 'log', 'open']) {
    assert.equal(COMMANDS[name].needsServer, true, `${name} 应先探活 manager`);
  }
  // open 是引导模式下唯一放行的：那个页面就是向导本身，拦住它等于把人锁在门外
  assert.equal(COMMANDS.open.allowSetupMode, true);
  for (const name of ['ls', 'probe', 'start', 'stop', 'reconnect', 'log']) {
    assert.notEqual(COMMANDS[name].allowSetupMode, true, `${name} 不该在引导模式下放行`);
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

test('classifyConfigFile 分清「没有」「坏了」「读不了」', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-cfg-'));
  t.after(() => { try { fs.chmodSync(path.join(dir, 'config.json'), 0o600); } catch { /* 可能没建 */ } fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'config.json');

  // 1) 不存在 → 走初始化，这条是唯一允许提「dshc init」的情形
  assert.equal(classifyConfigFile(file).kind, 'missing');

  // 2) 写到一半（掉电、别的工具截断）
  fs.writeFileSync(file, '{"configVersion":1,"manager":{"po');
  assert.equal(classifyConfigFile(file).kind, 'damaged');

  // 3) 空文件也是坏了，不是「没有」——它承载不了任何配置，但覆盖它就丢东西
  fs.writeFileSync(file, '');
  assert.equal(classifyConfigFile(file).kind, 'damaged');

  // 4) 合法 JSON 但不是对象
  fs.writeFileSync(file, '[]');
  assert.equal(classifyConfigFile(file).kind, 'damaged');

  // 5) 好文件
  fs.writeFileSync(file, JSON.stringify({ configVersion: 1, setupCompleted: true, manager: { port: 7788 } }));
  const ok = classifyConfigFile(file);
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.config.manager.port, 7788);

  // 6) 读不了（权限）——这条连 init 都救不了，得说清是权限
  fs.chmodSync(file, 0o000);
  const denied = classifyConfigFile(file);
  fs.chmodSync(file, 0o600);
  // root 跑测试时 chmod 000 照样能读，那就跳过这条判据
  if (process.getuid?.() !== 0) {
    assert.equal(denied.kind, 'unreadable', '权限读不了该单独成一类');
    // fs 的 message 已经以错误码开头，别再拼一遍读成「EACCES EACCES: …」
    assert.doesNotMatch(denied.reason, /EACCES\s+EACCES/, denied.reason);
  }
});

test('EXIT.interrupted 是 130：脚本要能把「我按了 Ctrl-C」和「真失败」分开（issue #108）', () => {
  assert.equal(EXIT.interrupted, 130, 'shell 惯例：128 + SIGINT(2)');
  const codes = Object.values(EXIT);
  assert.equal(new Set(codes).size, codes.length, '退出码不许撞号');
});
