/**
 * 目标 2：远端协议往返（构建 → 真 sh 语法 → 假远端派发 → 解析）。
 *
 * 协议模板是 manager 与远端之间唯一的接口。三段往返各盯一件事：
 *   构建 → `sh -n`      模板不管注入什么值都必须是**合法的 POSIX 脚本**。语法一崩，
 *                       远端行为就完全无从预测（12 §0 那条 `; nohup … &` 的教训）。
 *   构建 → 派发 → 回读   假远端按协议形状把参数抽出来，抽出来的必须**逐字**是塞进去的
 *                       那个值。抽取用的正则就是协议形状的可执行规格。
 *   序列化 → 解析        `parseProtoOutput` 的文法：KEY=VALUE、块、游离行三者的边界。
 *
 * 外加金丝雀 oracle：每个注入值必须落在单引号里且不在命令位。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildLaunchScript, buildLogTailScript, buildPatchCleanupScript, buildStopScript,
  buildVerifyScript, kvOne, parseProtoOutput,
} from '../../src/lib/proto.js';
import { isWorkdirPath, shq } from '../../src/lib/shq.js';
import { canaryVerdict } from '../adversarial/oracle.js';
import { createHarness } from '../harness/index.js';
import { dispatchProtocol } from '../harness/fake-ssh.js';
import { ALPHABETS } from './prng.js';
import { injectionFailure, runFuzzTarget } from './runner.js';

const HOST = 'gpu-1';
const REMOTE_HOME = '/root';

/**
 * 界符与 `\r` 不进生成器，理由是协议本身的**已知边界**而非被测代码的 bug：
 * `printf '%s\n' "$A"` 传输的块，若正文自带一行恰好等于界符，块就在那里提前闭合；
 * 解析器又会先把 `\r` 全删掉。这两种输入的正确行为是「回读不等于原文 → 指纹比对不
 * 成立 → 拒杀」，是 fail-safe，另有一条定死的用例盯着（见文件末尾），不该混进往返
 * 属性里当成 bug 报。
 */
const BLOCK_HOSTILE = Object.freeze(['\r', '\u0000', '\ud800']);

/**
 * 每个注入值都戴一枚标签，金丝雀追的是**整个带标签的串**。
 *
 * 不戴标签会得出假结论：随机载荷短起来就是一个 `.` 或 `,`，而模板正文里到处都是
 * 这些字符（`127.0.0.1`、`.dsh_center_remote`），oracle 会把那些位置当成「载荷逃到了
 * 裸露态」而误报。标签让每次出现都可归因。
 *
 * 标签的字符集必须是别的生成器造不出来的，否则又会撞：`ALPHABETS.shell` 里没有任何
 * 大写字母，`envKey` 的字符集里没有 Q，故 `QQ<n>QQ` 只可能来自这里。撞车了也不会
 * 悄悄放过——出现次数不为一即判红。
 */
const tagged = (index, body) => `QQ${index}QQ${body}`;

function safeName(rng) {
  // 远端名字符集由 assertSafeName 定死；这里只生成合法的，因为非法名的拦截
  // 已经由目标 1 逐字盯着，此处要测的是「合法名一路走到底不变形」
  const head = rng.pick([...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_']);
  return head + rng.string({ min: 0, max: 10, alphabet: ALPHABETS.safeName });
}

function envKey(rng) {
  const head = rng.pick([...'abcdefghijklmnopqrstuvwxyzABCDEFG_']);
  return head + rng.string({ min: 0, max: 8, alphabet: 'abcXYZ_0123456789' });
}

function payload(rng, { max = 20 } = {}) {
  return rng.nasty({ min: 0, max, forbid: BLOCK_HOSTILE });
}

function gen(rng) {
  let tag = 0;
  const nextTagged = (max) => tagged(tag++, payload(rng, { max }));

  const env = {};
  for (let i = 0; i < rng.int(0, 3); i += 1) env[envKey(rng)] = nextTagged(20);

  const patches = [];
  for (let i = 0; i < rng.int(0, 3); i += 1) patches.push(safeName(rng));

  const extraArgs = [];
  for (let i = 0; i < rng.int(0, 3); i += 1) extraArgs.push(nextTagged(20));

  const keepAll = [];
  for (let i = 0; i < rng.int(0, 5); i += 1) keepAll.push(safeName(rng));

  // workdir 的可控段单独留一份：`~` 形态在模板里会变成 `"$HOME"`，整串不逐字出现，
  // 只有尾段才是能追的那个金丝雀。
  const workdirTail = nextTagged(10);
  const workdir = rng.pickWeighted([
    [3, [null, null]],
    [3, [`/${workdirTail}`, workdirTail]],
    [2, [`~/${workdirTail}`, workdirTail]],
    [1, ['~', null]],
  ]);

  // dsh 路径与 workdir 同类：构建期就该拒的（相对、空、带换行）必须拒，该收的必须
  // 逐字落进模板并把所在目录并入 PATH——真机故障正出在这条路径上（曾经缺就退回裸 dsh）。
  const dshTail = nextTagged(10);
  const dshPath = rng.pickWeighted([
    [4, '/usr/bin/dsh'],
    [3, `/root/.canon/node/bin/${dshTail}/dsh`],
    [1, 'dsh'],
    [1, ''],
    [1, '/bin/d\nsh'],
  ]);

  return {
    logName: safeName(rng),
    port: rng.bool(0.15) ? 0 : rng.int(1, 65_535),
    dshPath,
    env,
    patches,
    extraArgs,
    workdir: workdir[0],
    workdirCanary: workdir[1],
    fingerprint: `dsh web --no-open --host 127.0.0.1 --port ${rng.int(1, 65_535)} ${nextTagged(20)}`,
    pid: rng.int(1, 4_294_967_295),
    verifyPort: rng.int(1, 65_535),
    tailLines: rng.int(1, 200),
    // 日志「行」里不放 `\n`，否则一条生成项会变成两行，`tail -n N` 该给什么就成了
    // 对生成器的算术题，而不是对协议的判据
    logBody: Array.from({ length: rng.int(0, 6) }, () => payload(rng, { max: 12 }).replaceAll('\n', '~')),
    cleanup: {
      present: [...new Set(keepAll)],
      keepCount: rng.int(0, keepAll.length),
    },
  };
}

async function check(input, ctx) {
  // 语法检查攒到一起交一次 sh：一例要建五个模板，一个模板一次 spawn 的话进程开销
  // 会占掉整个目标九成的时间，例数就只能砍——那是拿覆盖面换启动开销，不值。
  const bodies = [];
  checkLaunch(input, bodies);
  checkStopAndVerify(input, ctx, bodies);
  checkParserRoundTrip(input);
  checkCleanupRoundTrip(input, ctx, bodies);
  checkLogTailRoundTrip(input, ctx, bodies);
  assertShellSyntax(bodies);
}

// ── 构建 → 真 sh 语法 + 金丝雀 ───────────────────────────────────────────

function checkLaunch(input, bodies) {
  const build = () => buildLaunchScript({
    logName: input.logName,
    port: input.port,
    dshPath: input.dshPath,
    env: input.env,
    patchRemoteNames: input.patches,
    extraArgs: input.extraArgs,
    workdir: input.workdir,
  });

  // dsh 路径先于 workdir 校验：缺路径或非绝对路径一律拒绝拼装，绝不退回 PATH 查找
  if (!/^\/[^\0\r\n]*$/u.test(input.dshPath)) {
    assert.throws(build, (error) => error?.code === 'VALIDATION', `非法 dshPath 没被拦：${JSON.stringify(input.dshPath)}`);
    return;
  }

  // workdir 是唯一在构建期就可能被拒的注入点（相对路径、空串、含换行/NUL）。
  // 「该拒的一定拒、拒了就绝不落进模板」和「该收的一定收」是同一条性质的两面。
  if (input.workdir !== null && !isWorkdirPath(input.workdir)) {
    assert.throws(build, (error) => error?.code === 'VALIDATION', `非法 workdir 没被拦：${JSON.stringify(input.workdir)}`);
    return;
  }

  const body = build();
  bodies.push(['LAUNCH', body]);

  // 端口是**不转义**拼进去的，所以模板里出现的必须是纯数字
  assert.match(body, /--port (?:0|[1-9][0-9]*)(?: |$)/u, `LAUNCH 的端口位不是纯数字：${body}`);

  // 已解析路径必须真被用上：命令词是它，且它的 bin 目录并进 PATH（dsh 常是
  // `#!/usr/bin/env node`，解释器与它同住一个目录）。
  // 这里不走 canaryVerdict：路径本身就落在 `PATH=…` 赋值这个「命令位」上，通用判据
  // 会一律判逃逸；而赋值右侧是 shq 引号包着的，安全性由 shq 的逐字测试盯。
  const dir = input.dshPath.slice(0, input.dshPath.lastIndexOf('/')) || '/';
  assert.ok(
    body.includes(`${shq(input.dshPath)} web`),
    `命令词不是已解析路径（漏传就会退回裸 dsh 走 PATH 查找）：${body}`,
  );
  assert.ok(
    body.includes(`PATH=${shq(dir)}:"$PATH"; export PATH; nohup `),
    `缺 PATH 前置或形状不符：${body}`,
  );

  for (const [key, value] of Object.entries(input.env)) {
    assertContained(body, value, { surface: 'launch-argv', entry: 'inject.env.value' });
    // 键在引号外，必须逐字出现在 `env K='…'` 的位置上
    assert.ok(body.includes(`${key}='`), `LAUNCH 缺 env 键 ${key}：${body}`);
  }
  for (const value of input.extraArgs) {
    assertContained(body, value, { surface: 'launch-argv', entry: 'inject.extraArgs' });
  }
  if (input.workdirCanary !== null) {
    assertContained(body, input.workdirCanary, { surface: 'launch-argv', entry: 'workdir' });
  }
}

/**
 * `sh -n` 只做语法检查、不执行，是「模板永远合法」这条性质最权威的判据。
 *
 * 一次交多个模板（换行分隔仍是合法脚本）；真红了再逐个交一遍，把是哪个模板坏的定位出来。
 * @param {Array<[string, string]>} bodies [标签, 正文]
 */
function assertShellSyntax(bodies) {
  if (syntaxOk(bodies.map(([, body]) => body).join('\n'))) return;
  for (const [label, body] of bodies) {
    assert.ok(syntaxOk(body), `${label} 模板不是合法 POSIX 脚本：\n${body}`);
  }
  assert.fail(`模板逐个都合法、合起来却不合法（有模板没以完整语句收尾）：\n${bodies.map(([l]) => l).join(', ')}`);
}

function syntaxOk(script) {
  try {
    execFileSync('sh', ['-n', '-c', script], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 金丝雀落位判据。含单引号的值定位不了（shq 会把 `'` 拆成 `'\''`，正文里不逐字出现），
 * 退化成只追标签——标签仍在同一个词里，落位性质一样能判。
 */
function assertContained(body, value, meta) {
  const needle = value.includes("'") ? value.slice(0, value.indexOf("'")) : value;
  assert.ok(needle.length > 0, `金丝雀退化成空串了：${JSON.stringify(value)}`);
  // 同一个值出现多次是模板的正常形态（workdir 就在 `cd` 与诊断用的 `WD=%s` 各出现一次），
  // 故判据是「每一次出现都安全」而非「只出现一次」。verdict 已经逐个位置查过。
  const verdict = canaryVerdict(body, needle);
  if (!verdict.ok) {
    throw injectionFailure(`注入值逃出了单引号：${verdict.reason}`, { ...meta, payload: value, canary: needle });
  }
}

// ── 构建 → 派发 → 回读 ──────────────────────────────────────────────────

/**
 * STOP 的抽取往返，只走**指纹不匹配**这一支。
 *
 * 匹配那一支会真的把进程杀掉，一例一个哨兵进程太贵；而随机测试在这里真正该盯的是
 * 反方向——「差一个字符也必须拒杀」。所以：把哨兵登记成指纹 F，再拿 F+'!' 去停，
 * 期望 KILLED=no。这一次往返同时验了三件事：F 被逐字抽出来了、比对是逐字的、
 * ARGS 块把 F 原样回读了。
 */
function checkStopAndVerify(input, ctx, bodies) {
  const fingerprint = input.fingerprint;
  ctx.harness.setHost(HOST, {
    processes: { [String(ctx.sentinelPid)]: { args: fingerprint, requestedPort: '1', logName: 'x.log' } },
  });

  const stop = buildStopScript({ pid: ctx.sentinelPid, fingerprint: `${fingerprint}!` });
  bodies.push(['STOP', stop]);
  assertContained(stop, fingerprint, { surface: 'launch-argv', entry: 'stop.fingerprint' });

  const out = parseProtoOutput(capture(ctx, () => dispatchProtocol(HOST, stop, { home: REMOTE_HOME })), {
    requireDone: 'STOP_DONE',
  });
  assert.equal(kvOne(out, 'KILLED'), 'no', `指纹差一个字符还是杀了（误杀）：${JSON.stringify(fingerprint)}`);
  assert.equal(kvOne(out, 'REASON'), 'fingerprint-mismatch');
  assert.equal(out.blocks.ARGS, fingerprint, `ARGS 块回读的指纹变形了：${JSON.stringify(fingerprint)}`);

  const verify = buildVerifyScript({ pid: input.pid, port: input.verifyPort });
  bodies.push(['VERIFY', verify]);
  assert.match(verify, new RegExp(`ps -p ${input.pid} -o args=`, 'u'), 'VERIFY 的 pid 位变形了');
}

// ── 序列化 → 解析 ───────────────────────────────────────────────────────

/**
 * 解析器文法往返。用被测输入派生出一份「协议输出」，序列化后再解析，三类元素
 * （KEY=VALUE / 块 / 游离行）必须逐字还原。空行按文法被丢弃，故不参与比较。
 */
function checkParserRoundTrip(input) {
  const kv = {
    ALIVE: ['yes'],
    PORT: [String(input.verifyPort)],
    // 重复键要按出现顺序全留下（kvOne 取最后一个），这条常被「顺手改成对象」改坏
    NOTE: input.extraArgs.map((a) => a.replace(/[\n\r]/gu, ' ')),
    STOP_DONE: ['yes'],
  };
  const blocks = { ARGS: input.logBody.join('\n') };
  const stray = input.patches.map((p) => `x ${p}`);

  const text = [
    ...Object.entries(kv).flatMap(([key, values]) => values.map((v) => `${key}=${v}`)),
    `ARGS<<EOF\n${blocks.ARGS}\nEOF`,
    ...stray,
  ].join('\n');

  const out = parseProtoOutput(text, { requireDone: 'STOP_DONE' });
  const expectedKv = Object.fromEntries(Object.entries(kv).filter(([, v]) => v.length > 0));
  assert.deepEqual(out.kv, expectedKv, `KEY=VALUE 往返变形：${JSON.stringify(text)}`);
  assert.deepEqual(out.blocks, blocks, `块往返变形：${JSON.stringify(text)}`);
  assert.deepEqual(out.stray, stray.filter((s) => s !== ''), `游离行往返变形：${JSON.stringify(text)}`);
}

// ── patch 清理与日志：构建 → 派发 → 状态引擎回读 ────────────────────────

/** 保留清单是**空格分隔**匹配的，所以「合法名里没有空格」这条不变量在这里兑现。 */
function checkCleanupRoundTrip(input, ctx, bodies) {
  const present = input.cleanup.present;
  const keep = present.slice(0, input.cleanup.keepCount);
  const files = {};
  for (const name of present) files[`.dsh_center_remote/patches/${name}`] = 'ff';
  files['.dsh_center_remote/other.txt'] = 'ff'; // 不在 patches/ 下的不许被扫到
  ctx.harness.setHost(HOST, { files });

  const body = buildPatchCleanupScript({ keepNames: keep });
  bodies.push(['CLEANUP', body]);
  const out = parseProtoOutput(capture(ctx, () => dispatchProtocol(HOST, body, { home: REMOTE_HOME })), {
    requireDone: 'CLEAN_DONE',
  });
  assert.equal(kvOne(out, 'CLEAN_DONE'), 'yes');

  const survived = Object.keys(ctx.harness.remoteFiles(HOST))
    .filter((f) => f.startsWith('.dsh_center_remote/patches/'))
    .map((f) => path.basename(f))
    .sort();
  assert.deepEqual(survived, [...keep].sort(), `清理后的存留集与保留清单不符（keep=${JSON.stringify(keep)}）`);
  assert.ok(ctx.harness.remoteFiles(HOST)['.dsh_center_remote/other.txt'], '清理越界删到了 patches/ 之外');
}

/**
 * 日志尾行：判据是 `tail -n N` 的**定义**（是原文的后缀、恰好 min(N, 总行数) 段），
 * 而不是把垫片的切片算式抄一遍——抄一遍的话两边一起错也发现不了。
 */
function checkLogTailRoundTrip(input, ctx, bodies) {
  const dir = path.join(ctx.harness.harnessDir, 'remote', HOST);
  fs.mkdirSync(dir, { recursive: true });
  const lines = input.logBody.length > 0 ? input.logBody : ['(empty)'];
  const content = `${lines.join('\n')}\n`;
  fs.writeFileSync(path.join(dir, input.logName), content);

  const body = buildLogTailScript({ logName: input.logName, lines: input.tailLines });
  bodies.push(['LOG', body]);
  assert.ok(body.includes(`/${input.logName}"`), `LOG 模板里的日志名变形了：${body}`);

  const text = capture(ctx, () => dispatchProtocol(HOST, body, { home: REMOTE_HOME }));
  assert.ok(content.endsWith(text), `日志尾行不是原文的后缀（tail -n ${input.tailLines}）`);
  assert.equal(
    text.split('\n').length,
    Math.min(input.tailLines, content.split('\n').length),
    `日志尾行段数不对（tail -n ${input.tailLines}，原文 ${content.split('\n').length} 段）`,
  );
}

// ── 装置 ────────────────────────────────────────────────────────────────

/** 派发直写 process.stdout（垫片本是独立进程），进程内跑就得把它接下来。 */
function capture(ctx, fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

async function setup(t) {
  const harness = createHarness({ hosts: { [HOST]: undefined } });
  harness.setHost(HOST, {});
  const restore = harness.activate();

  // 假远端进程要「真的活着」（alive() 会 process.kill(pid,0)），但绝不能是本进程——
  // STOP 一匹配就会朝它发 SIGTERM。派一个哨兵子进程去当这个 pid。
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  await new Promise((resolve) => { sentinel.once('spawn', resolve); });

  t.after(() => {
    sentinel.kill('SIGKILL');
    restore();
    harness.cleanup();
  });
  return { harness, sentinelPid: sentinel.pid };
}

test('fuzz：协议往返（构建 / sh -n / 派发回读 / 解析）', async (t) => {
  const stats = await runFuzzTarget(t, {
    target: 'proto-roundtrip', gen, check, setup, minCorpus: 1,
  });
  assert.ok(stats.corpus + stats.generated > 0, '一个例子都没跑');
});

test('协议的已知边界：ARGS 正文自带界符行时，回读必然截断——但结论是拒杀', () => {
  // 远端进程的命令行里真有可能出现换行 + "EOF"。此时块提前闭合，回读的指纹短了一截。
  // 这不是「误杀」风险而是「拒杀」：manager 记下的指纹与后来读到的不相等，STOP 就不动手。
  const fingerprint = 'dsh web --no-open\nEOF\n--port 8899';
  const text = `ALIVE=yes\nARGS<<EOF\n${fingerprint}\nEOF\nVERIFY_DONE=yes\n`;
  const out = parseProtoOutput(text, { requireDone: 'VERIFY_DONE' });
  assert.equal(out.blocks.ARGS, 'dsh web --no-open', '界符行处必须闭合（这就是截断发生的地方）');
  assert.notEqual(out.blocks.ARGS, fingerprint, '截断后的指纹与原文不等——正是拒杀的成因');
  assert.deepEqual(
    out.stray,
    ['--port 8899', 'EOF'],
    '界符之后的正文（含那个真界符行）落进游离行，不会被误当成指纹',
  );
});
