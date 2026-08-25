/**
 * 工程化工具链：入口判定、安装脚本、统一闸门的纯逻辑。
 *
 * 这层的价值全在「装出去以后还能不能跑」——尤其是软链入口那条：
 * 判错了不会报错，只会静悄悄退 0，什么都不做。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { isMainEntry } from '../src/lib/entry.js';
import { parseVersion } from '../src/lib/semver.js';
import {
  PACK_RULES, STAGES as CHECK_STAGES, selectStages, summarize, verifyPackFiles,
} from '../scripts/check.mjs';
import { countDeclaredTests, parseTapCensus, shortfall } from '../scripts/coverage-gate.mjs';
import {
  NODE_RUNTIME_VERSION, makeBundleInfo, nodeDistUrl, nodeShasumsUrl, nodeTarballName,
  packFileList, resolveBuildVersion, shimScript,
} from '../scripts/build-bundle.mjs';
import {
  isBrokenPipe, linkPlan, linkTarget, pathHint, prefixInPath, silenceBrokenPipe,
} from '../scripts/install.mjs';
import {
  OXLINT_MAX_ARCHIVE_BYTES, OXLINT_MAX_REDIRECTS, OXLINT_MAX_WARNINGS, OXLINT_VERSION,
  accountDownloadBytes, cachedBinaryIsTrusted, decodeOxlintArchive, downloadResponsePolicy,
  extractOxlintFromTar, installCachedOxlint, oxlintArgs, oxlintAssetName, oxlintDigests,
  oxlintDownloadUrl, oxlintPlatform, oxlintReleaseTag,
} from '../scripts/lint.mjs';
import { evaluateGuards, extractChangelogSection, versionFromTag } from '../scripts/release-guard.mjs';
import {
  evaluatePluginGuards, pluginNotesFromChangelog, versionFromPluginTag,
} from '../scripts/plugin-release-guard.mjs';
import { MAX_INSTALL_RETRIES, auditPackageFacts, readPackageFacts } from '../scripts/plugin-smoke.mjs';
import {
  evaluateS12, findChrome, findSecretInDomSnapshot, snapshotDomObservables,
} from '../scripts/ui-smoke.mjs';
import { armExitGuard } from '../scripts/lib/exit-guard.mjs';
import { Cdp } from '../scripts/lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

function workflowYamlFiles(dir = WORKFLOW_DIR) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...workflowYamlFiles(full));
    else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) files.push(full);
  }
  return files.sort();
}

function workflowRecords() {
  return workflowYamlFiles().map((file) => ({
    file,
    name: path.relative(ROOT, file),
    text: fs.readFileSync(file, 'utf8'),
  }));
}

function parseWorkflowUsesLine(line, location) {
  const body = line.trimStart();
  if (body === '' || body.startsWith('#') || /^-\s+#/.test(body)) return null;

  const hasUsesKey = /(?:["']uses["']|(?<![A-Za-z0-9_-])uses)\s*:/.test(body)
    || /^-uses\s*:/.test(body);
  if (!hasUsesKey) return null;

  const canonical = /^(?:-\s+)?uses:(.*)$/.exec(body);
  if (!canonical) {
    throw new Error(
      `${location} 的 active uses key 不符合规范 block form（- uses: …）：${line.trim()}`,
    );
  }
  return { value: canonical[1].trim() };
}

function activeWorkflowUses({ name, text }) {
  const uses = [];
  for (const [index, line] of text.split('\n').entries()) {
    const parsed = parseWorkflowUsesLine(line, `${name}:${index + 1}`);
    if (!parsed) continue;
    const commentAt = parsed.value.indexOf(' #');
    let reference = (commentAt === -1 ? parsed.value : parsed.value.slice(0, commentAt)).trim();
    const quote = reference[0];
    if ((quote === "'" || quote === '"') && reference.at(-1) === quote) {
      reference = reference.slice(1, -1);
    }
    uses.push({
      name,
      line: index + 1,
      reference,
      comment: commentAt === -1 ? '' : parsed.value.slice(commentAt + 2).trim(),
    });
  }
  return uses;
}

function actionPinProblems(uses) {
  const problems = [];
  for (const { name, line, reference, comment } of uses) {
    if (!reference.startsWith('actions/')) {
      problems.push(`${name}:${line} 不是 actions/*，无法验证 40 位 SHA pin：${reference}`);
      continue;
    }
    if (!/^actions\/[^@\s]+@[0-9a-f]{40}$/.test(reference)) {
      problems.push(`${name}:${line} 没有钉死 40 位 SHA：${reference}`);
    }
    if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\s+\S.*)?$/.test(comment)) {
      problems.push(`${name}:${line} 缺少可读版本注释：${reference}`);
    }
  }
  return problems;
}

function workflowJobChunks(text) {
  const jobsAt = text.indexOf('\njobs:');
  if (jobsAt === -1) return [];
  const body = text.slice(jobsAt);
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
  return heads.map((head, index) => ({
    id: head[1],
    text: body.slice(head.index, heads[index + 1]?.index ?? body.length),
  }));
}

function workflowStepChunks(jobText) {
  const lines = jobText.split('\n');
  const stepsAt = lines.findIndex((line) => line === '    steps:');
  if (stepsAt === -1) return [];
  const heads = [];
  for (let index = stepsAt + 1; index < lines.length; index += 1) {
    if (/^ {6}-\s/.test(lines[index])) heads.push(index);
  }
  return heads.map((from, index) => (
    lines.slice(from, heads[index + 1] ?? lines.length).join('\n')
  ));
}

function workflowStepRun(stepText) {
  const lines = stepText.split('\n');
  const runAt = lines.findIndex((line) => /^ {8}run:/.test(line));
  if (runAt === -1) return '';
  const inline = lines[runAt].slice('        run:'.length).trim();
  if (inline !== '|' && inline !== '>') return inline;
  let end = runAt + 1;
  while (end < lines.length && (/^\s*$/.test(lines[end]) || /^ {10}/.test(lines[end]))) end += 1;
  return lines.slice(runAt + 1, end).map((line) => line.slice(10)).join('\n');
}

function indentedYamlBlock(text, key, indent = 0) {
  const lines = text.split('\n');
  const prefix = ' '.repeat(indent);
  const start = lines.findIndex((line) => line.startsWith(`${prefix}${key}:`));
  if (start === -1) return '';
  let end = start + 1;
  while (end < lines.length) {
    if (/^\s*$/.test(lines[end]) || /^\s*#/.test(lines[end])) {
      end += 1;
      continue;
    }
    const leading = /^\s*/.exec(lines[end])[0].length;
    if (leading <= indent) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

function topLevelYamlBlock(text, key) {
  return indentedYamlBlock(text, key);
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-tooling-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── 入口判定 ─────────────────────────────────────────────────────────────

test('isMainEntry：直接执行算、被 import 不算、经软链执行也算', (t) => {
  const dir = tmpdir(t);
  const real = path.join(dir, 'tool.js');
  fs.writeFileSync(real, '// noop\n');
  const link = path.join(dir, 'linked');
  fs.symlinkSync(real, link);
  const url = `file://${real}`;

  assert.equal(isMainEntry(url, real), true);
  assert.equal(isMainEntry(url, link), true, '软链名与真身指同一个文件，必须算直接执行');
  assert.equal(isMainEntry(url, path.join(dir, 'other.js')), false);
  assert.equal(isMainEntry(url, undefined), false, 'REPL / 无 argv[1] 时不算');
});

test('经软链执行 dshc --help 真的有输出（PATH 安装的就是软链）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-link-'));
  const link = path.join(dir, 'dshc');
  try {
    fs.symlinkSync(CLI, link);
    const res = await new Promise((resolve, reject) => {
      const child = spawn(link, ['--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /dshc/, '软链入口必须照样打印用法，而不是静默退 0');
    assert.match(res.stdout, /生命周期/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 安装脚本 ─────────────────────────────────────────────────────────────

test('linkPlan 分清四种现状：新建 / 已就位 / 换指向 / 撞上真实文件', (t) => {
  const dir = tmpdir(t);
  const target = path.join(dir, 'cli.js');
  fs.writeFileSync(target, '');
  const link = path.join(dir, 'dshc');

  assert.equal(linkPlan(link, target).action, 'create');

  fs.symlinkSync(target, link);
  assert.equal(linkPlan(link, target).action, 'noop');

  const other = path.join(dir, 'old-cli.js');
  fs.writeFileSync(other, '');
  fs.rmSync(link);
  fs.symlinkSync(other, link);
  const relink = linkPlan(link, target);
  assert.equal(relink.action, 'relink');
  assert.equal(relink.current, other);

  const real = path.join(dir, 'real');
  fs.writeFileSync(real, '');
  assert.equal(linkPlan(real, target).action, 'conflict', '真实文件不能被悄悄覆盖');
});

test('prefixInPath 认得出前缀是否在 PATH 里（含 ~ 与尾斜杠）', () => {
  const home = os.homedir();
  const bin = path.join(home, '.local', 'bin');
  assert.equal(prefixInPath(bin, `/usr/bin:${bin}:/bin`), true);
  assert.equal(prefixInPath(bin, `/usr/bin:${bin}/:/bin`), true, '尾斜杠不该影响判定');
  assert.equal(prefixInPath(bin, '~/.local/bin:/usr/bin'), true, 'PATH 里写 ~ 也要认');
  assert.equal(prefixInPath(bin, '/usr/bin:/bin'), false);
  assert.equal(prefixInPath(bin, ''), false);
});

test('pathHint 按 shell 给对 rc 文件', () => {
  assert.match(pathHint('/opt/bin', '/bin/zsh'), /\.zshrc/);
  assert.match(pathHint('/opt/bin', '/bin/bash'), /\.bash_profile/);
  assert.match(pathHint('/opt/bin', '/usr/bin/fish'), /shell rc/);
  assert.match(pathHint('/opt/bin', '/bin/zsh'), /\/opt\/bin/);
});

test('linkTarget：git 安装指 cli.js，发布包指启动器', (t) => {
  const dir = tmpdir(t);

  const repo = path.join(dir, 'clone');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  assert.deepEqual(linkTarget(repo), {
    target: path.join(repo, 'src', 'cli.js'), channel: 'git', viaShim: false,
  });

  // 发布包必须指 bin/dshc：装的人可能压根没装 node，
  // 直接软链到 app/src/cli.js 的话 shebang 找不到解释器
  const bundleRoot = path.join(dir, 'app');
  const app = path.join(bundleRoot, 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, 'BUNDLE_INFO.json'), '{"version":"0.9.0","arch":"arm64"}');
  assert.deepEqual(linkTarget(app), {
    target: path.join(bundleRoot, 'bin', 'dshc'), channel: 'bundle', viaShim: true,
  });
});

// ── 发布包构建 ───────────────────────────────────────────────────────────

test('随包 Node 版本满足 engines.node，且是个合法版本号', () => {
  // 改这个常量等于改所有新装用户的运行时；低于 engines.node 的话装出来当场跑不动
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const min = Number(/(\d+)/.exec(pkg.engines.node)[1]);
  const parsed = parseVersion(NODE_RUNTIME_VERSION);
  assert.ok(parsed, `NODE_RUNTIME_VERSION 形状不对：${NODE_RUNTIME_VERSION}`);
  assert.ok(
    parsed.major >= min,
    `随包 Node ${NODE_RUNTIME_VERSION} 低于 engines.node（${pkg.engines.node}）`,
  );
  assert.equal(parsed.major % 2, 0, '只挑 LTS：偶数大版本');
});

test('官方 Node 发行版的名字与地址（拼错了表现是 404）', () => {
  assert.equal(nodeTarballName({ version: '22.23.2', arch: 'arm64' }), 'node-v22.23.2-darwin-arm64.tar.gz');
  assert.equal(
    nodeDistUrl({ version: '22.23.2', arch: 'x64' }),
    'https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-x64.tar.gz',
  );
  assert.equal(nodeShasumsUrl('22.23.2'), 'https://nodejs.org/dist/v22.23.2/SHASUMS256.txt');
});

test('启动器脚本：自己解软链、只用自带 node、不碰系统 node', () => {
  const shim = shimScript();
  // 装到 PATH 的是软链，$0 是软链自己的路径。不解引用就会把包根算到
  // ~/.local，然后「装好了但跑不通」——这条断言就是为了别再犯。
  assert.match(shim, /while \[ -L "\$target" \]/, '必须循环解软链');
  assert.match(shim, /readlink "\$target"/);
  assert.match(shim, /exec "\$DIR\/runtime\/bin\/node" "\$DIR\/app\/src\/cli\.js" "\$@"/);
  assert.equal(shim.includes('#!/bin/sh'), true, '用 sh 而不是 bash：别对壳做多余假设');
  assert.equal(/exec\s+node\b/.test(shim), false, '绝不能退回系统 node');
});

test('BUNDLE_INFO.json 带齐通道识别要用的字段', () => {
  const info = makeBundleInfo({
    version: '0.2.0-rc.1', arch: 'x64', sourceSha: 'abc', builtAt: '2026-08-21T00:00:00Z',
  });
  assert.deepEqual(info, {
    version: '0.2.0-rc.1',
    tag: 'v0.2.0-rc.1',
    platform: 'darwin',
    arch: 'x64',
    nodeVersion: NODE_RUNTIME_VERSION,
    sourceSha: 'abc',
    builtAt: '2026-08-21T00:00:00Z',
  });
});

test('packFileList：app/ 的内容就是打包白名单，混进 tests/ 要报错', () => {
  const ok = JSON.stringify([{ files: [...PACK_RULES.required, 'src/updater.js'].map((path_) => ({ path: path_ })) }]);
  assert.deepEqual(packFileList(ok), [...PACK_RULES.required, 'src/updater.js']);

  const leaky = JSON.stringify([{ files: [...PACK_RULES.required, 'tests/api.test.js'].map((p) => ({ path: p })) }]);
  assert.throws(() => packFileList(leaky), /混入了不该发的/);

  const short = JSON.stringify([{ files: PACK_RULES.required.filter((f) => f !== 'src/cli.js').map((p) => ({ path: p })) }]);
  assert.throws(() => packFileList(short), /缺文件/);

  assert.throws(() => packFileList('不是 json'), /无法解析/);
});

test('打包白名单含 scripts/install.mjs：发布包里要靠它摘链/装服务', () => {
  assert.ok(
    PACK_RULES.required.includes('scripts/install.mjs'),
    '安装规则只有一份，发布包必须带上它，否则卸载与 --service 在发布包安装下无从执行',
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('scripts/install.mjs'), 'package.json 的 files 也要放它进来');
});

// ── 统一闸门 ─────────────────────────────────────────────────────────────

test('selectStages：only / skip 组合，打错字要报错', () => {
  assert.deepEqual(
    selectStages(CHECK_STAGES).map((s) => s.id),
    ['lint', 'tests', 'ui', 'site', 'perf', 'pack', 'cli'],
    'lint 必须是统一闸门第一关',
  );
  assert.deepEqual(selectStages(CHECK_STAGES, { only: 'pack,cli' }).map((s) => s.id), ['pack', 'cli']);
  assert.deepEqual(
    selectStages(CHECK_STAGES, { skip: 'lint,ui' }).map((s) => s.id),
    ['tests', 'site', 'perf', 'pack', 'cli'],
  );
  assert.deepEqual(
    selectStages(CHECK_STAGES, { only: 'lint,tests,ui', skip: 'ui' }).map((s) => s.id),
    ['lint', 'tests'],
  );
  assert.throws(() => selectStages(CHECK_STAGES, { only: 'uii' }), /未知关卡：uii/);
  assert.throws(() => selectStages(CHECK_STAGES, { skip: 'browser' }), /未知关卡：browser/);
});

test('oxlint 固定版本、平台资产与 Release URL 逐字对应', () => {
  assert.equal(OXLINT_VERSION, '1.79.0');
  assert.equal(oxlintReleaseTag(), 'apps_v1.79.0');

  assert.equal(oxlintPlatform('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(oxlintAssetName('darwin', 'arm64'), 'oxlint-aarch64-apple-darwin.tar.gz');
  assert.equal(oxlintPlatform('darwin', 'x64'), 'x86_64-apple-darwin');
  assert.equal(oxlintAssetName('darwin', 'x64'), 'oxlint-x86_64-apple-darwin.tar.gz');
  assert.equal(oxlintPlatform('linux', 'x64'), 'x86_64-unknown-linux-gnu');
  assert.equal(oxlintAssetName('linux', 'x64'), 'oxlint-x86_64-unknown-linux-gnu.tar.gz');

  assert.equal(
    oxlintDownloadUrl({ platform: 'linux', arch: 'x64' }),
    'https://github.com/oxc-project/oxc/releases/download/'
      + 'apps_v1.79.0/oxlint-x86_64-unknown-linux-gnu.tar.gz',
  );
  assert.throws(() => oxlintPlatform('win32', 'x64'), /当前平台没有可用的 oxlint 1\.79\.0/);
  assert.throws(() => oxlintReleaseTag('v1.79.0'), /版本号形状不对/);
});

test('oxlint 三个平台同时固定归档与二进制摘要', () => {
  const expected = [
    ['darwin', 'arm64',
      '930e3656277ca6ad135fe7bda18e1f64886e0f8d0755df8b19cd6b499f12931b',
      '47eb5d3eaa12e2d0257708bee5150f99e6c82dc57ab6f8e6b31012a0d57aa8b1'],
    ['darwin', 'x64',
      'debd377ff3e7929743c440c6f23546a99658f7b0271725718c45197ace49bc5a',
      '2d4cbde77aead322f8f7e15de53b92c345c2c945c14db7a3f8e07472bb71ce8a'],
    ['linux', 'x64',
      'c7ddeff22c8d5ebd23648ff0917dd67a85178d86937acc3300ff4e974faaa042',
      '0e3409b31befa3a12a3332c9e222d13704cacc6427f90fbea68b8614aeedd6e1'],
  ];
  for (const [platform, arch, archiveSha256, binarySha256] of expected) {
    assert.deepEqual(oxlintDigests(platform, arch), { archiveSha256, binarySha256 });
    assert.match(archiveSha256, /^[a-f0-9]{64}$/);
    assert.match(binarySha256, /^[a-f0-9]{64}$/);
  }
});

test('oxlint 参数展示并严格限制当前 107 条警告', () => {
  assert.equal(OXLINT_MAX_WARNINGS, 107);
  assert.deepEqual(
    oxlintArgs(),
    ['--max-warnings=107', 'src', 'scripts', 'tests', 'site'],
  );
  assert.deepEqual(oxlintArgs(['src']), ['--max-warnings=107', 'src']);
});

function tarEntry(name, body = Buffer.alloc(0), {
  type = '0',
  sizeField = `${body.length.toString(8).padStart(11, '0')}\0`,
} = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(sizeField, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([header, body, padding]);
}

const tarArchive = (...entries) => Buffer.concat([...entries, Buffer.alloc(1_024)]);

function oxlintFixture(binary = Buffer.from('#!/bin/sh\nexit 0\n')) {
  const asset = 'oxlint-test-fixture.tar.gz';
  const entry = asset.slice(0, -'.tar.gz'.length);
  const compressed = gzipSync(tarArchive(tarEntry(entry, binary)));
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  return {
    asset,
    binary,
    compressed,
    archiveSha256: digest(compressed),
    binarySha256: digest(binary),
  };
}

test('oxlint tar 提取只接收指定普通文件，并核对 tar 头', () => {
  const body = Buffer.from('fake oxlint');
  const archive = tarArchive(tarEntry('oxlint-aarch64-apple-darwin', body));

  assert.deepEqual(
    extractOxlintFromTar(archive, 'oxlint-aarch64-apple-darwin'),
    body,
  );
  assert.throws(() => extractOxlintFromTar(archive, 'oxlint'), /找不到 oxlint 可执行文件/);

  const damaged = Buffer.from(archive);
  damaged[0] ^= 1;
  assert.throws(() => extractOxlintFromTar(damaged, 'oxlint-aarch64-apple-darwin'), /校验和不匹配/);
});

test('oxlint tar 拒绝越界路径、链接、重复项与畸形项', () => {
  const body = Buffer.from('binary');
  for (const unsafe of ['../oxlint', '/tmp/oxlint']) {
    assert.throws(
      () => extractOxlintFromTar(tarArchive(tarEntry(unsafe, body)), 'oxlint'),
      /不安全路径/,
    );
  }
  assert.throws(
    () => extractOxlintFromTar(tarArchive(tarEntry('oxlint', Buffer.alloc(0), { type: '2' }))),
    /不是普通文件/,
  );
  assert.throws(
    () => extractOxlintFromTar(
      tarArchive(tarEntry('oxlint', body), tarEntry('oxlint', body)),
    ),
    /多个 oxlint 文件/,
  );
  assert.throws(
    () => extractOxlintFromTar(
      tarArchive(tarEntry('oxlint', body, { sizeField: 'not-octal\0' })),
    ),
    /大小 字段损坏/,
  );
  assert.throws(
    () => extractOxlintFromTar(tarEntry('oxlint', body)),
    /结束标记缺失/,
  );
  assert.throws(
    () => extractOxlintFromTar(Buffer.concat([tarEntry('oxlint', body), Buffer.alloc(512)])),
    /结束标记损坏/,
  );
  assert.throws(
    () => extractOxlintFromTar(Buffer.concat([
      tarArchive(tarEntry('oxlint', body)), Buffer.from([1]),
    ])),
    /结束标记损坏/,
  );
});

test('oxlint gzip 解码走完整 tar 路径，损坏 gzip 明确拒绝', () => {
  const fixture = oxlintFixture();
  assert.deepEqual(
    decodeOxlintArchive(fixture.compressed, 'oxlint-test-fixture'),
    fixture.binary,
  );
  assert.throws(
    () => decodeOxlintArchive(Buffer.from('not a gzip archive'), 'oxlint-test-fixture'),
    /gzip 解压失败/,
  );
});

test('oxlint 缓存只信可执行普通文件与固定摘要', async (t) => {
  const dir = tmpdir(t);
  const binary = path.join(dir, 'oxlint');
  const bytes = Buffer.from('trusted binary');
  const digest = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(binary, bytes, { mode: 0o755 });

  assert.equal(await cachedBinaryIsTrusted(binary, digest), true);
  assert.equal(await cachedBinaryIsTrusted(binary, '0'.repeat(64)), false, '摘要不符必须拒绝');

  fs.chmodSync(binary, 0o644);
  assert.equal(await cachedBinaryIsTrusted(binary, digest), false, '不可执行文件不能命中缓存');
  fs.chmodSync(binary, 0o755);

  const link = path.join(dir, 'linked-oxlint');
  fs.symlinkSync(binary, link);
  assert.equal(await cachedBinaryIsTrusted(link, digest), false, '即使目标摘要正确，软链也必须拒绝');
  assert.equal(await cachedBinaryIsTrusted(dir, digest), false, '目录不是普通文件');

  fs.writeFileSync(binary, 'corrupted', { mode: 0o755 });
  assert.equal(await cachedBinaryIsTrusted(binary, digest), false, '缓存内容被替换后不能继续命中');
});

test('oxlint 安装最终校验分别拒绝归档摘要与二进制摘要不符', async (t) => {
  const root = tmpdir(t);
  const fixture = oxlintFixture();
  const fetchArchive = (destination) => fs.promises.writeFile(destination, fixture.compressed);

  const archiveMismatchDir = path.join(root, 'archive-mismatch');
  await assert.rejects(
    () => installCachedOxlint({
      targetDir: archiveMismatchDir,
      asset: fixture.asset,
      archiveSha256: '0'.repeat(64),
      binarySha256: fixture.binarySha256,
      fetchArchive,
    }),
    /下载校验失败/,
  );
  assert.equal(fs.existsSync(path.join(archiveMismatchDir, 'oxlint')), false);

  const binaryMismatchDir = path.join(root, 'binary-mismatch');
  await assert.rejects(
    () => installCachedOxlint({
      targetDir: binaryMismatchDir,
      asset: fixture.asset,
      archiveSha256: fixture.archiveSha256,
      binarySha256: '0'.repeat(64),
      fetchArchive,
    }),
    /二进制校验失败/,
  );
  assert.equal(fs.existsSync(path.join(binaryMismatchDir, 'oxlint')), false);
});

test('oxlint 无效缓存离线重装成功，随后可信缓存直接复用', async (t) => {
  const root = tmpdir(t);
  const targetDir = path.join(root, 'cache');
  const binaryPath = path.join(targetDir, 'oxlint');
  const fixture = oxlintFixture();
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(binaryPath, 'tampered cache', { mode: 0o755 });

  let fetches = 0;
  const fetchArchive = async (destination) => {
    fetches += 1;
    await fs.promises.writeFile(destination, fixture.compressed);
  };
  const installed = await installCachedOxlint({
    targetDir,
    asset: fixture.asset,
    archiveSha256: fixture.archiveSha256,
    binarySha256: fixture.binarySha256,
    fetchArchive,
  });
  assert.deepEqual(installed, { binaryPath, reused: false });
  assert.equal(fetches, 1);
  assert.deepEqual(fs.readFileSync(binaryPath), fixture.binary);
  assert.equal(await cachedBinaryIsTrusted(binaryPath, fixture.binarySha256), true);

  const reused = await installCachedOxlint({
    targetDir,
    asset: fixture.asset,
    archiveSha256: fixture.archiveSha256,
    binarySha256: fixture.binarySha256,
    fetchArchive,
  });
  assert.deepEqual(reused, { binaryPath, reused: true });
  assert.equal(fetches, 1, '可信缓存命中后不得再次取归档');
});

test('oxlint HTTPS 响应、重定向与体积策略在网络外可判定', () => {
  const url = 'https://github.com/oxc-project/oxc/releases/download/tag/asset';
  assert.deepEqual(
    downloadResponsePolicy({ url, status: 200, contentLength: '123' }),
    { kind: 'download', declaredBytes: 123 },
  );
  assert.deepEqual(
    downloadResponsePolicy({ url, status: 302, location: '/objects/asset', redirectsLeft: 2 }),
    { kind: 'redirect', url: 'https://github.com/objects/asset', redirectsLeft: 1 },
  );
  assert.throws(
    () => downloadResponsePolicy({ url, status: 302, location: 'http://example.com/asset' }),
    /拒绝非 HTTPS/,
  );
  assert.throws(
    () => downloadResponsePolicy({ url, status: 302, location: 'https://[' }),
    /无效重定向地址/,
  );
  assert.throws(
    () => downloadResponsePolicy({ url, status: 302, location: null }),
    /无地址/,
  );
  assert.throws(
    () => downloadResponsePolicy({
      url, status: 302, location: 'https://example.com/asset', redirectsLeft: 0,
    }),
    new RegExp(`超过 ${OXLINT_MAX_REDIRECTS} 次`),
  );
  assert.throws(() => downloadResponsePolicy({ url, status: 404 }), /HTTPS 404/);
  assert.throws(
    () => downloadResponsePolicy({
      url, status: 200, contentLength: String(OXLINT_MAX_ARCHIVE_BYTES + 1),
    }),
    /体积异常/,
  );
  assert.throws(
    () => downloadResponsePolicy({ url, status: 200, contentLength: 'not-a-number' }),
    /响应头无效/,
  );
  assert.equal(accountDownloadBytes(OXLINT_MAX_ARCHIVE_BYTES - 1, 1), OXLINT_MAX_ARCHIVE_BYTES);
  assert.throws(() => accountDownloadBytes(OXLINT_MAX_ARCHIVE_BYTES, 1), /超过/);
});

test('verifyPackFiles：该进的都在、tests 与 .local 不许混进去', () => {
  const good = [...PACK_RULES.required, 'src/lib/shq.js', 'src/web/app.js'];
  assert.equal(verifyPackFiles(good).ok, true);

  const leaky = verifyPackFiles([...good, 'tests/api.test.js', '.local/tasks/design.md']);
  assert.equal(leaky.ok, false);
  assert.deepEqual(leaky.leaked, ['tests/api.test.js', '.local/tasks/design.md']);

  const short = verifyPackFiles(good.filter((f) => f !== 'src/cli.js'));
  assert.equal(short.ok, false);
  assert.deepEqual(short.missing, ['src/cli.js']);
});

test('summarize 三种状态各有记号', () => {
  const text = summarize([
    { label: '甲', status: 'pass', note: 'ok', ms: 1_200 },
    { label: '乙', status: 'skip', note: '没装 Chrome', ms: 0 },
    { label: '丙', status: 'fail', note: '炸了', ms: 900 },
  ]);
  assert.match(text, /✔ 甲/);
  assert.match(text, /· 乙.*没装 Chrome/);
  assert.match(text, /✘ 丙.*炸了/);
  assert.match(text, /1\.2s/);
});

/**
 * 回归（issue #116）：共享 runner 上 S12 的主判据全过，但 Long Task 因机器负载达到
 * 2304/2564ms，被固定墙钟阈值单独判红。Long Task 只能留作诊断；issue #106 的
 * 148631 次 DOM 变更仍必须由与机器快慢无关的 mut 判据拦住。
 */
test('S12 判据：Long Task 只诊断，事件到达 / 行数 / DOM 变更仍严格判定', () => {
  const slowRunner = evaluateS12({
    BURST: 1_500, mut: 400, rows: 50, frames: 1_500, worstMs: 2_564,
  });
  assert.equal(slowRunner.ok, true, slowRunner.note);
  assert.match(slowRunner.note, /2564ms/);
  assert.match(slowRunner.note, /诊断|diagnostic/i, '成功说明必须明说 Long Task 仅供诊断');

  assert.equal(evaluateS12({
    BURST: 1_500, mut: 0, rows: 50, frames: 0, worstMs: 0,
  }).ok, false, '事件没到不能让后续判据空转');
  assert.equal(evaluateS12({
    BURST: 1_500, mut: 400, rows: 50, frames: 0, worstMs: 0,
  }).ok, true, 'frames 只供诊断；mut 已证明事件到达时不能扩大失败面');
  assert.equal(evaluateS12({
    BURST: 1_500, mut: 400, rows: 49, frames: 1_500, worstMs: 0,
  }).ok, false, '环形缓冲不是 50 行仍须判红');
  assert.equal(evaluateS12({
    BURST: 1_500, mut: 2_000, rows: 50, frames: 1_500, worstMs: 0,
  }).ok, false, 'mut 上界仍是严格小于 2000');
  assert.equal(evaluateS12({
    BURST: 1_500, mut: 148_631, rows: 50, frames: 1_500, worstMs: 2_278,
  }).ok, false, 'issue #106 的原始 DOM 风暴必须继续判红');
});

test('S14 secret 判据：覆盖 dialog 属性与动态表单值，但不把网络或 JS 内存算成 DOM', () => {
  const sentinel = 'SECRET-IN-DOM';
  const element = (tag, attributes = {}, value) => ({
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attributes).map(([name, attributeValue]) => ({
      name, value: attributeValue,
    })),
    ...(value === undefined ? {} : { value }),
  });
  const titled = element('div', { title: sentinel });
  const dataMarked = element('span', { 'data-preview': `prefix-${sentinel}-suffix` });
  const input = element('input', { value: 'stale-attribute' }, sentinel);
  input.type = 'password';
  const textarea = element('textarea', {}, sentinel);
  const select = element('select', {}, sentinel);
  const descendants = [titled, dataMarked, input, textarea, select];
  const dialog = {
    ...element('dialog', { 'aria-label': '批量同步' }),
    textContent: '只含安全摘要',
    querySelectorAll(selector) {
      if (selector === '*') return descendants;
      if (selector === 'input, textarea, select') return [input, textarea, select];
      throw new Error(`unexpected selector: ${selector}`);
    },
  };

  const snapshot = snapshotDomObservables(dialog);
  assert.deepEqual(
    snapshot.attributes.filter(({ value }) => value.includes(sentinel)).map(({ name }) => name),
    ['title', 'data-preview'],
    'title / data-* 等任意 attribute value 都必须进入快照',
  );
  assert.deepEqual(
    snapshot.values.map(({ tag, value }) => [tag, value]),
    [['input', sentinel], ['textarea', sentinel], ['select', sentinel]],
    '动态 value property 不会出现在 textContent/outerHTML，也必须逐类采集',
  );
  assert.deepEqual(findSecretInDomSnapshot(snapshot, sentinel), [
    'div[title]',
    'span[data-preview]',
    'input[type=password].value',
    'textarea.value',
    'select.value',
  ]);
  assert.deepEqual(findSecretInDomSnapshot({
    text: sentinel, attributes: [], values: [],
  }, sentinel), ['text'], '原有 textContent 判据也必须保留');

  assert.deepEqual(findSecretInDomSnapshot({
    text: '安全文本',
    attributes: [],
    values: [],
    networkResponse: { secret: sentinel },
    jsMemory: sentinel,
  }, sentinel), [], '网络响应与页面 JS 内存不是 dialog DOM，不应误报');
});

test('S14 secret 判据：递归覆盖 open shadow root 的文本、属性和动态 value', () => {
  const element = (tag, attributes = {}, value) => ({
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attributes).map(([name, attributeValue]) => ({
      name, value: attributeValue,
    })),
    ...(value === undefined ? {} : { value }),
  });
  const shadowAttributeSecret = 'SECRET-IN-SHADOW-ATTRIBUTE';
  const shadowInputSecret = 'SECRET-IN-SHADOW-INPUT';
  const nestedShadowTextSecret = 'SECRET-IN-NESTED-SHADOW-TEXT';

  const shadowAttribute = element('div', { 'data-preview': shadowAttributeSecret });
  const shadowInput = element('input', {}, shadowInputSecret);
  shadowInput.type = 'password';
  const nestedHost = element('nested-host');
  nestedHost.shadowRoot = {
    textContent: nestedShadowTextSecret,
    querySelectorAll: () => [],
  };
  const host = element('sync-preview');
  host.shadowRoot = {
    textContent: '安全的第一层 shadow 文本',
    querySelectorAll: () => [shadowAttribute, shadowInput, nestedHost],
  };
  const closedHost = element('closed-preview');
  closedHost.shadowRoot = null;
  closedHost.closedShadowForTest = {
    textContent: 'SECRET-IN-CLOSED-SHADOW',
    querySelectorAll: () => [],
  };
  const dialog = {
    ...element('dialog'),
    textContent: '安全的 light DOM 文本',
    querySelectorAll: () => [host, closedHost],
  };

  const snapshot = snapshotDomObservables(dialog);
  assert.deepEqual(
    findSecretInDomSnapshot(snapshot, shadowAttributeSecret),
    ['div[data-preview]'],
    'open shadow root 内的任意 attribute value 必须被扫描',
  );
  assert.deepEqual(
    findSecretInDomSnapshot(snapshot, shadowInputSecret),
    ['input[type=password].value'],
    'open shadow root 内只存在于 property 的动态 value 必须被扫描',
  );
  assert.deepEqual(
    findSecretInDomSnapshot(snapshot, nestedShadowTextSecret),
    ['text'],
    '嵌套 open shadow root 的文本必须递归进入快照',
  );
  assert.deepEqual(
    findSecretInDomSnapshot(snapshot, 'CLEAN-SECRET-NOT-IN-DOM'),
    [],
    '干净的 light/open-shadow DOM 不应误报 JS 内存里的 sentinel',
  );
  assert.deepEqual(
    findSecretInDomSnapshot(snapshot, 'SECRET-IN-CLOSED-SHADOW'),
    [],
    'closed shadow root 不暴露给 element.shadowRoot，是浏览器不可跨越的观测边界',
  );
});

/**
 * 回归（issue #76）：用例文件半途把自己进程弄死时，`node --test` 会把这个文件报成
 * 通过——后面十个用例压根没跑，闸门却是绿的。所以闸门自己要点名：声明了多少个，
 * 就必须跑了多少个。
 */
test('countDeclaredTests：数顶格声明的用例，注释与嵌套的不算', () => {
  const src = [
    "import test from 'node:test';",
    "test('甲', () => {});",
    "test.skip('乙', () => {});",
    "test.todo('丙');",
    "// test('注释掉的不算', () => {});",
    "  test('缩进的是嵌套子用例，不由这里数', () => {});",
    "const s = \"test('字符串里的不算', ...)\";",
  ].join('\n');
  assert.equal(countDeclaredTests(src), 3);
});

test('parseTapCensus：从 TAP 里读出总数与逐文件实跑数', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: tests/a.test.js',
    '    # Subtest: 甲一',
    '    ok 1 - 甲一',
    '    # Subtest: 甲二',
    '    not ok 2 - 甲二',
    'ok 1 - tests/a.test.js',
    '# Subtest: tests/b.test.js',
    '    ok 1 - 乙一',
    'ok 2 - tests/b.test.js',
    '# tests 3',
    '# pass 2',
    '# fail 1',
  ].join('\n');
  const census = parseTapCensus(tap);
  assert.equal(census.total, 3);
  assert.deepEqual(census.perFile, { 'tests/a.test.js': 2, 'tests/b.test.js': 1 });
});

test('shortfall：报出哪个文件少跑了几个，够数时闭嘴', () => {
  const declared = { 'tests/a.test.js': 22, 'tests/b.test.js': 3 };
  assert.deepEqual(shortfall(declared, { 'tests/a.test.js': 22, 'tests/b.test.js': 3 }), []);

  const gaps = shortfall(declared, { 'tests/a.test.js': 12, 'tests/b.test.js': 3 });
  assert.deepEqual(gaps, [{ file: 'tests/a.test.js', declared: 22, ran: 12 }]);

  const none = shortfall(declared, {});
  assert.deepEqual(none.map((g) => g.file), ['tests/a.test.js', 'tests/b.test.js'], '整个文件没跑也要点名');
});

// ── 版本管控 ─────────────────────────────────────────────────────────────

test('版本号与 CHANGELOG 不许脱节：package.json 的 version 必须有对应小节', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const body = extractChangelogSection(changelog, pkg.version);
  assert.notEqual(
    body,
    '',
    `CHANGELOG.md 里没有 v${pkg.version} 的小节（或正文为空）：bump 版本号时必须同步搬运 Unreleased`,
  );
});

test('versionFromTag：认 refs/tags 前缀与预发布后缀，形状不对给 null', () => {
  assert.equal(versionFromTag('refs/tags/v0.1.0'), '0.1.0');
  assert.equal(versionFromTag('v1.2.30'), '1.2.30');
  assert.equal(versionFromTag('refs/tags/v0.2.0-rc.1'), '0.2.0-rc.1', '预发布 tag 要认');
  assert.equal(versionFromTag('0.1.0'), null, '少了 v 前缀不算');
  assert.equal(versionFromTag('v0.1'), null, '必须三段');
  assert.equal(versionFromTag('v0.1.0-'), null, '空的预发布后缀不算合法版本号');
  assert.equal(
    versionFromTag('v0.1.0+build.5'), null,
    'build 元数据不参与比较，放过去只会让守卫一莫名其妙地红',
  );
  assert.equal(versionFromTag(''), null);
});

test('extractChangelogSection：截到下一个标题或链接引用区为止', () => {
  const text = [
    '# 变更记录', '',
    '## [Unreleased]', '', '- 攒着的东西', '',
    '## [0.2.0] - 2026-09-01', '', '### 新增', '- 甲', '',
    '## [0.1.0] - 2026-08-21', '', '### 新增', '- 乙', '',
    '[0.1.0]: https://example.com/tag/v0.1.0', '',
  ].join('\n');

  assert.equal(extractChangelogSection(text, '0.2.0'), '### 新增\n- 甲');
  assert.equal(extractChangelogSection(text, '0.1.0'), '### 新增\n- 乙', '链接引用区不算正文');
  assert.equal(extractChangelogSection(text, '9.9.9'), '', '没这个版本给空串');
  assert.equal(extractChangelogSection('## [0.3.0] - 今天\n\n', '0.3.0'), '', '只有标题没正文也算不合格');
});

test('evaluateGuards：三关各自能红，全过则带出正文', () => {
  const changelog = '## [0.1.0] - 2026-08-21\n\n### 新增\n- 初版\n';
  const base = {
    tag: 'v0.1.0', pkgVersion: '0.1.0', changelog, tagSha: 'a'.repeat(40), releaseSha: 'a'.repeat(40), inMain: true,
  };

  const pass = evaluateGuards(base);
  assert.equal(pass.ok, true, pass.problems.join('；'));
  assert.equal(pass.version, '0.1.0');
  assert.match(pass.body, /初版/);

  assert.match(
    evaluateGuards({ ...base, pkgVersion: '0.2.0' }).problems.join(''),
    /package\.json 的 version 是 0\.2\.0/,
    '守卫一：tag 与包版本对不上',
  );
  assert.match(
    evaluateGuards({ ...base, changelog: '## [0.9.0]\n\n- 别的版本\n' }).problems.join(''),
    /没有 v0\.1\.0 的小节/,
    '守卫二：CHANGELOG 缺小节',
  );
  assert.match(
    evaluateGuards({ ...base, releaseSha: 'b'.repeat(40) }).problems.join(''),
    /release 分支 HEAD 是/,
    '守卫三：tag 没打在 release HEAD 上',
  );
  assert.match(
    evaluateGuards({ ...base, inMain: false }).problems.join(''),
    /不在 main 上/,
    '守卫三：release 出现了 main 没有的提交',
  );
  assert.match(evaluateGuards({ ...base, tag: 'v0.1' }).problems.join(''), /不是 v/, 'tag 形状不对');
  assert.equal(pass.prerelease, false, '正式版不该被当成预发布');

  const partial = evaluateGuards({
    tag: 'v0.1.0', pkgVersion: '0.1.0', changelog,
  });
  assert.equal(partial.ok, true, '只给前两关的信息时（本地预检）不该因缺 sha 判红');
});

test('evaluateGuards：预发布不要求打在 release HEAD 上，但仍要求出自 main', () => {
  const changelog = '## [0.2.0-rc.1] - 2026-08-21\n\n### 新增\n- 试装\n';
  const rc = {
    tag: 'v0.2.0-rc.1',
    pkgVersion: '0.2.0-rc.1',
    changelog,
    tagSha: 'a'.repeat(40),
    // rc 不动稳定指针：release 分支还指着上一个正式版，这是**正常**状态
    releaseSha: 'b'.repeat(40),
    inMain: true,
  };

  const pass = evaluateGuards(rc);
  assert.equal(pass.ok, true, pass.problems.join('；'));
  assert.equal(pass.prerelease, true);
  assert.equal(pass.version, '0.2.0-rc.1');
  assert.match(pass.body, /试装/, 'rc 也得有 CHANGELOG 正文');

  assert.match(
    evaluateGuards({ ...rc, inMain: false }).problems.join(''),
    /不在 main 上/,
    'rc 也不许从野分支上凭空长出来',
  );
  assert.match(
    evaluateGuards({ ...rc, pkgVersion: '0.2.0' }).problems.join(''),
    /package\.json 的 version 是 0\.2\.0/,
    'rc 的版本号一致性一点不放松：0.2.0 与 0.2.0-rc.1 是两个版本',
  );

  // 反面：同样的 sha 错位，正式版必须红——别把豁免误伤到正式版上
  const asFinal = evaluateGuards({ ...rc, tag: 'v0.2.0', pkgVersion: '0.2.0', changelog: '## [0.2.0]\n\n- 正式\n' });
  assert.match(asFinal.problems.join(''), /正式版 tag 只许打在 release HEAD 上/);
});

// ── 插件发版守卫（plugin-v*，scripts/plugin-release-guard.mjs） ────────────

test('versionFromPluginTag：只认 plugin-v 前缀，主体 v* 与残缺形状都不算', () => {
  assert.equal(versionFromPluginTag('refs/tags/plugin-v0.1.0'), '0.1.0');
  assert.equal(versionFromPluginTag('plugin-v0.2.0-rc.1'), '0.2.0-rc.1', '预发布 tag 要认');
  assert.equal(versionFromPluginTag('v0.1.0'), null, '主体 tag 不归插件守卫管');
  assert.equal(versionFromPluginTag('plugin-0.1.0'), null, '少了 v 不算');
  assert.equal(versionFromPluginTag('plugin-v0.1'), null, '必须三段');
  assert.equal(
    versionFromPluginTag('plugin-v0.1.0+build.5'), null,
    'build 元数据不参与比较，放过去只会让守卫一莫名其妙地红',
  );
  assert.equal(versionFromPluginTag(''), null);
});

test('evaluatePluginGuards：三关各自一红一绿，全过则带出正文', () => {
  const changelog = '## [0.1.0] - 2026-08-24\n\n### 新增\n- 插件首发\n';
  const base = {
    tag: 'plugin-v0.1.0', pkgVersion: '0.1.0', changelog, inMain: true,
  };

  const pass = evaluatePluginGuards(base);
  assert.equal(pass.ok, true, pass.problems.join('；'));
  assert.equal(pass.version, '0.1.0');
  assert.equal(pass.prerelease, false);
  assert.match(pass.body, /插件首发/);

  assert.match(
    evaluatePluginGuards({ ...base, pkgVersion: '0.2.0' }).problems.join(''),
    /plugin\/package\.json 的 version 是 0\.2\.0/,
    '守卫一红：tag 与 plugin/package.json 版本对不上',
  );
  assert.match(
    evaluatePluginGuards({ ...base, changelog: '## [0.9.0]\n\n- 别的版本\n' }).problems.join(''),
    /没有 \[0\.1\.0\] 的小节/,
    '守卫二红：plugin/CHANGELOG.md 缺对应小节',
  );
  assert.match(
    evaluatePluginGuards({ ...base, changelog: '## [0.1.0] - 2026-08-24\n\n' }).problems.join(''),
    /小节正文是空的/,
    '守卫二红：只有标题没正文也算不合格',
  );
  assert.match(
    evaluatePluginGuards({ ...base, inMain: false }).problems.join(''),
    /不在 main 上/,
    '守卫三红：tag 从野分支上长出来',
  );
  assert.equal(
    evaluatePluginGuards({ ...base, inMain: null }).ok, true,
    '守卫三绿：本地预检不给 in-main 时不判（与 release-guard 同款口径）',
  );
  assert.match(
    evaluatePluginGuards({ ...base, tag: 'v0.1.0' }).problems.join(''),
    /不是 plugin-v/,
    '主体形状的 tag 直接拒：两条发版线不许互吃',
  );
});

test('evaluatePluginGuards：rc 版本一致性与 CHANGELOG 照旧，且不看 release 分支', () => {
  // 偏离主仓守卫（设计 §8.4）：插件不产出 standalone 包，判定里根本没有 release
  // 分支这个输入——rc 与正式版都只要求「出自 main」。
  const changelog = '## [0.1.1-rc.1] - 2026-08-25\n\n- 试装\n';
  const rc = evaluatePluginGuards({
    tag: 'plugin-v0.1.1-rc.1', pkgVersion: '0.1.1-rc.1', changelog, inMain: true,
  });
  assert.equal(rc.ok, true, rc.problems.join('；'));
  assert.equal(rc.prerelease, true, 'rc 判定出自 semver 那一份口径');
  assert.match(
    evaluatePluginGuards({
      tag: 'plugin-v0.1.1-rc.1', pkgVersion: '0.1.1', changelog, inMain: true,
    }).problems.join(''),
    /version 是 0\.1\.1/,
    'rc 的版本一致性一点不放松：0.1.1 与 0.1.1-rc.1 是两个版本',
  );
});

test('pluginNotesFromChangelog：--extract-notes 的正文口径', () => {
  const changelog = [
    '# Changelog — dsh-center-hub', '',
    '## [Unreleased]', '',
    '## [0.1.0] - 2026-08-24', '', '### 新增', '- 首发', '',
    '[0.1.0]: https://example.com/plugin-v0.1.0', '',
  ].join('\n');

  const hit = pluginNotesFromChangelog(changelog, 'plugin-v0.1.0');
  assert.equal(hit.ok, true, hit.problem ?? '');
  assert.equal(hit.notes, '### 新增\n- 首发', '链接引用区不算正文');

  const missing = pluginNotesFromChangelog(changelog, 'plugin-v9.9.9');
  assert.equal(missing.ok, false, '没有对应小节不能给空 release notes 蒙混过去');
  assert.match(missing.problem, /没有 \[9\.9\.9\] 的小节/);
  assert.match(
    pluginNotesFromChangelog(changelog, 'v0.1.0').problem,
    /不是 plugin-v/,
    '主体 tag 形状直接拒',
  );
});

// ── 插件安装冒烟（scripts/plugin-smoke.mjs）的断言口径 ────────────────────

test('plugin-smoke 断言：假包结构齐全则绿，缺哪样各自点名', (t) => {
  const dir = tmpdir(t);
  const write = (relPath, text) => {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  write('package.json', JSON.stringify({
    name: 'dsh-center-hub',
    version: '0.1.0',
    dsh: {
      engines: { dsh: '>=0.1.1-rc.2' },
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web' },
    },
  }));
  write('lib/index.js', 'export {};\n');
  write('lib/client.js', 'window.__ModuleLoader__.load("dsh-center-hub/client", () => {});\n');
  write('cordis.patch.yml', '- insert: []\n');

  const facts = readPackageFacts(dir);
  assert.deepEqual(
    auditPackageFacts(facts, { expectName: 'dsh-center-hub', expectVersion: '0.1.0' }),
    [],
    '三件套齐、双半区产物在、指纹对——必须绿',
  );
  assert.match(
    auditPackageFacts(facts, { expectVersion: '0.2.0' }).join('\n'),
    /装到的版本是 0\.1\.0，要的是 0\.2\.0/,
    'registry 给错版本（如 dist-tag 指飞了）要红',
  );

  const bare = auditPackageFacts({ ...facts, pkg: { name: 'dsh-center-hub', version: '0.1.0' } });
  assert.match(bare.join('\n'), /dsh\.engines\.dsh/, 'manifest 三件套缺一不可（engines）');
  assert.match(bare.join('\n'), /dsh\.bundle\.patch/, 'manifest 三件套缺一不可（bundle.patch）');
  assert.match(bare.join('\n'), /dsh\.client/, 'manifest 三件套缺一不可（client）');

  write('lib/client.js', 'module.exports = {};\n');
  assert.match(
    auditPackageFacts(readPackageFacts(dir)).join('\n'),
    /__ModuleLoader__\.load/,
    'browser 半区没按 lazy-CJS factory 构建时必须点名指纹',
  );

  fs.rmSync(path.join(dir, 'lib', 'client.js'));
  fs.rmSync(path.join(dir, 'cordis.patch.yml'));
  const gone = auditPackageFacts(readPackageFacts(dir)).join('\n');
  assert.match(gone, /包内缺 lib\/client\.js/);
  assert.match(gone, /包内缺 cordis\.patch\.yml/, 'dsh plugin add 靠它叠 bundle layer，掉出 files 白名单要当场红');

  assert.equal(MAX_INSTALL_RETRIES, 2, '网络重试上界是契约：≤2 次，绝不无限重试');
});

/**
 * 回归（先红后绿）：rc.2 的验收里拿 `--version 0.1.9` 造旧包（package.json 当时是
 * 0.2.0-rc.2），装上后 `dshc version` 一行说 0.2.0-rc.2、一行说 v0.1.9——包里两处
 * 版本源对不上，拿到包的人无从判断自己装的是什么。
 */
test('resolveBuildVersion：版本只有一个源，点名不同的版本要拦住', () => {
  assert.equal(resolveBuildVersion({ requested: null, pkgVersion: '0.2.0-rc.2' }), '0.2.0-rc.2');
  assert.equal(
    resolveBuildVersion({ requested: '0.2.0-rc.2', pkgVersion: '0.2.0-rc.2' }), '0.2.0-rc.2',
    '复述同一个版本号是允许的（当核对用）',
  );
  assert.throws(
    () => resolveBuildVersion({ requested: '0.1.9', pkgVersion: '0.2.0-rc.2' }),
    /与 package\.json 的 0\.2\.0-rc\.2 不一致/,
    '这正是造出自相矛盾的包的那条路',
  );
  assert.throws(() => resolveBuildVersion({ requested: 'v0.1', pkgVersion: '0.2.0' }), /形状不对/);
  assert.throws(() => resolveBuildVersion({ requested: null, pkgVersion: 'nope' }), /package\.json 的版本号形状不对/);
});

/**
 * 回归（先红后绿）：v0.2.0-rc.1 那次发版，build 与 verify 全绿，最后一步
 * `gh release create` 死在 "fatal: not a git repository" ——release job 故意不
 * checkout（只要上游 artifact），而 gh 会去 .git 里推断仓库。这种错只在**真推 tag**
 * 时才暴露，是最贵的暴露位置，所以拿一条用例把它钉住。
 *
 * 判据用文本切 job 而不是解析 YAML（零依赖，没有 yaml parser）：按两空格缩进的
 * job 名切段，段内出现 `gh ` 命令的，必须要么自带 checkout，要么显式给 GH_REPO。
 */
test('管道断裂的码表：只吞这三个，真写失败照抛', () => {
  for (const code of ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']) {
    assert.equal(isBrokenPipe({ code }), true, code);
  }
  for (const err of [{ code: 'ENOSPC' }, { code: 'EACCES' }, new Error('无码'), null, undefined]) {
    assert.equal(isBrokenPipe(err), false, `不该吞：${err?.code ?? err}`);
  }
});

test('silenceBrokenPipe：EPIPE 不炸，其余仍然抛出去', () => {
  const stream = new EventEmitter();
  silenceBrokenPipe([stream]);
  stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.throws(
    () => stream.emit('error', Object.assign(new Error('磁盘满了'), { code: 'ENOSPC' })),
    /磁盘满了/,
  );
});

/**
 * required check 必须真能在 PR 上产生，否则合入会永久卡在「等一个永不到来的检查」。
 *
 * 这条判据是 CI 成本管控的安全带：PR 只跑 ubuntu、合入后才补 macOS，省下来的是
 * 每个 PR 两次 macOS。代价是矩阵与 ruleset 从此耦合——谁改矩阵不改 ruleset（或反之），
 * 后果不是 CI 变红而是 PR 合不进去，这种故障最难自证，所以钉在这里。
 *
 * 同样是文本判据（零依赖无 yaml parser）：只认两种矩阵形状，形状变了就红，
 * 逼人回来重新核对 required_status_checks。
 */
export function prMatrixOsList(chunk) {
  const line = /^\s*os:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? '';
  // 形状 A：静态列表 `os: [a, b]` —— PR 上两个都跑
  if (line.startsWith('[')) return JSON.parse(line.replace(/'/g, '"'));
  // 形状 B：按事件分流的表达式 —— 取 pull_request 那一支
  const m = /event_name\s*==\s*'pull_request'\s*&&\s*fromJSON\('(\[[^']*\])'\)/.exec(line);
  return m ? JSON.parse(m[1]) : null;
}

test('workflow 发现递归覆盖根目录与子目录中的 .yml / .yaml', (t) => {
  const dir = tmpdir(t);
  fs.mkdirSync(path.join(dir, 'nested'));
  for (const file of ['root.yml', 'root.yaml', 'nested/deep.yml', 'nested/deep.yaml']) {
    fs.writeFileSync(path.join(dir, file), 'name: fixture\n');
  }
  fs.writeFileSync(path.join(dir, 'nested', 'ignored.txt'), 'not a workflow\n');

  assert.deepEqual(
    workflowYamlFiles(dir).map((file) => path.relative(dir, file)),
    ['nested/deep.yaml', 'nested/deep.yml', 'root.yaml', 'root.yml'],
  );
});

test('uses key 扫描只接受规范 block form，其余位置、引号与 flow 形态 fail closed', () => {
  const sha = 'a'.repeat(40);
  const records = activeWorkflowUses({
    name: 'fixture.yml',
    text: [
      `uses: actions/checkout@${sha} # v4.4.0`,
      `      - uses: actions/setup-node@${sha} # v4.4.0`,
      '  - uses: *checkout',
      '# uses: actions/checkout@v4',
      '    # - { uses: actions/setup-node@v4 }',
      '  - # { "uses": actions/setup-node@v4 }',
    ].join('\n'),
  });

  assert.deepEqual(
    records.map(({ line, reference }) => ({ line, reference })),
    [
      { line: 1, reference: `actions/checkout@${sha}` },
      { line: 2, reference: `actions/setup-node@${sha}` },
      { line: 3, reference: '*checkout' },
    ],
    '规范 block form 必须保留；完整注释与 sequence comment 必须忽略',
  );
  assert.match(
    actionPinProblems(records).join('\n'),
    /fixture\.yml:3 不是 actions\/\*，无法验证 40 位 SHA pin：\*checkout/,
    '规范 key 下的 alias 也不能绕过 action 白名单与 pin 校验',
  );
  for (const [ambiguous, expected] of [
    ['uses : actions/checkout@v4', /不符合规范 block form/],
    ['"uses": actions/checkout@v4', /不符合规范 block form/],
    ["- 'uses' : actions/checkout@v4", /不符合规范 block form/],
    ['uses\t: actions/checkout@v4', /不符合规范 block form/],
    ['-uses: actions/checkout@v4', /不符合规范 block form/],
    ['- { uses: actions/checkout@v4 }', /不符合规范 block form/],
    ['- { "uses": actions/checkout@v4 }', /不符合规范 block form/],
    ["- &checkout { uses: actions/checkout@v4 }", /不符合规范 block form/],
    ["- !guard { other: value, 'uses' : actions/checkout@v4 }", /不符合规范 block form/],
    ['prefix: [!tag value, { uses : actions/checkout@v4 }]', /不符合规范 block form/],
  ]) {
    assert.throws(
      () => activeWorkflowUses({ name: 'ambiguous.yml', text: ambiguous }),
      expected,
      `不得静默略过：${ambiguous}`,
    );
  }
});

test('workflow 只使用 GitHub 官方 actions，不引入第三方或本地 action', () => {
  const workflows = workflowRecords();
  const uses = workflows.flatMap(activeWorkflowUses);
  assert.ok(workflows.length >= 4, `只找到 ${workflows.length} 个 workflow，判据恐怕在空转`);
  assert.ok(uses.length > 0, 'workflow 中一个 active uses 都没找到，判据恐怕在空转');
  assert.deepEqual(
    uses.filter(({ reference }) => !reference.startsWith('actions/'))
      .map(({ name, line, reference }) => `${name}:${line} ${reference}`),
    [],
    '仓库设置只允许 actions/*；第三方、Docker 与本地 action 都不在供应链白名单内',
  );
});

test('workflow 的 actions/* 全部钉死 40 位 SHA，并紧跟可读版本注释', () => {
  const uses = workflowRecords().flatMap(activeWorkflowUses);
  assert.ok(
    uses.some(({ reference }) => reference.startsWith('actions/')),
    '没有找到 actions/*，判据恐怕在空转',
  );
  assert.deepEqual(actionPinProblems(uses), []);
});

test('actionlint 下载固定版本与官方摘要，核验后才检查全部 workflow', () => {
  const candidates = workflowRecords().flatMap(({ name, text }) => (
    workflowJobChunks(text)
      .filter(({ text: chunk }) => /actionlint_[0-9.]+_linux_amd64\.tar\.gz/.test(chunk))
      .map(({ text: chunk }) => ({ name, chunk }))
  ));
  assert.equal(candidates.length, 1, `应有且只有一个 actionlint 安装 job，实际 ${candidates.length} 个`);
  const { name, chunk } = candidates[0];
  const message = `${name} 的 actionlint 供应链契约被改动`;
  const steps = workflowStepChunks(chunk);
  const installAt = steps.findIndex((step) => /actionlint_[0-9.]+_linux_amd64\.tar\.gz/.test(step));
  const checkAt = steps.findIndex((step) => /actionlint\s+"\$\{workflow_files\[@\]\}"/.test(step));
  assert.ok(installAt >= 0, `${message}：找不到安装步骤`);
  assert.ok(checkAt > installAt, `${message}：必须先安装并核验，再执行 workflow 检查`);
  const installStep = steps[installAt];
  const checkStep = steps[checkAt];
  assert.match(installStep, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/, message);
  assert.match(
    installStep,
    /expected_sha256='8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8'/,
    message,
  );
  assert.match(installStep, /rhysd\/actionlint\/releases\/download\/v1\.7\.12\/\$archive/, message);
  const checksumAt = installStep.indexOf('sha256sum --check -');
  const extractionAt = installStep.search(
    /^\s*tar\s+-xzf\s+"\$archive_path"\s+-C\s+"\$tool_dir"\s+--\s+actionlint\s*$/m,
  );
  const executionAt = installStep.indexOf('"$tool_dir/actionlint" -version');
  assert.ok(checksumAt >= 0, `${message}：下载后必须真正核对摘要`);
  assert.ok(extractionAt > checksumAt, `${message}：必须先核对摘要，再解包`);
  assert.ok(executionAt > extractionAt, `${message}：必须先核对摘要并只解出 actionlint，再执行`);
  assert.match(checkStep, /workflow_files=\([^)]*\.github\/workflows\/\*\.yml[^)]*\)/, message);
  assert.match(checkStep, /workflow_files=\([^)]*\.github\/workflows\/\*\.yaml[^)]*\)/, message);
  assert.match(checkStep, /shopt\s+-s\s+nullglob/, `${message}：两种扩展名都不存在时不得传字面 glob`);
  assert.match(
    checkStep,
    /actionlint\s+"\$\{workflow_files\[@\]\}"/,
    `${message}：必须检查仓库里的 workflow`,
  );
});

test('PR 标题闸门只在 pull_request 上执行，并落实约定式标题契约', () => {
  const workflows = workflowRecords();
  const candidates = workflows.flatMap(({ name, text }) => (
    workflowJobChunks(text).flatMap(({ text: chunk }) => (
      workflowStepChunks(chunk)
        .filter((step) => step.includes('github.event.pull_request.title'))
        .map((step) => ({ name, text, chunk, step }))
    ))
  ));
  assert.equal(candidates.length, 1, `应有且只有一个 PR 标题闸门，实际 ${candidates.length} 个`);
  const { name, text, chunk, step } = candidates[0];
  assert.match(topLevelYamlBlock(text, 'on'), /^ {2}pull_request:\s*$/m, `${name} 必须监听 PR`);
  assert.match(
    chunk,
    /^\s+if:\s*github\.event_name\s*==\s*'pull_request'\s*$/m,
    `${name} 的标题闸门不得在非 PR 事件读取空标题`,
  );

  const env = indentedYamlBlock(step, 'env', 8);
  const titleEnv = /^ {10}([A-Za-z_][A-Za-z0-9_]*):\s*\$\{\{\s*github\.event\.pull_request\.title\s*\}\}\s*$/m.exec(env);
  assert.ok(titleEnv, `${name} 必须只经 env 把 PR 标题交给 shell`);
  const script = workflowStepRun(step);
  assert.doesNotMatch(
    script,
    /\$\{\{\s*github\.event\.pull_request\.title\s*\}\}/,
    'run 脚本不得直接插值不受信任的 PR 标题',
  );
  assert.match(
    script,
    new RegExp(`(["'])\\$${titleEnv[1]}\\1`),
    'shell 读取 PR 标题变量时必须加引号',
  );
  const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(['"])(\^.*)\2\s*$/m.exec(script);
  assert.ok(assignment, `${name} 没找到 PR 标题正则`);
  assert.equal(
    assignment[3],
    '^(feat|fix|docs|test|chore|refactor|ci)(\\([a-z0-9-]+\\))?: .+',
    'PR 标题正则的 type、可选小写 scope 与冒号空格契约必须逐项保留',
  );
  assert.match(script, new RegExp(`=~\\s*\\$${assignment[1]}\\b`), '标题正则必须真正用于失败判定');
  const titlePattern = new RegExp(assignment[3]);
  for (const type of ['feat', 'fix', 'docs', 'test', 'chore', 'refactor', 'ci']) {
    assert.match(`${type}: 有效标题`, titlePattern, `应接受 ${type} 类型`);
  }
  assert.match('fix(api-v2): 有效标题', titlePattern, '应接受小写 scope');
  for (const invalid of ['feature: 无效类型', 'Fix: 大写类型', 'fix(API): 大写 scope', 'fix 无冒号']) {
    assert.doesNotMatch(invalid, titlePattern, `不应接受：${invalid}`);
  }
});

test('每周双平台完整闸门保留固定错峰日程与最小只读权限', () => {
  const candidates = workflowRecords().filter(({ text }) => (
    /cron:\s*['"]17 3 \* \* 1['"]/.test(topLevelYamlBlock(text, 'on'))
  ));
  assert.equal(candidates.length, 1, `应有且只有一个每周检查 workflow，实际 ${candidates.length} 个`);
  const { name, text } = candidates[0];
  const on = topLevelYamlBlock(text, 'on');
  const permissions = topLevelYamlBlock(text, 'permissions');
  const concurrency = topLevelYamlBlock(text, 'concurrency');
  assert.match(on, /^ {2}schedule:\s*$/m, `${name} 必须由 schedule 触发`);
  assert.match(on, /^ {2}workflow_dispatch:\s*$/m, `${name} 必须保留手动补跑入口`);
  assert.match(permissions, /^ {2}contents:\s*read\s*$/m, `${name} 只需读取仓库内容`);
  assert.doesNotMatch(permissions, /:\s*write\s*$/m, `${name} 不应获得写权限`);
  assert.match(concurrency, /^ {2}group:\s*\S+\s*$/m, `${name} 必须有顶层并发组`);
  assert.match(
    concurrency,
    /^ {2}cancel-in-progress:\s*true\s*$/m,
    `${name} 必须取消同组旧周检，避免定时与手动补跑叠加`,
  );
  assert.match(text, /os:\s*\[[^\]]*ubuntu-latest[^\]]*\]/, `${name} 必须覆盖 Ubuntu`);
  assert.match(text, /os:\s*\[[^\]]*macos-latest[^\]]*\]/, `${name} 必须覆盖 macOS`);
  const checkJob = workflowJobChunks(text).find(({ text: chunk }) => (
    /os:\s*\[[^\]]*ubuntu-latest[^\]]*macos-latest/.test(chunk)
  ));
  const checkStep = workflowStepChunks(checkJob?.text ?? '')
    .find((step) => workflowStepRun(step).includes('npm run check'));
  assert.ok(checkStep, `${name} 必须执行完整质量闸门`);
  // Ubuntu 那支既要真跑浏览器，又要把墙钟那关降成 advisory——基线是在 macOS 上录的，
  // 拿它判 ubuntu 等于在量两个平台的机器差异。macOS 那支不带旗标，即严格模式。
  assert.match(
    workflowStepRun(checkStep),
    /\$\{\{\s*matrix\.os\s*==\s*'ubuntu-latest'\s*&&\s*'-- --require-browser --perf-advisory'\s*\|\|\s*''\s*\}\}/,
    `${name} 必须要求 Ubuntu 真跑浏览器且墙钟只告警，macOS 可按环境省略`,
  );
});

test('Release 在发布 tar.gz 前生成 GitHub 构建溯源证明', () => {
  const candidates = workflowRecords().flatMap(({ name, text }) => (
    workflowJobChunks(text)
      .filter(({ text: chunk }) => chunk.includes('actions/attest-build-provenance@'))
      .map(({ text: chunk }) => ({ name, chunk }))
  ));
  assert.equal(candidates.length, 1, `应有且只有一个 Release 溯源 job，实际 ${candidates.length} 个`);
  const { name, chunk } = candidates[0];
  const message = `${name} 的 Release 溯源契约被移除`;
  const steps = workflowStepChunks(chunk);
  const bundleDownloadAt = steps.findIndex((step) => (
    /^ {6}-\s+uses:\s*actions\/download-artifact@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+\s*$/m.test(step)
      && /^ {10}name:\s*bundles\s*$/m.test(indentedYamlBlock(step, 'with', 8))
  ));
  const attestationAt = steps.findIndex((step) => (
    /^ {8}uses:\s*actions\/attest-build-provenance@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+\s*$/m.test(step)
  ));
  const releaseAt = steps.findIndex((step) => workflowStepRun(step).includes('gh release create'));
  assert.ok(bundleDownloadAt >= 0, `${message}：找不到 bundles 下载步骤`);
  assert.ok(attestationAt > bundleDownloadAt, `${message}：必须先下载 bundles，再生成证明`);
  assert.ok(releaseAt > attestationAt, `${message}：必须先生成证明，再创建 Release`);

  const attestationStep = steps[attestationAt];
  const subjects = indentedYamlBlock(
    indentedYamlBlock(attestationStep, 'with', 8),
    'subject-path',
    10,
  ).split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(
    subjects,
    ['dist/*.tar.gz', 'dist/SHA256SUMS'],
    `${message}：subject-path 必须绑定发布包与校验和清单`,
  );
  assert.match(chunk, /^ {4}permissions:\s*$/m, message);
  assert.match(chunk, /^ {6}contents:\s*write\s*$/m, message);
  assert.match(chunk, /^ {6}id-token:\s*write\s*$/m, message);
  assert.match(chunk, /^ {6}attestations:\s*write\s*$/m, message);
});

test('required check 与 PR 上真会跑的矩阵一致（改一边忘另一边就红）', () => {
  const ruleset = JSON.parse(fs.readFileSync(path.join(ROOT, '.github', 'rulesets', 'main.json'), 'utf8'));
  const checks = ruleset.rules.find((r) => r.type === 'required_status_checks');
  const contexts = checks.parameters.required_status_checks.map((c) => c.context);
  assert.ok(contexts.length > 0, 'main 分支一个 required check 都没有，闸门等于没设');

  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(text.slice(0, text.indexOf('jobs:')), /pull_request/, 'CI 必须在 PR 上触发');

  const osList = prMatrixOsList(text.slice(text.indexOf('\njobs:')));
  assert.ok(osList, 'ci.yml 的 os 矩阵不是已知形状，请回来核对 required_status_checks');

  // 矩阵 job 的 context 带 `(os)` 后缀，独立 job 就是 job id 本身。两类分开核对：
  // 矩阵那一半必须与 PR 上真跑的 os 列表逐字相等，独立那一半必须真存在且在 PR 上会跑
  // ——required 名单里多一个永不到来的检查，合入就永久卡住。
  const jobs = new Map(workflowJobChunks(text).map((job) => [job.id, job.text]));
  const matrixContexts = contexts.filter((c) => c.startsWith('check ('));
  const plainContexts = contexts.filter((c) => !c.startsWith('check ('));

  assert.deepEqual(
    [...matrixContexts].sort(),
    osList.map((o) => `check (${o})`).sort(),
    'required check 与 PR 上真会跑的 job 名对不上：合入会卡在等一个永不到来的检查',
  );

  const problems = [];
  for (const context of plainContexts) {
    const chunk = jobs.get(context);
    if (chunk === undefined) {
      problems.push(`${context}：ci.yml 里没有这个 job`);
      continue;
    }
    if (/^\s{4}strategy:/m.test(chunk)) {
      problems.push(`${context}：这个 job 带 matrix，context 名会是「${context} (…)」而不是裸名`);
    }
    const guard = /^\s{4}if:\s*(.+)$/m.exec(chunk)?.[1];
    if (guard && !guard.includes('pull_request')) {
      problems.push(`${context}：if 条件「${guard}」在 PR 上未必成立，required 会等不到它`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(plainContexts.includes('plugin'), 'plugin lane 是 required check（CONTRIBUTING §GitHub 侧配置）');
});

test('release ruleset 不设 required_status_checks（设了就永远推不动）', () => {
  // required status check 是**按分支**算的：`release` 只做 `--ff-only` 快进，自己
  // 不触发任何 CI，于是那两个 context 在 release 这个 ref 上永远不会出现——哪怕同一个
  // commit 在 main 上已经全绿，推 release 也会被拒。真放这条规则，唯一的过法就是每次
  // 发版临时把保护关掉，等于把「保护」训练成一个习惯性绕过的摆设。
  //
  // 保护并没有变弱：release 只从 main 快进，而 main 那边 required check 是设了的
  // （上一条用例盯着）；deletion / non_fast_forward / linear history 三条仍在。
  const ruleset = JSON.parse(fs.readFileSync(path.join(ROOT, '.github', 'rulesets', 'release.json'), 'utf8'));
  const types = ruleset.rules.map((r) => r.type);
  assert.ok(!types.includes('required_status_checks'), types.join(' / '));
  for (const must of ['deletion', 'non_fast_forward', 'required_linear_history']) {
    assert.ok(types.includes(must), `release 分支少了 ${must} 保护`);
  }
  assert.deepEqual(ruleset.bypass_actors, [], 'bypass_actors 恒空：规则对本人同样生效');
  assert.equal(ruleset.enforcement, 'active');
});

test('workflow 里用 gh 的 job：要么有 checkout，要么显式给 GH_REPO', () => {
  const workflows = workflowRecords();
  assert.ok(workflows.length >= 2, `只找到 ${workflows.length} 个 workflow，判据恐怕在空转`);

  const problems = [];
  for (const { name, text } of workflows) {
    for (const { id, text: chunk } of workflowJobChunks(text)) {
      if (!/(^|\s)gh\s+\w/.test(chunk)) continue;
      if (/actions\/checkout@/.test(chunk) || /GH_REPO:/.test(chunk)) continue;
      problems.push(`${name} 的 job「${id}」跑了 gh 却既没 checkout 也没给 GH_REPO`);
    }
  }
  assert.deepEqual(problems, []);
});

/**
 * CI 上偶发「Chrome 未在 20s 内报出调试端口」判红，本机从不复现——共享 runner 的
 * 冷启动能被 IO 拖到二十几秒。放宽之外更要紧的是：超时消息必须把 Chrome 自己的
 * stderr 带出来，否则分不清是慢、是缺库、还是沙箱起不来（那三种处置完全不同）。
 */
/**
 * Chrome 起不来时，最有价值的信息在它自己的 stderr 里（缺库 / 沙箱 / 权限，
 * 三种处置完全不同）。这条用例走「说完就退」这条确定性路径：
 * 早先版本靠掐表等超时，全量并发跑时 spawn 自己就能吃掉那点预算，红得毫无信息量。
 */
test('launchChrome 失败：错误里带上 Chrome 自己的输出', async (t) => {
  const { launchChrome } = await import('../scripts/lib/browser.mjs');
  const scratch = tmpdir(t);
  const fake = path.join(scratch, 'fake-chrome');
  fs.writeFileSync(fake, '#!/bin/sh\necho "libnss3.so: cannot open shared object file" >&2\nexit 127\n');
  fs.chmodSync(fake, 0o755);

  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    await assert.rejects(
      () => launchChrome({ env: { DSHC_CHROME: fake } }),
      (err) => {
        assert.match(err.message, /Chrome 退出（code 127）/, '该说清是退出了、退了几号');
        assert.match(err.message, /Chrome 说：/, '没把 Chrome 的自述带出来');
        assert.match(err.message, /libnss3/, '丢了真正有诊断价值的那一行');
        return true;
      },
    );
    assert.deepEqual(
      fs.readdirSync(scratch).filter((name) => name.startsWith('dshc-chrome-')),
      [],
      '启动失败也要回收刚建的临时 profile',
    );
  } finally {
    if (oldTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmp;
  }
});

test('launchChrome 收尾：等进程退出再删 profile，重复调用也安全', async (t) => {
  const { launchChrome } = await import('../scripts/lib/browser.mjs');
  const scratch = tmpdir(t);
  const fake = path.join(scratch, 'fake-chrome');
  fs.writeFileSync(fake, `#!/usr/bin/env node
process.stderr.write('DevTools listening on ws://127.0.0.1:65535/devtools/browser/fake\\n');
setInterval(() => {}, 1_000);
`);
  fs.chmodSync(fake, 0o755);

  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  let chrome = null;
  try {
    chrome = await launchChrome({ env: { DSHC_CHROME: fake } });
    assert.equal(
      fs.readdirSync(scratch).filter((name) => name.startsWith('dshc-chrome-')).length,
      1,
      'Chrome 活着时 profile 必须存在',
    );
    await chrome.kill();
    await chrome.kill();
    assert.deepEqual(
      fs.readdirSync(scratch).filter((name) => name.startsWith('dshc-chrome-')),
      [],
      'Chrome 退出后不该留下空 profile',
    );
  } finally {
    await chrome?.kill();
    if (oldTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmp;
  }
});

test('findChrome：显式指定优先，找不到给 null', () => {
  const exists = (p) => ['/usr/bin/chromium', '/custom/chrome'].includes(p);
  assert.equal(findChrome({ env: { DSHC_CHROME: '/custom/chrome' }, exists }), '/custom/chrome');
  assert.equal(findChrome({ env: {}, exists }), '/usr/bin/chromium', '没指定就按常见落点找');
  assert.equal(findChrome({ env: {}, exists: () => false }), null);
  assert.equal(
    findChrome({ env: { DSHC_CHROME: '/gone' }, exists }),
    '/usr/bin/chromium',
    '指定的路径不存在时要继续往下找，而不是直接放弃',
  );
});

/**
 * 冒烟把结论都打完了却不退（issue #112）：Chrome 的旁支（crashpad 之类）继承着我们
 * 那根 stderr 的写端，SIGKILL 只打主进程，读端的 PipeWrap 于是把事件循环钉住。
 * CI 上这不是「慢一点」，是烧到 job 超时、退出码根本传不出去。
 */
test('收尾兜底：到点还有句柄拖着就报出句柄名并硬退，带上原本的退出码', () => {
  let armed = null;
  const said = [];
  const exited = [];
  const timer = armExitGuard({
    graceMs: 1_234,
    setTimer: (fn, ms) => { armed = { fn, ms }; return { unref() { this.unrefed = true; } }; },
    resources: () => ['PipeWrap', 'Timeout', 'Timeout'],
    log: (m) => said.push(m),
    exit: (c) => exited.push(c),
    code: () => 1,
  });
  assert.equal(armed.ms, 1_234);
  assert.equal(timer.unrefed, true, '保险自己不许把干净的收场多拖 3 秒——必须 unref');

  armed.fn();
  assert.deepEqual(exited, [1], '硬退要带上原本的退出码，否则 CI 判不出红');
  assert.match(said[0], /3 个句柄/);
  assert.match(said[0], /PipeWrap/, '要报出句柄名，下次才查得下去');
  assert.doesNotMatch(said[0], /Timeout、Timeout/, '同名句柄不必重复念');
});

test('收尾兜底：问不出句柄名也照样退，不许在兜底里自己抛', () => {
  let armed = null;
  const exited = [];
  armExitGuard({
    setTimer: (fn, ms) => { armed = { fn, ms }; return {}; },
    resources: () => [],
    log: () => {},
    exit: (c) => exited.push(c),
    code: () => 0,
  });
  assert.equal(armed.ms, 3_000, '默认宽限期');
  armed.fn();
  assert.deepEqual(exited, [0]);
});

/**
 * 每发一条 CDP 就留一个 20s 的活句柄，一趟冒烟发上千条：收尾时实测残着 25 个
 * Timeout，白等最后一批到点（issue #112）。
 */
test('CDP：应答到手就把超时定时器清掉', async () => {
  const sent = [];
  const ws = { send: (raw) => sent.push(JSON.parse(raw)), addEventListener() {}, close() {} };
  const cdp = new Cdp(ws);
  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

  const p = cdp.send('Runtime.evaluate', { expression: '1' });
  assert.equal(sent[0].method, 'Runtime.evaluate');
  assert.equal(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length, before + 1,
    '在飞期间该有一个超时定时器守着');

  cdp.pending.get(sent[0].id).resolve({ result: { value: 1 } });
  await p;
  assert.equal(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length, before,
    '应答到手了还留着定时器 = 收尾要空等 20s');
});
