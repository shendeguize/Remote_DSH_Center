import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildProbeScript,
  buildLaunchScript,
  buildLaunchPollScript,
  buildVerifyScript,
  buildManualPortProbeScript,
  buildStopScript,
  buildLogTailScript,
  buildPatchCleanupScript,
  buildSettingsReadScript,
  buildSettingsWriteScript,
  parseProtoOutput,
  parseLaunchUrl,
  kvOne,
  MANUAL_WEB_GREP,
  MANUAL_WEB_SCAN,
} from '../../src/lib/proto.js';
import { localExec, SSH_OUTPUT_CAP_BYTES } from '../../src/lib/ssh.js';

/** 判据取自协议自身（ERE 与 JS 同形），只还原躲 grep 用的 `[d]sh`。 */
const MANUAL_WEB_JS = new RegExp(MANUAL_WEB_GREP.replace('[d]', 'd'));

// ── §7 解析器 ────────────────────────────────────────────────────────────

test('KEY=VALUE 行：首个 = 切分，VALUE 可含 =', () => {
  const out = parseProtoOutput('URL=dsh web: http://127.0.0.1:8899\nA=b=c=d\n');
  assert.equal(kvOne(out, 'URL'), 'dsh web: http://127.0.0.1:8899');
  assert.equal(kvOne(out, 'A'), 'b=c=d');
});

test('重复键按序累积', () => {
  const out = parseProtoOutput('K=1\nK=2\nK=3\n');
  assert.deepEqual(out.kv.K, ['1', '2', '3']);
  assert.equal(kvOne(out, 'K'), '3');
});

test('heredoc 块：原文保形、块内不识别 KV', () => {
  const out = parseProtoOutput(
    'ALIVE=yes\nARGS<<EOF\ndsh web --no-open FOO=bar\n  second line\nEOF\nVERIFY_DONE=yes\n',
    { requireDone: 'VERIFY_DONE' },
  );
  assert.equal(out.blocks.ARGS, 'dsh web --no-open FOO=bar\n  second line');
  assert.equal(out.kv.FOO, undefined, '块内的 FOO=bar 不应污染 kv');
});

test('块未闭合 → PROTO_PARSE，detail 带原始 stdout 全文', () => {
  const raw = 'ARGS<<EOF\nhalf a line\n';
  assert.throws(
    () => parseProtoOutput(raw),
    (err) => {
      assert.equal(err.code, 'PROTO_PARSE');
      assert.match(err.message, /ARGS 块未闭合/);
      assert.equal(err.detail, raw);
      return true;
    },
  );
});

test('缺必需哨兵 → PROTO_PARSE', () => {
  assert.throws(
    () => parseProtoOutput('DSH_BIN=/usr/bin/dsh\n', { requireDone: 'PROBE_DONE' }),
    (err) => err.code === 'PROTO_PARSE' && /PROBE_DONE/.test(err.message),
  );
  // 哨兵存在但值不是 yes 也算缺失
  assert.throws(
    () => parseProtoOutput('PROBE_DONE=no\n', { requireDone: 'PROBE_DONE' }),
    (err) => err.code === 'PROTO_PARSE',
  );
});

test('stray 行收集、CRLF 归一、空行忽略（块内除外）', () => {
  const out = parseProtoOutput('bare line\r\nK=v\r\n\r\nB<<EOF\r\n\r\nx\r\nEOF\r\nDONE=yes\r\n', {
    requireDone: 'DONE',
  });
  assert.deepEqual(out.stray, ['bare line']);
  assert.equal(kvOne(out, 'K'), 'v');
  assert.equal(out.blocks.B, '\nx', '块内空行保留');
});

test('小写键不被当作 KV（协议键恒大写）', () => {
  const out = parseProtoOutput('lower=1\n');
  assert.deepEqual(out.stray, ['lower=1']);
});

test('parseLaunchUrl 精析并校验端口范围', () => {
  assert.equal(parseLaunchUrl('dsh web: http://127.0.0.1:8899'), 8899);
  assert.equal(parseLaunchUrl('dsh web: http://127.0.0.1:41929'), 41929);
  assert.equal(parseLaunchUrl('dsh web: http://127.0.0.1:99999'), null);
  assert.equal(parseLaunchUrl('dsh web: http://10.0.0.1:8899'), null);
  assert.equal(parseLaunchUrl('garbage'), null);
});

// ── §1 模板快照 ─────────────────────────────────────────────────────────

const noRawNewline = (s, label) => assert.ok(!s.includes('\n'), `${label} 产物应为单行`);

test('§1.1 探测模板逐字一致（含非交互 PATH 与 login-shell 嗅探）', () => {
  const s = buildProbeScript();
  noRawNewline(s, 'probe');
  for (const marker of [
    'CONFIG_DSH_PATH=',
    'HAS_BASH',
    'HAS_TIMEOUT',
    '/usr/local/bin /usr/bin /usr/sbin /bin',
    'RESOLVED_DSH=',
    'DSH_BIN=${RESOLVED_DSH:-MISSING}',
    'PROBE_DONE=yes',
  ]) assert.ok(s.includes(marker), `探测模板缺少 ${marker}`);
  assert.ok(s.indexOf('CONFIG_DSH_PATH=') < s.indexOf('RESOLVED_DSH='));
  assert.ok(s.indexOf('PATH_DSH=') < s.indexOf('RESOLVED_DSH='));
  assert.ok(s.indexOf('SNIFF_PATH=') < s.indexOf('RESOLVED_DSH='));
  assert.ok(s.indexOf('LOGIN_DSH=') < s.indexOf('RESOLVED_DSH='));
});

test('§1.1 嗅探覆盖只在交互 rc 里现身的安装（canon 前缀 + bash -lic）', () => {
  const s = buildProbeScript();
  assert.ok(
    s.includes('"$HOME/.canon/node/bin" "$HOME/.canon/bin"'),
    'canon 把 dsh 装进自己的 node 前缀，不扫这里的话装好的 pod 会被判成未安装',
  );
  assert.ok(s.includes("bash -lic 'command -v dsh'"), '~/.bashrc 顶部的非交互守卫让 -lc 读不到 export PATH');
  assert.ok(
    s.indexOf("bash -lc 'command -v dsh'") < s.indexOf("bash -lic 'command -v dsh'"),
    '交互 shell 更贵也更吵，只在 login shell 空手而归后兜底',
  );
  assert.ok(s.includes('[ -z "$LOGIN_DSH" ] && command -v timeout'), '兜底须带 timeout，交互 rc 可能挂住');
  assert.ok(
    s.includes('timeout 3 bash -lic'),
    '两次嗅探共用一条 15s 的 ssh 预算，交互那次的上限必须比 login shell 更紧',
  );
  assert.ok(s.includes('grep "^/" | tail -n 1'), '交互 rc 可能先打印横幅，只收绝对路径行');
});

test('§1.1 版本探测带上 dsh 自己的 bin 目录（#!/usr/bin/env node 找得到解释器）', () => {
  const s = buildProbeScript();
  assert.ok(s.includes('DSH_DIR="${RESOLVED_DSH%/*}"'));
  assert.ok(s.includes('PATH="${DSH_DIR:-/}:$PATH" "$RESOLVED_DSH" --version'));
  assert.ok(s.includes('SNIFF_DIR="${SNIFF_PATH%/*}"'));
  assert.ok(s.includes('PATH="${SNIFF_DIR:-/}:$PATH" timeout 5 "$SNIFF_PATH" --version'));
});

test('§1.1 手动实例扫描要求 dsh web 相邻，不认只是「提到」两个词的命令行', () => {
  const s = buildProbeScript();
  assert.ok(s.includes(MANUAL_WEB_SCAN), '探测模板必须复用同一条扫描，不许各写一份');
  // 宽模式（[d]sh.*web）会把本机上 Center 自己派出去的 ssh 探测算成手动实例：那条
  // 命令行原样带着这份脚本，里面既有 command -v dsh 又有 profiles/web
  const sibling = `4242 ssh -o BatchMode=yes other-host sh -c ${s}`;
  assert.ok(/dsh.*web/.test(sibling), '前提：宽模式确实会命中兄弟 ssh，否则这条判据在空转');
  assert.ok(!MANUAL_WEB_JS.test(sibling), '并发探测的 ssh 不是手动实例');
  assert.ok(MANUAL_WEB_JS.test('64498 node /opt/homebrew/bin/dsh web --port 9013 --no-open'));
  assert.ok(
    !MANUAL_WEB_JS.test("777 ssh h sh -c nohup '/usr/bin/dsh' web --port 8899"),
    '在飞的拉起 ssh 里路径带引号（shq），不该被当成已在跑的实例',
  );
});

test('§1.1 手动实例扫描在真 shell 上认真实例、放过旁观进程', async (t) => {
  // 这条流水线此前只有垫片对译过，从没在真 ps/grep 上跑过——幻影实例就是这么漏的
  const dir = await mkdtemp(join(tmpdir(), 'proto-scan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 两个替身都不许 exec：exec 会把自己的 argv 换成 `sleep 30`，进程表里既没有
  // `dsh web` 也没有脚本文本，两条判据一起空转（Linux 上就是这么假绿的）。
  const fakeDsh = join(dir, 'dsh');
  await writeFile(fakeDsh, '#!/bin/sh\nsleep 30\n');
  await chmod(fakeDsh, 0o755);

  // 旁观者照 Center 在本机的真实形状造：argv 里原样驮着整份探测脚本的 ssh。
  const fakeSsh = join(dir, 'ssh');
  await writeFile(fakeSsh, '#!/bin/sh\nsleep 30\n');
  await chmod(fakeSsh, 0o755);

  const script = buildProbeScript();
  const children = [
    spawn(fakeDsh, ['web', '--no-open', '--host', '127.0.0.1', '--port', '65001'], { stdio: 'ignore' }),
    spawn(fakeSsh, ['-o', 'BatchMode=yes', 'other-host', 'sh', '-c', script], { stdio: 'ignore' }),
  ];
  t.after(() => { for (const child of children) child.kill('SIGKILL'); });
  const [real, bystander] = children;
  await new Promise((resolve) => { setTimeout(resolve, 200); });

  // 先验两个替身在进程表里确实是想要的形状，否则失败信息会指向扫描、而真正坏的是布景
  const table = await localExec('ps -eo pid,args');
  const lineOf = (pid) => table.stdout.split('\n').find((l) => Number(l.trim().split(/\s+/)[0]) === pid) ?? '';
  assert.match(lineOf(real.pid), /\/dsh web /, '前提：真实例的 argv 里 dsh web 相邻');
  assert.match(lineOf(bystander.pid), /dsh/, '前提：旁观者的命令行确实驮着脚本，陷阱布好了');
  assert.match(lineOf(bystander.pid), /web/, '前提：脚本里的 profiles/web 也在 ps 可见范围内');

  const scan = await localExec(MANUAL_WEB_SCAN);
  assert.equal(scan.code, 0);
  const pids = scan.stdout.trim().split('\n')
    .map((line) => Number(line.trim().split(/\s+/)[0]));
  assert.ok(pids.includes(real.pid), `真 dsh web（pid ${real.pid}）必须被扫到：\n${scan.stdout}`);
  assert.ok(!pids.includes(bystander.pid), `旁观进程（pid ${bystander.pid}）不该算成实例：\n${scan.stdout}`);
});

test('§1.2 拉起模板：双层算例逐字一致（12 §2.5）', () => {
  const s = buildLaunchScript({
    logName: 'web-8899.log',
    port: 8899,
    env: { GREETING: 'hi there' },
    extraArgs: ['--verbose'],
  });
  noRawNewline(s, 'launch');
  assert.equal(
    s,
    'mkdir -p "$HOME/.dsh_center_remote/patches" || { echo "ERR=mkdir"; exit 9; }; LOG="$HOME/.dsh_center_remote/web-8899.log"; : > "$LOG"; nohup env GREETING=\'hi there\' dsh web --no-open --host 127.0.0.1 --port 8899 \'--verbose\' > "$LOG" 2>&1 < /dev/null & echo "PID=$!"',
  );
});

test('§1.2 拉起模板使用已解析的绝对 dsh 路径并拒绝相对路径', () => {
  const script = buildLaunchScript({ logName: 'web-8899.log', port: 8899, dshPath: '/opt/dsh/bin/dsh' });
  assert.match(script, /nohup '\/opt\/dsh\/bin\/dsh' web/);
  assert.throws(
    () => buildLaunchScript({ logName: 'web-8899.log', port: 8899, dshPath: 'dsh' }),
    (err) => err.code === 'VALIDATION',
  );
});

test('§1.2 拉起把 dsh 自己的 bin 目录并入 PATH（解释器与它同住）', () => {
  const s = buildLaunchScript({
    logName: 'web-8899.log',
    port: 8899,
    dshPath: '/root/.canon/node/bin/dsh',
  });
  noRawNewline(s, 'launch+path');
  assert.ok(
    s.includes('PATH=\'/root/.canon/node/bin\':"$PATH"; export PATH; nohup '),
    'PATH 必须在 nohup 之前就绪，否则 `env node` 找不到解释器，日志里只剩一行报错',
  );

  const legacy = buildLaunchScript({ logName: 'web-8899.log', port: 8899 });
  assert.ok(!legacy.includes('PATH='), '兼容形态的 dsh 没有可推导的目录，模板逐字不变');
});

test('§1.2 前置语句用 "; " 连接、& 后直接跟 echo $!', () => {
  const s = buildLaunchScript({ logName: 'web-8899.log', port: 8899 });
  assert.ok(s.includes('< /dev/null & echo "PID=$!"'), '& 本身是分隔符，其后不能再跟 ;');
  assert.ok(!s.includes('&& echo "PID'), 'AND 链接会让 $! 变成子壳 PID');
  assert.ok(s.includes('"$LOG"; nohup '), '前置语句与 nohup 之间用 "; "');
  assert.ok(s.includes('< /dev/null'), 'stdin 必须重定向，否则 sshd 等后台进程释放通道');
});

test('§1.2 workdir=null 时模板逐字不含 cd（回归锁，补丁 01 §4.1）', () => {
  const withNull = buildLaunchScript({ logName: 'web-8899.log', port: 8899, workdir: null });
  assert.equal(withNull, buildLaunchScript({ logName: 'web-8899.log', port: 8899 }));
  assert.ok(!withNull.includes('cd '), 'null 必须退回补丁前的模板形态');
  assert.ok(!withNull.includes('ERR=workdir'));
});

test('§1.2 workdir 注入 cd 段：绝对路径、~ 拼接与退出码 8', () => {
  const abs = buildLaunchScript({ logName: 'web-8899.log', port: 8899, workdir: '/root/my proj' });
  noRawNewline(abs, 'launch+workdir');
  assert.ok(
    abs.includes(`: > "$LOG"; cd -- '/root/my proj' || { echo "ERR=workdir"; printf 'WD=%s\\n' '/root/my proj'; exit 8; }; nohup `),
    `cd 段应排在日志截断之后、nohup 之前：${abs}`,
  );

  // ~ 不能进单引号（引号内不展开），必须是 "$HOME" 与 shq 段相邻拼接
  const tilde = buildLaunchScript({ logName: 'web-8899.log', port: 8899, workdir: '~/proj' });
  assert.ok(tilde.includes(`cd -- "$HOME"'/proj' || { echo "ERR=workdir"`), tilde);
  const home = buildLaunchScript({ logName: 'web-8899.log', port: 8899, workdir: '~' });
  assert.ok(home.includes('cd -- "$HOME" || { echo "ERR=workdir"'), home);
});

test('§1.2 workdir 形态非法即抛 VALIDATION（不拼装脚本）', () => {
  for (const bad of ['', 'proj', './proj', '~user/proj', 'a\nb', 42]) {
    assert.throws(
      () => buildLaunchScript({ logName: 'web-8899.log', port: 8899, workdir: bad }),
      (e) => e.code === 'VALIDATION',
      `应拒绝：${JSON.stringify(bad)}`,
    );
  }
});

test('§1.2 cd 段在真实 sh 下逐字还原目标目录（含空格与引号）', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  for (const wd of ['/tmp/a b', "/tmp/it's", '~/x y']) {
    const s = buildLaunchScript({ logName: 'web-8899.log', port: 8899, workdir: wd });
    await run('sh', ['-n', '-c', s]);
    // 只跑 cd 段的回显部分：把 cd 换成必败的 false，验证 WD= 的还原值
    const probe = /cd -- (.*?) \|\| \{/.exec(s)[1];
    const { stdout } = await run('sh', ['-c', `printf 'WD=%s\\n' ${probe}`], {
      env: { ...process.env, HOME: '/home/tester' },
    });
    assert.equal(stdout, `WD=${wd.replace(/^~/, '/home/tester')}\n`);
  }
});

test('§1.2 拉起模板可被真实 sh 解析（语法正确性冒烟）', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const s = buildLaunchScript({
    logName: 'web-8899.log',
    port: 8899,
    env: { GREETING: "it's" },
    extraArgs: ['--verbose', 'x; rm -rf ~'],
    patchRemoteNames: ['aaa-a.yml'],
  });
  // sh -n 只做语法检查，不执行任何命令
  await promisify(execFile)('sh', ['-n', '-c', s]);
});

test('§1.2 patch 与 extraArgs 拼装、--port 0 降级、注入值转义', () => {
  const s = buildLaunchScript({
    logName: 'web-auto-m1x2.log',
    port: '0',
    env: { A_B: "it's" },
    patchRemoteNames: ['3f9c0d12ab34-a.yml', 'aabbccddeeff-b.yml'],
    extraArgs: ['--verbose', 'x; rm -rf ~'],
  });
  assert.ok(s.includes('--port 0 '), '降级路径命令行只含字面 0');
  assert.ok(s.includes("env A_B='it'\\''s' dsh web"));
  assert.ok(s.includes(' --patch "$HOME/.dsh_center_remote/patches/3f9c0d12ab34-a.yml"'));
  assert.ok(s.includes(' --patch "$HOME/.dsh_center_remote/patches/aabbccddeeff-b.yml"'));
  assert.ok(
    s.includes('dsh web --patch "$HOME/.dsh_center_remote/patches/3f9c0d12ab34-a.yml"'
      + ' --patch "$HOME/.dsh_center_remote/patches/aabbccddeeff-b.yml" --no-open'),
    '--patch 是启动器旗标，必须紧跟 web 排在 web app 旗标之前（真机 dsh 0.1.0-rc.7 否则报 unknown option）',
  );
  assert.ok(/--port 0 '--verbose' 'x; rm -rf ~'/.test(s), 'extraArgs 是 app 参数，留在尾部');
  assert.ok(s.includes("'x; rm -rf ~'"), '危险字符被中和为单个词');
});

test('§1.2 非法注入值/文件名/端口一律拒绝拼装', () => {
  assert.throws(() => buildLaunchScript({ logName: 'a b.log', port: 8899 }), (e) => e.code === 'VALIDATION');
  assert.throws(() => buildLaunchScript({ logName: 'x.log', port: 'abc' }), (e) => e.code === 'VALIDATION');
  assert.throws(
    () => buildLaunchScript({ logName: 'x.log', port: 8899, env: { '1BAD': 'v' } }),
    (e) => e.code === 'VALIDATION',
  );
  assert.throws(
    () => buildLaunchScript({ logName: 'x.log', port: 8899, patchRemoteNames: ['../escape'] }),
    (e) => e.code === 'VALIDATION',
  );
});

test('§1.2 POLL 模板逐字一致', () => {
  const s = buildLaunchPollScript({ logName: 'web-8899.log', pid: 60768 });
  noRawNewline(s, 'poll');
  assert.equal(
    s,
    'LOG="$HOME/.dsh_center_remote/web-8899.log"; U=$(grep -o "dsh web: http://127\\.0\\.0\\.1:[0-9][0-9]*" "$LOG" 2>/dev/null | head -n 1); if [ -n "$U" ]; then printf \'URL=%s\\n\' "$U"; fi; if kill -0 60768 2>/dev/null; then echo "ALIVE=yes"; else echo "ALIVE=no"; fi; if grep -qiE "EADDRINUSE|address already in use" "$LOG" 2>/dev/null; then echo "BIND_ERR=yes"; else echo "BIND_ERR=no"; fi; echo "POLL_DONE=yes"',
  );
});

test('§1.3 VERIFY 模板逐字一致（ARGS 包进 heredoc、LISTEN 三态、CWD 回读）', () => {
  const s = buildVerifyScript({ pid: 60768, port: 8899 });
  noRawNewline(s, 'verify');
  assert.equal(
    s,
    'A=$(ps -p 60768 -o args= 2>/dev/null); if [ -n "$A" ]; then echo "ALIVE=yes"; echo "ARGS<<EOF"; printf \'%s\\n\' "$A"; echo "EOF"; else echo "ALIVE=no"; fi; if command -v ss >/dev/null 2>&1; then if ss -ltn 2>/dev/null | grep -q ":8899 "; then echo "LISTEN=yes"; else echo "LISTEN=no"; fi; elif [ -r /proc/net/tcp ]; then if cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk -v h="22C3" \'$4=="0A" { n=split($2,a,":"); if (toupper(a[n])==h) f=1 } END { exit f?0:1 }\'; then echo "LISTEN=yes"; else echo "LISTEN=no"; fi; else echo "LISTEN=unknown"; fi; if [ -r /proc/60768/cwd ]; then printf \'CWD=%s\\n\' "$(readlink /proc/60768/cwd 2>/dev/null || echo unknown)"; else echo "CWD=unknown"; fi; echo "VERIFY_DONE=yes"',
  );
});

test('§1.3 LISTEN：无 ss 的机器回落 /proc/net/tcp，端口按大写四位十六进制匹配', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  // 端口十六进制位是判据本身：写错就会把在听的端口判成没在听。
  for (const [port, hex] of [[8899, '22C3'], [1, '0001'], [65535, 'FFFF'], [4096, '1000']]) {
    assert.match(buildVerifyScript({ pid: 60768, port }), new RegExp(`awk -v h="${hex}"`, 'u'));
  }

  const segmentOf = (port) => /(if command -v ss [\s\S]*?fi); if \[ -r \/proc\/\d+\/cwd \]/
    .exec(buildVerifyScript({ pid: 60768, port }))[1];

  const dir = await mkdtemp(join(tmpdir(), 'dshc-proc-net-'));
  try {
    // 造一份内核格式的 /proc/net/tcp：8899 在听（0A），8900 是 ESTABLISHED（01）。
    const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
    await writeFile(join(dir, 'tcp'), [
      header,
      '   0: 0100007F:22C3 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 940440931 1',
      '   1: 0100007F:22C4 0100007F:9E12 01 00000000:00000000 00:00000000 00000000     0        0 940440932 1',
      '',
    ].join('\n'), 'utf8');

    // 指向夹具，并强制关掉 ss 探测：装了 ss 的 Linux 与没装的 macOS 都只跑回落分支。
    const withFixture = (port) => segmentOf(port)
      .replace('command -v ss >/dev/null 2>&1', 'false')
      .replaceAll('/proc/net/tcp6', join(dir, 'tcp6'))
      .replaceAll('/proc/net/tcp', join(dir, 'tcp'));

    const listening = await run('sh', ['-c', withFixture(8899)]);
    assert.equal(listening.stdout.trim(), 'LISTEN=yes');

    const established = await run('sh', ['-c', withFixture(8900)]);
    assert.equal(established.stdout.trim(), 'LISTEN=no', 'ESTABLISHED（01）不是 LISTEN');

    const absent = await run('sh', ['-c', withFixture(9999)]);
    assert.equal(absent.stdout.trim(), 'LISTEN=no');

    // 夹具整体不可读时必须回 unknown，而不是被判成「没在听」。
    const unknown = await run('sh', ['-c', segmentOf(8899)
      .replace('command -v ss >/dev/null 2>&1', 'false')
      .replaceAll('/proc/net/tcp6', join(dir, 'absent6'))
      .replaceAll('/proc/net/tcp', join(dir, 'absent'))]);
    assert.equal(unknown.stdout.trim(), 'LISTEN=unknown');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§1.2 手动端口发现：无 ss/lsof 时经 /proc/<pid>/fd inode 反查回落', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const script = buildManualPortProbeScript([4242]);

  await promisify(execFile)('sh', ['-n', '-c', script]);
  assert.match(script, /elif \[ -r \/proc\/net\/tcp \]/u, 'ss 与 lsof 都缺时必须还有一档');
  assert.match(script, /function hex2dec/u, 'mawk 没有 strtonum，必须自带十六进制转换');
  assert.match(script, /\$4=="0A" && index\(ino, "," \$10 ","\)/u, 'inode 必须与 LISTEN 行对齐');
});

test('§1.3 CWD 回读段在本机 sh 下不报错（无 /proc 的 macOS 也回 unknown）', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const s = buildVerifyScript({ pid: 60768, port: 8899 });
  await promisify(execFile)('sh', ['-n', '-c', s]);

  // 只跑 CWD 段：非 Linux 上 /proc 不存在，必须走 else 分支而不是整脚本失败
  const seg = /(if \[ -r \/proc\/\d+\/cwd \][\s\S]*?fi); echo "VERIFY_DONE/.exec(s)[1];
  const { stdout } = await promisify(execFile)('sh', ['-c', seg]);
  assert.match(stdout, /^CWD=/);
});

test('§1.3 STOP 模板：指纹逐字全等比对（不含端口判据）', () => {
  const fp = 'dsh web --no-open --host 127.0.0.1 --port 0';
  const s = buildStopScript({ pid: 60768, fingerprint: fp });
  noRawNewline(s, 'stop');
  assert.ok(s.includes(`[ "$A" = ${"'"}${fp}${"'"} ]`), '必须是 [ "$A" = <shq(指纹)> ] 全等');
  assert.ok(!s.includes('case "$A"'), '不再用 *dsh*web* 粗匹配');
  assert.ok(s.includes('kill 60768 2>/dev/null; sleep 3;'));
  assert.ok(s.includes('kill -9 60768'));
  assert.ok(s.includes('KILLED=already-dead') && s.includes('KILLED=force') && s.includes('KILLED=term') && s.includes('KILLED=no'));
  assert.ok(s.endsWith('echo "STOP_DONE=yes"'));
});

test('§1.3 STOP 指纹含单引号时仍单行且可全等', () => {
  const s = buildStopScript({ pid: 1, fingerprint: "dsh web --title 'it's'" });
  noRawNewline(s, 'stop-quoted');
  assert.ok(s.includes("'\\''"));
});

test('§1.3 STOP 缺指纹拒绝拼装（防误杀）', () => {
  assert.throws(() => buildStopScript({ pid: 1, fingerprint: '' }), (e) => e.code === 'VALIDATION');
  assert.throws(() => buildStopScript({ pid: 1 }), (e) => e.code === 'VALIDATION');
});

test('§1.4 日志模板与行数校验', () => {
  assert.equal(
    buildLogTailScript({ logName: 'web-auto-m1x2.log', lines: 200 }),
    'tail -n 200 "$HOME/.dsh_center_remote/web-auto-m1x2.log" 2>/dev/null || echo "(no log)"',
  );
  assert.throws(() => buildLogTailScript({ logName: 'x.log', lines: 0 }), (e) => e.code === 'VALIDATION');
  assert.throws(() => buildLogTailScript({ logName: 'x.log', lines: 10001 }), (e) => e.code === 'VALIDATION');
});

test('§1.5 patch 清理模板：空格包裹匹配法 + 兼职 mkdir', () => {
  const s = buildPatchCleanupScript({ keepNames: ['aaa-a.yml', 'bbb-b.yml'] });
  noRawNewline(s, 'cleanup');
  assert.equal(
    s,
    'mkdir -p "$HOME/.dsh_center_remote/patches" || { echo "ERR=mkdir"; exit 9; }; cd "$HOME/.dsh_center_remote/patches" || exit 9; for f in *; do [ -e "$f" ] || continue; case " aaa-a.yml bbb-b.yml " in *" $f "*) ;; *) rm -f -- "$f" ;; esac; done; echo "CLEAN_DONE=yes"',
  );
});

test('§1.5 空清单表示全清', () => {
  const s = buildPatchCleanupScript({ keepNames: [] });
  assert.ok(s.includes('case "  " in'));
});

// ── settings.yaml 固定路径协议 ────────────────────────────────────────────

function runSh(script, { env = {}, input = Buffer.alloc(0) } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', script], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') reject(err);
    });
    child.stdin.end(input);
  });
}

test('runSh 子进程立即退出时忽略大 stdin 的 EPIPE 并按 close resolve', async () => {
  const result = await runSh('exit 0', {
    input: Buffer.alloc(16 * 1024 * 1024, 0x61),
  });
  assert.deepEqual(result, {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
  });
});

test('runSh 不吞 child spawn error', async () => {
  await assert.rejects(runSh('exit 0', { env: { PATH: '' } }), { code: 'ENOENT' });
});

function checkShSyntax(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-n', '-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

const SETTINGS_READ_SNAPSHOT = [
  'LC_ALL=C',
  'export LC_ALL',
  'umask 077',
  'set -f',
  "T='read_01'",
  'H="${DSH_HOME:-$HOME/.dsh}"',
  'P="$H/settings.yaml"',
  'R="$HOME/.dsh_center_remote"',
  'S="$R/settings-staging"',
  'SNAP="$S/read-$T.data"',
  'HEX_RAW="$S/read-$T.hex-raw"',
  'HEX="$S/read-$T.hex"',
  'unsupported() { echo "ERR=settings-unsupported"; exit 1; }',
  'read_fail() { echo "ERR=settings-read"; exit 1; }',
  'is_uint() { case "$1" in ""|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }',
  'parse_cksum() { set -- $1; [ "$#" -eq 2 ] || return 1; is_uint "$1" || return 1; is_uint "$2" || return 1; CK_CRC=$1; CK_SIZE=$2; }',
  'ensure_dir() { D=$1; if [ -L "$D" ]; then return 1; elif [ -e "$D" ]; then [ -d "$D" ] || return 1; else mkdir "$D" || return 1; fi; chmod 700 "$D" || return 1; }',
  'cleanup_staging() { set +f; rm -f "$S"/read-*.data "$S"/read-*.hex "$S"/read-*.hex-raw "$S"/write-*.data; RC=$?; set -f; return "$RC"; }',
  'cleanup_commit() { set +f; rm -f "$H"/.settings.yaml.dshc-*.tmp; RC=$?; set -f; return "$RC"; }',
  'emit_path() { printf \'%s\' "$P" | od -A n -v -t x1 > "$HEX_RAW" 2>/dev/null || read_fail; tr -d \'[:space:]\' < "$HEX_RAW" > "$HEX" || read_fail; echo "PATH_HEX<<DSHC_PATH"; cat "$HEX" || { echo; echo "DSHC_PATH"; read_fail; }; echo; echo "DSHC_PATH"; }',
  'echo "SETTINGS_PROTO=1"',
  'printf \'SETTINGS_TXN=%s\\n\' "$T"',
  'case "$HOME" in /*) ;; *) unsupported ;; esac',
  'case "$H" in /*) ;; *) unsupported ;; esac',
  'for C in command test printf mkdir chmod rm dd wc cksum od tr cat mv; do command -v "$C" >/dev/null 2>&1 || unsupported; done',
  'OD_PROBE=$(printf \'\\001\\377\' | od -A n -v -t x1 2>/dev/null | tr -d \'[:space:]\') || unsupported',
  '[ "$OD_PROBE" = 01ff ] || unsupported',
  'CK_OUT=$(printf x | cksum 2>/dev/null) || unsupported',
  'parse_cksum "$CK_OUT" || unsupported',
  '[ "$CK_CRC" = 12738659 ] && [ "$CK_SIZE" = 1 ] || unsupported',
  'ensure_dir "$R" || read_fail',
  'ensure_dir "$S" || read_fail',
  'cleanup_staging || read_fail',
  'if [ -d "$H" ]; then cleanup_commit || read_fail; fi',
  'trap \'rm -f "$SNAP" "$HEX_RAW" "$HEX"\' 0',
  'trap \'read_fail\' 1 2 3 15',
  'if [ -L "$P" ]; then read_fail; fi',
  'if [ ! -e "$P" ]; then echo "EXISTS=no"; echo "SIZE=0"; emit_path; echo "CONTENT_HEX<<DSHC_CONTENT"; echo "DSHC_CONTENT"; echo "SETTINGS_READ_DONE=yes"; exit 0; fi',
  '[ -f "$P" ] || read_fail',
  'dd if="$P" of="$SNAP" bs=524289 count=1 2>/dev/null || read_fail',
  'chmod 600 "$SNAP" || read_fail',
  'SIZE_RAW=$(wc -c < "$SNAP" 2>/dev/null) || read_fail',
  'SIZE=$(printf \'%s\' "$SIZE_RAW" | tr -d \'[:space:]\') || read_fail',
  'is_uint "$SIZE" || read_fail',
  '[ "$SIZE" -le 524288 ] || { echo "ERR=settings-too-large"; exit 10; }',
  'CK_OUT=$(cksum < "$SNAP" 2>/dev/null) || read_fail',
  'parse_cksum "$CK_OUT" || read_fail',
  '[ "$CK_SIZE" = "$SIZE" ] || read_fail',
  'echo "EXISTS=yes"',
  'printf \'SIZE=%s\\n\' "$SIZE"',
  'printf \'CRC=%s\\n\' "$CK_CRC"',
  'emit_path',
  'od -A n -v -t x1 "$SNAP" > "$HEX_RAW" 2>/dev/null || read_fail',
  'tr -d \'[:space:]\' < "$HEX_RAW" > "$HEX" || read_fail',
  'HEX_SIZE_RAW=$(wc -c < "$HEX" 2>/dev/null) || read_fail',
  'HEX_SIZE=$(printf \'%s\' "$HEX_SIZE_RAW" | tr -d \'[:space:]\') || read_fail',
  '[ "$HEX_SIZE" -eq "$((SIZE * 2))" ] || read_fail',
  'echo "CONTENT_HEX<<DSHC_CONTENT"',
  'cat "$HEX" || { echo; echo "DSHC_CONTENT"; read_fail; }',
  'echo',
  'echo "DSHC_CONTENT"',
  'echo "SETTINGS_READ_DONE=yes"',
].join('; ');

const SETTINGS_WRITE_SNAPSHOT = [
  'LC_ALL=C',
  'export LC_ALL',
  'umask 077',
  'set -f',
  "T='write_01'",
  "EXPECT='yes'",
  "BASE_CRC='123456789'",
  "BASE_SIZE='42'",
  'H="${DSH_HOME:-$HOME/.dsh}"',
  'P="$H/settings.yaml"',
  'R="$HOME/.dsh_center_remote"',
  'S="$R/settings-staging"',
  'B="$R/settings-backup"',
  'STAGE="$S/write-$T.data"',
  'TEMP="$H/.settings.yaml.dshc-$T.tmp"',
  'PREV="$B/previous.yaml"',
  'ABSENT="$B/previous.absent"',
  'BTMP="$B/previous-$T.tmp"',
  'ATMP="$B/absent-$T.tmp"',
  'COMMITTED=no',
  'commit_state() { if [ "$COMMITTED" = no ]; then echo "COMMIT_STATE=not-committed"; else echo "COMMIT_STATE=unknown"; fi; }',
  'unsupported() { echo "ERR=settings-unsupported"; exit 1; }',
  'write_fail() { echo "ERR=settings-write"; commit_state; exit 12; }',
  'stale() { echo "ERR=settings-stale"; commit_state; exit 11; }',
  'too_large() { echo "ERR=settings-too-large"; commit_state; exit 10; }',
  'is_uint() { case "$1" in ""|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }',
  'parse_cksum() { set -- $1; [ "$#" -eq 2 ] || return 1; is_uint "$1" || return 1; is_uint "$2" || return 1; CK_CRC=$1; CK_SIZE=$2; }',
  'ensure_dir() { D=$1; if [ -L "$D" ]; then return 1; elif [ -e "$D" ]; then [ -d "$D" ] || return 1; else mkdir "$D" || return 1; fi; chmod 700 "$D" || return 1; }',
  'cleanup_managed() { set +f; rm -f "$S"/read-*.data "$S"/read-*.hex "$S"/read-*.hex-raw "$S"/write-*.data "$B"/previous-*.tmp "$B"/absent-*.tmp; RC=$?; set -f; return "$RC"; }',
  'cleanup_commit() { set +f; rm -f "$H"/.settings.yaml.dshc-*.tmp; RC=$?; set -f; return "$RC"; }',
  'emit_path() { echo "PATH_HEX<<DSHC_PATH"; if printf \'%s\' "$P" | od -A n -v -t x1; then :; else echo "DSHC_PATH"; write_fail; fi; echo "DSHC_PATH"; }',
  'read_current() { CUR_EXISTS=no; CUR_CRC=; CUR_SIZE=; if [ -L "$P" ]; then return 2; fi; if [ ! -e "$P" ]; then return 0; fi; [ -f "$P" ] || return 2; CUR_RAW=$(wc -c < "$P" 2>/dev/null) || return 3; CUR_SIZE=$(printf \'%s\' "$CUR_RAW" | tr -d \'[:space:]\') || return 3; is_uint "$CUR_SIZE" || return 3; [ "$CUR_SIZE" -le 524288 ] || return 4; CUR_OUT=$(cksum < "$P" 2>/dev/null) || return 3; parse_cksum "$CUR_OUT" || return 3; [ "$CK_SIZE" = "$CUR_SIZE" ] || return 5; CUR_EXISTS=yes; CUR_CRC=$CK_CRC; CUR_SIZE=$CK_SIZE; return 0; }',
  'load_current() { read_current; RC=$?; case "$RC" in 0) return 0 ;; 4) too_large ;; 5) stale ;; *) write_fail ;; esac; }',
  'match_base() { if [ "$EXPECT" = no ]; then [ "$CUR_EXISTS" = no ]; else [ "$CUR_EXISTS" = yes ] && [ "$CUR_CRC" = "$BASE_CRC" ] && [ "$CUR_SIZE" = "$BASE_SIZE" ]; fi; }',
  'echo "SETTINGS_PROTO=1"',
  'printf \'SETTINGS_TXN=%s\\n\' "$T"',
  'case "$HOME" in /*) ;; *) unsupported ;; esac',
  'case "$H" in /*) ;; *) unsupported ;; esac',
  'for C in command test printf mkdir chmod rm dd wc cksum od tr cat mv; do command -v "$C" >/dev/null 2>&1 || unsupported; done',
  'OD_PROBE=$(printf \'\\001\\377\' | od -A n -v -t x1 2>/dev/null | tr -d \'[:space:]\') || unsupported',
  '[ "$OD_PROBE" = 01ff ] || unsupported',
  'CK_OUT=$(printf x | cksum 2>/dev/null) || unsupported',
  'parse_cksum "$CK_OUT" || unsupported',
  '[ "$CK_CRC" = 12738659 ] && [ "$CK_SIZE" = 1 ] || unsupported',
  'ensure_dir "$R" || write_fail',
  'ensure_dir "$S" || write_fail',
  'ensure_dir "$B" || write_fail',
  'for F in "$PREV" "$ABSENT"; do if [ -L "$F" ]; then write_fail; fi; if [ -e "$F" ] && [ ! -f "$F" ]; then write_fail; fi; done',
  'cleanup_managed || write_fail',
  'trap \'rm -f "$STAGE" "$TEMP" "$BTMP" "$ATMP"\' 0',
  'trap \'write_fail\' 1 2 3 15',
  'cat > "$STAGE" || write_fail',
  'chmod 600 "$STAGE" || write_fail',
  'NEW_RAW=$(wc -c < "$STAGE" 2>/dev/null) || write_fail',
  'NEW_SIZE=$(printf \'%s\' "$NEW_RAW" | tr -d \'[:space:]\') || write_fail',
  'is_uint "$NEW_SIZE" || write_fail',
  '[ "$NEW_SIZE" -le 524288 ] || too_large',
  'NEW_OUT=$(cksum < "$STAGE" 2>/dev/null) || write_fail',
  'parse_cksum "$NEW_OUT" || write_fail',
  '[ "$CK_SIZE" = "$NEW_SIZE" ] || write_fail',
  'NEW_CRC=$CK_CRC',
  'NEW_SIZE=$CK_SIZE',
  'load_current',
  'match_base || stale',
  '[ -d "$H" ] || write_fail',
  'cd "$H" || write_fail',
  'cleanup_commit || write_fail',
  'cat "$STAGE" > "$TEMP" || write_fail',
  'chmod 600 "$TEMP" || write_fail',
  'TEMP_OUT=$(cksum < "$TEMP" 2>/dev/null) || write_fail',
  'parse_cksum "$TEMP_OUT" || write_fail',
  '[ "$CK_CRC" = "$NEW_CRC" ] && [ "$CK_SIZE" = "$NEW_SIZE" ] || write_fail',
  'if [ "$CUR_EXISTS" = yes ]; then if [ -L "$P" ] || [ ! -f "$P" ]; then write_fail; fi; cat "$P" > "$BTMP" || write_fail; chmod 600 "$BTMP" || write_fail; BACK_OUT=$(cksum < "$BTMP" 2>/dev/null) || write_fail; parse_cksum "$BACK_OUT" || write_fail; [ "$CK_CRC" = "$BASE_CRC" ] && [ "$CK_SIZE" = "$BASE_SIZE" ] || stale; mv -f "$BTMP" "$PREV" || write_fail; rm -f "$ABSENT" || write_fail; else : > "$ATMP" || write_fail; chmod 600 "$ATMP" || write_fail; mv -f "$ATMP" "$ABSENT" || write_fail; rm -f "$PREV" || write_fail; fi',
  'load_current',
  'match_base || stale',
  'COMMITTED=unknown',
  'mv -f "$TEMP" "$P" || write_fail',
  'COMMITTED=yes',
  'load_current',
  '[ "$CUR_EXISTS" = yes ] || write_fail',
  '[ "$CUR_CRC" = "$NEW_CRC" ] && [ "$CUR_SIZE" = "$NEW_SIZE" ] || stale',
  'emit_path',
  'printf \'NEW_SIZE=%s\\n\' "$NEW_SIZE"',
  'printf \'NEW_CRC=%s\\n\' "$NEW_CRC"',
  'echo "SETTINGS_WRITE_DONE=yes"',
].join('; ');

test('settings READ/WRITE 模板逐字快照且保持单行', () => {
  const read = buildSettingsReadScript({ txn: 'read_01' });
  const write = buildSettingsWriteScript({
    txn: 'write_01',
    baseChecksum: 'cksum-v1:123456789:42',
  });
  noRawNewline(read, 'settings-read');
  noRawNewline(write, 'settings-write');
  assert.equal(read, SETTINGS_READ_SNAPSHOT);
  assert.equal(write, SETTINGS_WRITE_SNAPSHOT);
});

test('settings 模板严格拒绝非法 txn 与 checksum，不给注入落点', () => {
  for (const txn of ['', '.hidden', '-option', '../escape', 'a/b', 'a b', 'a;echo PWN', 'a\nb', 'a'.repeat(65), 42, null]) {
    assert.throws(
      () => buildSettingsReadScript({ txn }),
      (err) => err.code === 'VALIDATION',
      `READ 应拒绝 txn=${JSON.stringify(txn)}`,
    );
    assert.throws(
      () => buildSettingsWriteScript({ txn, baseChecksum: null }),
      (err) => err.code === 'VALIDATION',
      `WRITE 应拒绝 txn=${JSON.stringify(txn)}`,
    );
  }

  for (const baseChecksum of [
    undefined,
    '',
    'cksum-v2:1:1',
    'cksum-v1:-1:1',
    'cksum-v1:1:-1',
    'cksum-v1:01:1',
    'cksum-v1:1:01',
    'cksum-v1:4294967296:1',
    'cksum-v1:1:524289',
    'cksum-v1:1:1; echo PWN',
    123,
    {},
  ]) {
    assert.throws(
      () => buildSettingsWriteScript({ txn: 'safe', baseChecksum }),
      (err) => err.code === 'VALIDATION',
      `应拒绝 checksum=${JSON.stringify(baseChecksum)}`,
    );
  }
});

test('settings txn/checksum 边界被接受并经 shq 固定为单词', () => {
  const maxTxn = `t${'a'.repeat(63)}`;
  const read = buildSettingsReadScript({ txn: maxTxn });
  assert.ok(read.includes(`T='${maxTxn}'`));

  const max = buildSettingsWriteScript({
    txn: maxTxn,
    baseChecksum: 'cksum-v1:4294967295:524288',
  });
  assert.ok(max.includes("BASE_CRC='4294967295'"));
  assert.ok(max.includes("BASE_SIZE='524288'"));

  const absent = buildSettingsWriteScript({ txn: 'create_1', baseChecksum: null });
  assert.ok(absent.includes("EXPECT='no'"));
  assert.ok(absent.includes("BASE_CRC=''"));
  assert.ok(absent.includes("BASE_SIZE=''"));
});

test('settings 模板只用 POSIX sh 基线并可通过 sh -n', async () => {
  for (const script of [
    buildSettingsReadScript({ txn: 'syntax_read' }),
    buildSettingsWriteScript({ txn: 'syntax_write', baseChecksum: null }),
  ]) {
    assert.doesNotMatch(script, /\b(?:base64|openssl)\b/);
    assert.doesNotMatch(script, /\[\[|function\s|pipefail|<\(/);
    const result = await checkShSyntax(script);
    assert.equal(result.code, 0, result.stderr);
  }
});

test('settings 相对 DSH_HOME 以 unsupported marker 普通非零退出', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-proto-unsupported-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, DSH_HOME: 'relative-home' };

  for (const [script, input] of [
    [buildSettingsReadScript({ txn: 'unsupported_read' }), Buffer.alloc(0)],
    [buildSettingsWriteScript({ txn: 'unsupported_write', baseChecksum: null }), Buffer.from('x')],
  ]) {
    const result = await runSh(script, { env, input });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^SETTINGS_PROTO=1\nSETTINGS_TXN=unsupported_(?:read|write)\nERR=settings-unsupported\n$/);
  }
  await assert.rejects(stat(join(home, '.dsh_center_remote')), { code: 'ENOENT' });
});

test('settings READ 缺失文件返回版本、hex 固定路径、空内容与完成哨兵', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-proto-missing-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dshHome = join(home, 'dsh home');
  await mkdir(dshHome);

  const result = await runSh(buildSettingsReadScript({ txn: 'missing_read' }), {
    env: { HOME: home, DSH_HOME: dshHome },
  });
  assert.equal(result.code, 0, result.stderr);
  const out = parseProtoOutput(result.stdout, { requireDone: 'SETTINGS_READ_DONE' });
  assert.equal(kvOne(out, 'SETTINGS_PROTO'), '1');
  assert.equal(kvOne(out, 'SETTINGS_TXN'), 'missing_read');
  assert.equal(kvOne(out, 'EXISTS'), 'no');
  assert.equal(kvOne(out, 'SIZE'), '0');
  assert.equal(out.blocks.CONTENT_HEX, '');
  assert.match(out.blocks.PATH_HEX, /^[0-9a-f]+$/);
  assert.equal(
    Buffer.from(out.blocks.PATH_HEX.replace(/\s/g, ''), 'hex').toString('utf8'),
    join(dshHome, 'settings.yaml'),
  );
  assert.deepEqual(await readdir(join(home, '.dsh_center_remote/settings-staging')), []);
});

test('settings 非 POSIX cksum CRC 在读写前 unsupported，目标不动', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-proto-cksum-probe-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dshHome = join(home, '.dsh');
  const bin = join(home, 'bin');
  await mkdir(dshHome);
  await mkdir(bin);
  const target = join(dshHome, 'settings.yaml');
  await writeFile(target, 'original');
  const cksum = join(bin, 'cksum');
  await writeFile(cksum, '#!/bin/sh\ncat >/dev/null\nprintf "1 1\\n"\n');
  await chmod(cksum, 0o700);
  const env = { HOME: home, DSH_HOME: dshHome, PATH: `${bin}:${process.env.PATH}` };

  for (const [txn, script, input] of [
    ['bad_crc_read', buildSettingsReadScript({ txn: 'bad_crc_read' }), Buffer.alloc(0)],
    ['bad_crc_write', buildSettingsWriteScript({ txn: 'bad_crc_write', baseChecksum: null }), Buffer.from('new')],
  ]) {
    const result = await runSh(script, { env, input });
    assert.equal(result.code, 1);
    assert.match(result.stdout, new RegExp(`^SETTINGS_PROTO=1\\nSETTINGS_TXN=${txn}\\nERR=settings-unsupported\\n$`));
    assert.equal(await readFile(target, 'utf8'), 'original');
  }
  await assert.rejects(stat(join(home, '.dsh_center_remote')), { code: 'ENOENT' });
});

test('settings READ 以 524288/524289 字节验证有界快照与 exit 10', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-proto-read-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dshHome = join(home, '.dsh');
  await mkdir(dshHome);
  const target = join(dshHome, 'settings.yaml');
  const env = { HOME: home, DSH_HOME: dshHome };
  const script = buildSettingsReadScript({ txn: 'boundary_read' });

  await writeFile(target, Buffer.alloc(524288, 0x61));
  const oldHome = process.env.HOME;
  const oldDshHome = process.env.DSH_HOME;
  process.env.HOME = home;
  process.env.DSH_HOME = dshHome;
  const atLimit = await localExec(script, { timeoutMs: 15_000 });
  process.env.HOME = oldHome;
  if (oldDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = oldDshHome;
  assert.equal(atLimit.code, 0, atLimit.stderr);
  assert.equal(atLimit.stdoutDropped, 0);
  assert.ok(Buffer.byteLength(atLimit.stdout) < SSH_OUTPUT_CAP_BYTES);
  assert.match(atLimit.stdout, /SIZE=524288\n/);
  assert.match(atLimit.stdout, /SETTINGS_READ_DONE=yes\n/);
  const parsed = parseProtoOutput(atLimit.stdout, { requireDone: 'SETTINGS_READ_DONE' });
  const hex = parsed.blocks.CONTENT_HEX;
  assert.match(hex, /^[0-9a-f]+$/);
  assert.equal(hex.length, 524288 * 2);

  await writeFile(target, Buffer.alloc(524289, 0x61));
  const tooLarge = await runSh(script, { env });
  assert.equal(tooLarge.code, 10);
  assert.match(tooLarge.stdout, /ERR=settings-too-large\n/);
  assert.doesNotMatch(tooLarge.stdout, /CONTENT_HEX<</);
});

test('settings READ 不吞 od 运行时失败', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-proto-od-fail-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dshHome = join(home, '.dsh');
  const bin = join(home, 'bin');
  await mkdir(dshHome);
  await mkdir(bin);
  await writeFile(join(dshHome, 'settings.yaml'), 'abc');
  const od = join(bin, 'od');
  await writeFile(
    od,
    '#!/bin/sh\ncase "$*" in *read-od_fail.data*) printf aa; exit 7 ;; *) exec /usr/bin/od "$@" ;; esac\n',
  );
  await chmod(od, 0o700);
  const result = await runSh(buildSettingsReadScript({ txn: 'od_fail' }), {
    env: { HOME: home, DSH_HOME: dshHome, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /ERR=settings-read\n/);
  assert.doesNotMatch(result.stdout, /CONTENT_HEX<</);
});

test('settings WRITE 在 mv 前先进入 unknown，TERM 窗口保守报告未知', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-proto-commit-race-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dshHome = join(home, '.dsh');
  const bin = join(home, 'bin');
  await mkdir(dshHome);
  await mkdir(bin);
  const mv = join(bin, 'mv');
  await writeFile(
    mv,
    '#!/bin/sh\ndest=\nfor arg do dest=$arg; done\n/bin/mv "$@" || exit $?\ncase "$dest" in */settings.yaml) kill -TERM "$PPID" ;; esac\n',
  );
  await chmod(mv, 0o700);
  const script = buildSettingsWriteScript({ txn: 'race_1', baseChecksum: null });
  assert.ok(script.indexOf('COMMITTED=unknown') < script.indexOf('mv -f "$TEMP" "$P"'));
  assert.ok(script.indexOf('mv -f "$TEMP" "$P"') < script.indexOf('COMMITTED=yes'));

  const result = await runSh(script, {
    env: { HOME: home, DSH_HOME: dshHome, PATH: `${bin}:${process.env.PATH}` },
    input: Buffer.from('committed'),
  });
  assert.equal(result.code, 12);
  assert.match(result.stdout, /ERR=settings-write\nCOMMIT_STATE=unknown\n/);
  assert.equal(await readFile(join(dshHome, 'settings.yaml'), 'utf8'), 'committed');
});

test('settings WRITE 第二次 CAS 捕获 backup 发布后的外部写入', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-proto-second-cas-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dshHome = join(home, '.dsh');
  const bin = join(home, 'bin');
  const target = join(dshHome, 'settings.yaml');
  const staging = join(home, '.dsh_center_remote/settings-staging');
  const backup = join(home, '.dsh_center_remote/settings-backup/previous.yaml');
  await mkdir(dshHome);
  await mkdir(bin);
  await writeFile(target, 'base-content');
  const env = { HOME: home, DSH_HOME: dshHome };
  const baseline = await runSh(buildSettingsReadScript({ txn: 'cas_base_read' }), { env });
  const baseOut = parseProtoOutput(baseline.stdout, { requireDone: 'SETTINGS_READ_DONE' });
  const baseChecksum = `cksum-v1:${kvOne(baseOut, 'CRC')}:${kvOne(baseOut, 'SIZE')}`;

  const mv = join(bin, 'mv');
  await writeFile(
    mv,
    '#!/bin/sh\ndest=\nfor arg do dest=$arg; done\n/bin/mv "$@" || exit $?\ncase "$dest" in */previous.yaml) printf %s external-writer > "$TARGET_PATH" ;; esac\n',
  );
  await chmod(mv, 0o700);
  const result = await runSh(
    buildSettingsWriteScript({ txn: 'second_cas', baseChecksum }),
    {
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, TARGET_PATH: target },
      input: Buffer.from('center-new-content'),
    },
  );
  assert.equal(result.code, 11);
  assert.match(result.stdout, /ERR=settings-stale\nCOMMIT_STATE=not-committed\n/);
  assert.equal(await readFile(target, 'utf8'), 'external-writer');
  assert.equal(await readFile(backup, 'utf8'), 'base-content');
  assert.deepEqual(await readdir(staging), []);
  assert.deepEqual(
    (await readdir(dshHome)).filter((name) => name.startsWith('.settings.yaml.dshc-')),
    [],
  );
});

test('settings WRITE 正式 mv 前 TERM 报 unknown 且不提交', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-proto-before-mv-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dshHome = join(home, '.dsh');
  const bin = join(home, 'bin');
  const target = join(dshHome, 'settings.yaml');
  const staging = join(home, '.dsh_center_remote/settings-staging');
  await mkdir(dshHome);
  await mkdir(bin);
  await writeFile(target, 'old-base');
  const env = { HOME: home, DSH_HOME: dshHome };
  const baseline = await runSh(buildSettingsReadScript({ txn: 'term_base_read' }), { env });
  const baseOut = parseProtoOutput(baseline.stdout, { requireDone: 'SETTINGS_READ_DONE' });
  const baseChecksum = `cksum-v1:${kvOne(baseOut, 'CRC')}:${kvOne(baseOut, 'SIZE')}`;

  const mv = join(bin, 'mv');
  await writeFile(
    mv,
    '#!/bin/sh\ndest=\nfor arg do dest=$arg; done\ncase "$dest" in */settings.yaml) kill -TERM "$PPID"; exit 143 ;; *) exec /bin/mv "$@" ;; esac\n',
  );
  await chmod(mv, 0o700);
  const result = await runSh(
    buildSettingsWriteScript({ txn: 'term_before_mv', baseChecksum }),
    {
      env: { ...env, PATH: `${bin}:${process.env.PATH}` },
      input: Buffer.from('must-not-commit'),
    },
  );
  assert.equal(result.code, 12);
  assert.match(result.stdout, /ERR=settings-write\nCOMMIT_STATE=unknown\n/);
  assert.equal(await readFile(target, 'utf8'), 'old-base');
  assert.deepEqual(await readdir(staging), []);
  assert.deepEqual(
    (await readdir(dshHome)).filter((name) => name.startsWith('.settings.yaml.dshc-')),
    [],
  );
});

test('settings 下一次操作清理 SIGKILL 遗留且保留非 reserved 文件', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-proto-orphans-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dshHome = join(home, '.dsh');
  const staging = join(home, '.dsh_center_remote/settings-staging');
  await mkdir(dshHome);
  await mkdir(staging, { recursive: true });
  await writeFile(join(dshHome, 'settings.yaml'), 'ok');
  await writeFile(join(dshHome, '.settings.yaml.dshc-dead.tmp'), 'orphan');
  await writeFile(join(dshHome, '.settings.yaml.keep'), 'keep');
  await writeFile(join(staging, 'read-dead.data'), 'orphan');
  await writeFile(join(staging, 'read-dead.hex'), 'orphan');
  await writeFile(join(staging, 'write-dead.data'), 'orphan');
  await writeFile(join(staging, 'keep.data'), 'keep');

  const result = await runSh(buildSettingsReadScript({ txn: 'cleanup_next' }), {
    env: { HOME: home, DSH_HOME: dshHome },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readdir(staging)).sort(), ['keep.data']);
  assert.deepEqual((await readdir(dshHome)).sort(), ['.settings.yaml.keep', 'settings.yaml']);
});

test('settings WRITE 从 stdin 创建、CAS 更新、备份并保持 0600', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-proto-write-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dshHome = join(home, 'dsh home');
  await mkdir(dshHome);
  const target = join(dshHome, 'settings.yaml');
  const env = { HOME: home, DSH_HOME: dshHome };
  const original = Buffer.from('token: "$()\'\\nline"\0', 'utf8');

  const create = await runSh(
    buildSettingsWriteScript({ txn: 'create_1', baseChecksum: null }),
    { env, input: original },
  );
  assert.equal(create.code, 0, `${create.stdout}\n${create.stderr}`);
  assert.match(create.stdout, /SETTINGS_PROTO=1\n/);
  assert.match(create.stdout, /SETTINGS_TXN=create_1\n/);
  assert.match(create.stdout, /SETTINGS_WRITE_DONE=yes\n/);
  assert.deepEqual(await readFile(target), original);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  await stat(join(home, '.dsh_center_remote/settings-backup/previous.absent'));

  const crc = /NEW_CRC=(\d+)/.exec(create.stdout)[1];
  const size = /NEW_SIZE=(\d+)/.exec(create.stdout)[1];
  const replacement = Buffer.from('next: 中文\r\n', 'utf8');
  const update = await runSh(
    buildSettingsWriteScript({ txn: 'update_1', baseChecksum: `cksum-v1:${crc}:${size}` }),
    { env, input: replacement },
  );
  assert.equal(update.code, 0, `${update.stdout}\n${update.stderr}`);
  assert.deepEqual(await readFile(target), replacement);
  assert.deepEqual(
    await readFile(join(home, '.dsh_center_remote/settings-backup/previous.yaml')),
    original,
  );
  await assert.rejects(
    stat(join(home, '.dsh_center_remote/settings-backup/previous.absent')),
    { code: 'ENOENT' },
  );

  const stale = await runSh(
    buildSettingsWriteScript({ txn: 'stale_1', baseChecksum: `cksum-v1:${crc}:${size}` }),
    { env, input: Buffer.from('must not win') },
  );
  assert.equal(stale.code, 11);
  assert.match(stale.stdout, /ERR=settings-stale\nCOMMIT_STATE=not-committed\n/);
  assert.deepEqual(await readFile(target), replacement);
  assert.deepEqual(await readdir(join(home, '.dsh_center_remote/settings-staging')), []);
  assert.deepEqual(
    (await readdir(dshHome)).filter((name) => name.startsWith('.settings.yaml.dshc-')),
    [],
  );
});

test('settings WRITE 远端复核 524289 字节并拒绝目标/管理目录 symlink', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshc-proto-safety-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dshHome = join(home, '.dsh');
  await mkdir(dshHome);
  const target = join(dshHome, 'settings.yaml');
  const outside = join(home, 'outside');
  await mkdir(outside);
  const env = { HOME: home, DSH_HOME: dshHome };

  const atLimit = await runSh(
    buildSettingsWriteScript({ txn: 'limit_1', baseChecksum: null }),
    { env, input: Buffer.alloc(524288, 0x61) },
  );
  assert.equal(atLimit.code, 0, `${atLimit.stdout}\n${atLimit.stderr}`);
  assert.match(atLimit.stdout, /NEW_SIZE=524288\n/);
  await rm(target);

  const oversized = await runSh(
    buildSettingsWriteScript({ txn: 'large_1', baseChecksum: null }),
    { env, input: Buffer.alloc(524289, 0x61) },
  );
  assert.equal(oversized.code, 10);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(home, '.dsh_center_remote/settings-staging')), []);

  const secret = join(outside, 'secret');
  await writeFile(secret, 'do-not-follow');
  await symlink(secret, target);
  const readLink = await runSh(buildSettingsReadScript({ txn: 'link_read' }), { env });
  assert.equal(readLink.code, 1);
  assert.match(readLink.stdout, /ERR=settings-read\n/);
  assert.doesNotMatch(readLink.stdout, /646f2d6e6f742d666f6c6c6f77/);
  const writeLink = await runSh(
    buildSettingsWriteScript({ txn: 'link_write', baseChecksum: null }),
    { env, input: Buffer.from('overwrite') },
  );
  assert.equal(writeLink.code, 12);
  assert.equal(await readFile(secret, 'utf8'), 'do-not-follow');

  await rm(target);
  await mkdir(target);
  const readDirectory = await runSh(buildSettingsReadScript({ txn: 'dir_read' }), { env });
  assert.equal(readDirectory.code, 1);
  assert.match(readDirectory.stdout, /ERR=settings-read\n/);
  const writeDirectory = await runSh(
    buildSettingsWriteScript({ txn: 'dir_write', baseChecksum: null }),
    { env, input: Buffer.from('blocked') },
  );
  assert.equal(writeDirectory.code, 12);
  await rm(target, { recursive: true });

  await writeFile(target, 'plain');
  const managed = join(home, '.dsh_center_remote');
  await rm(managed, { recursive: true, force: true });
  await symlink(outside, managed);
  const managedLink = await runSh(buildSettingsReadScript({ txn: 'managed_read' }), { env });
  assert.equal(managedLink.code, 1);
  assert.match(managedLink.stdout, /ERR=settings-read\n/);
  const managedWrite = await runSh(
    buildSettingsWriteScript({ txn: 'managed_write', baseChecksum: null }),
    { env, input: Buffer.from('blocked') },
  );
  assert.equal(managedWrite.code, 12);
  assert.deepEqual(await readFile(target, 'utf8'), 'plain');
});
