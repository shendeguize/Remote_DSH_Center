import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProbeScript,
  buildLaunchScript,
  buildLaunchPollScript,
  buildVerifyScript,
  buildStopScript,
  buildLogTailScript,
  buildPatchCleanupScript,
  parseProtoOutput,
  parseLaunchUrl,
  kvOne,
} from '../../src/lib/proto.js';

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

test('§1.1 探测模板逐字一致', () => {
  const s = buildProbeScript();
  noRawNewline(s, 'probe');
  assert.equal(
    s,
    'echo "DSH_BIN=$(command -v dsh || echo MISSING)"; if command -v dsh >/dev/null 2>&1; then echo "DSH_VERSION=$(dsh --version 2>/dev/null | head -n 1)"; fi; H="${DSH_HOME:-$HOME/.dsh}"; printf \'DSH_HOME=%s\\n\' "$H"; if [ -d "$H/profiles/web" ]; then echo "PROFILE_WEB=yes"; else echo "PROFILE_WEB=no"; fi; echo "RUNNING_DSH_WEB<<EOF"; ps -eo pid,args | grep "[d]sh.*web" | grep -v "^ *$$ " || true; echo "EOF"; echo "PROBE_DONE=yes"',
  );
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
    'A=$(ps -p 60768 -o args= 2>/dev/null); if [ -n "$A" ]; then echo "ALIVE=yes"; echo "ARGS<<EOF"; printf \'%s\\n\' "$A"; echo "EOF"; else echo "ALIVE=no"; fi; if command -v ss >/dev/null 2>&1; then if ss -ltn 2>/dev/null | grep -q ":8899 "; then echo "LISTEN=yes"; else echo "LISTEN=no"; fi; else echo "LISTEN=unknown"; fi; if [ -r /proc/60768/cwd ]; then printf \'CWD=%s\\n\' "$(readlink /proc/60768/cwd 2>/dev/null || echo unknown)"; else echo "CWD=unknown"; fi; echo "VERIFY_DONE=yes"',
  );
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
