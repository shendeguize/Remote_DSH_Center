/**
 * 架构护栏（ENG-24）：依赖图无环 + 分层不倒挂 + 零 npm 依赖。
 *
 * 11 §1 把模块签名与依赖方向定死了；这些约束一旦破了，
 * 表现是「某天 import 顺序一改就炸」这类极难定位的问题，所以让测试盯住。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  aggregateDiagnostics, coverageVerdict, evaluateTiers, findCoverageSuppressions, formatReport,
  missingSourceFiles, parseLcov, sourceJsFiles, TIERS,
} from '../scripts/coverage-gate.mjs';
import {
  apiRoutesFrom, cliCommandsFrom, collectInventory, protoExitCodesFrom, SURFACES,
} from '../scripts/lib/inventory.mjs';
import {
  formatVerdict, globHasMatch, matrixVerdict, parseBadExemptions, parseFileRefs, parseRegistrations,
} from '../scripts/matrix-gate.mjs';
import { isCodeSpan, scanJs } from '../scripts/lib/js-scan.mjs';
import { OPERATORS, applyMutant, enumerateMutants } from '../scripts/lib/mutants.mjs';
import {
  ALLOWED_FILE, TARGETS as MUTATION_TARGETS, buildImportGraph,
  formatVerdict as formatMutation, interleaveByFile, mutationVerdict, parseAllowed, testSetResolver,
} from '../scripts/mutation-gate.mjs';
import {
  NOISE_FLOOR_MS, REPEATS, TOLERANCE, formatVerdict as formatPerf, median, perfVerdict,
} from '../scripts/perf-gate.mjs';
import { SCENARIOS as PERF_SCENARIOS } from './perf/scenarios.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

/** 静态 import + 动态 import() 都算依赖（动态 import 一样能成环）。 */
function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const specs = [
    ...text.matchAll(/^\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/gm),
    ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  return specs;
}

const files = walk(SRC);

test('src 内部依赖图无环', () => {
  const graph = new Map();
  for (const file of files) {
    const deps = [];
    for (const spec of importsOf(file)) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      const target = fs.existsSync(resolved) ? resolved : `${resolved}.js`;
      assert.ok(fs.existsSync(target), `${rel(file)} 指向不存在的模块 ${spec}`);
      deps.push(rel(target));
    }
    graph.set(rel(file), deps);
  }

  // 深度优先找回边，报错时把整条环路打出来——不然只知道「有环」没法修
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(node)), node].join(' → ');
      assert.fail(`依赖成环：${cycle}`);
    }
    state.set(node, 'visiting');
    stack.push(node);
    for (const dep of graph.get(node) ?? []) visit(dep);
    stack.pop();
    state.set(node, 'done');
  };
  for (const node of graph.keys()) visit(node);
});

test('分层不倒挂：lib 不依赖上层，前端不依赖后端', () => {
  for (const file of files) {
    const name = rel(file);
    const deps = importsOf(file).filter((s) => s.startsWith('.'));

    if (name.startsWith('src/lib/')) {
      for (const dep of deps) {
        const resolved = rel(path.resolve(path.dirname(file), dep));
        // defaults.js 是常量表（自身零依赖），算第 0 层，允许内核引用
        assert.ok(
          resolved.startsWith('src/lib/') || resolved === 'src/defaults.js',
          `${name} 不该反向依赖上层模块（${resolved}）：lib 是纯内核`,
        );
      }
    }

    if (name.startsWith('src/web/')) {
      for (const dep of deps) {
        const resolved = rel(path.resolve(path.dirname(file), dep));
        assert.ok(
          resolved.startsWith('src/web/'),
          `${name} 引了后端模块 ${resolved}：页面代码只能依赖 src/web/**`,
        );
      }
    }
  }
});

test('前端代码不碰 node 内置模块（浏览器要能直接跑）', () => {
  for (const file of files.filter((f) => rel(f).startsWith('src/web/'))) {
    for (const spec of importsOf(file)) {
      assert.ok(!spec.startsWith('node:'), `${rel(file)} 引了 ${spec}`);
    }
  }
});

test('src/**/*.js 不使用 coverage suppression pragma（防止静态缩小覆盖率分母）', () => {
  sourceJsFiles(ROOT);
});

test('零 npm 依赖：不引任何裸包名', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, '运行时不许有依赖');
  assert.equal(pkg.devDependencies, undefined, '测试也不许有依赖');

  const all = [...files, ...walk(path.join(ROOT, 'tests'))];
  for (const file of all) {
    for (const spec of importsOf(file)) {
      const bare = !spec.startsWith('.') && !spec.startsWith('node:') && !spec.startsWith('/');
      assert.equal(bare, false, `${rel(file)} 引了三方包 ${spec}`);
    }
  }
});

test('后端不拿墙钟算流逝：Date.now() 只许留在标注了「墙钟」的展示位（issue #104）', () => {
  // 墙钟会跳（NTP 步进校时、休眠唤醒、改时间、双启动写坏 RTC），拿它算上界等于没有上界：
  // 一次 60s 回拨就能把「8s 未就绪」拖成 68s。凡是「过了多久 / 还剩多久」都得用
  // src/lib/clock.js 的单调钟；剩下的展示位（时间戳、文件名、token）必须就地标注，
  // 否则下一个 `deadline = Date.now() + x` 会悄悄溜回来。
  const offenders = [];
  for (const file of files) {
    const r = rel(file);
    if (r.startsWith('src/web/') || r === 'src/lib/clock.js') continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('Date.now()')) return;
      if (line.includes('墙钟')) return;
      offenders.push(`${r}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `拿墙钟算流逝，或忘了标注为展示位：\n${offenders.join('\n')}`);
});

test('defaults.js 保持零依赖：lib 引它才成立', () => {
  assert.deepEqual(importsOf(path.join(SRC, 'defaults.js')).filter((s) => s.startsWith('.')), []);
});

test('前端不留第二份出厂默认表：源码里搜不到运行期端口常量（UI-28）', () => {
  // 一切运行参数只认 config.json，代码里只有 src/defaults.js 一张出厂表。前端抄一份
  // 端口常量迟早和后端对不上，而且是「看着对、跑起来不对」的那种错。
  const factory = fs.readFileSync(path.join(SRC, 'defaults.js'), 'utf8');
  const numbers = [...factory.matchAll(/\b(\d{4,5})\b/g)].map((m) => m[1]);
  const ports = [...new Set(numbers)].filter((n) => Number(n) >= 1024 && Number(n) <= 65535);
  assert.ok(ports.length >= 3, `出厂表里应有 manager/远端/区间端口，实际取到 ${ports.join(',')}`);

  // 只查代码位：注释与文案里出现「如 17701-17799」这类举例是允许的
  const codeOnly = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")
    .replace(/_/g, ''); // 17_701 与 17701 视同

  for (const file of walk(path.join(SRC, 'web'))) {
    const text = codeOnly(fs.readFileSync(file, 'utf8'));
    for (const p of ports) {
      assert.equal(text.includes(p), false, `${rel(file)} 硬编码了运行期端口 ${p}，改成读后端下发值`);
    }
  }
});

test('前端不把 querySelectorAll 的结果当数组使（NodeList 没有那些方法）', () => {
  // 这条只能静态查：`tests/web/dom-shim.js` 的 querySelectorAll 返回真数组，
  // 于是 `items.indexOf(...)` 在单测里一路绿、在真浏览器里当场 TypeError。
  // 真出过一次——右键菜单的方向键因此整套失效（issue #41）。
  const ARRAY_ONLY = ['indexOf', 'map', 'filter', 'find', 'findIndex', 'some', 'every', 'slice', 'reduce', 'includes', 'at', 'sort', 'reverse', 'join'];
  const bad = [];
  for (const file of walk(path.join(SRC, 'web'))) {
    const text = fs.readFileSync(file, 'utf8');
    // 直接串在调用后面的：qsa(...).map(...)
    for (const m of text.matchAll(/querySelectorAll\([^;]*?\)\s*\.\s*([A-Za-z]+)/g)) {
      if (ARRAY_ONLY.includes(m[1])) bad.push(`${rel(file)}: querySelectorAll(...).${m[1]}`);
    }
    // 先存进变量再当数组使：const items = x.querySelectorAll(...)  →  items.map(...)
    for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?querySelectorAll\(/g)) {
      const name = m[1];
      const spread = new RegExp(`=\\s*\\[\\s*\\.\\.\\.[^;\\n]*querySelectorAll`).test(m[0]);
      if (spread) continue;
      const used = new RegExp(`\\b${name}\\s*\\.\\s*(${ARRAY_ONLY.join('|')})\\b`).exec(text);
      if (used) bad.push(`${rel(file)}: ${name} = querySelectorAll(...) 之后 ${name}.${used[1]}`);
    }
  }
  assert.deepEqual(bad, [], `NodeList 当数组用了，先 [...] 摊开：\n${bad.join('\n')}`);
});

test('setup-schema 是双侧共用的纯模块：零 import', () => {
  const file = path.join(SRC, 'web', 'setup-schema.js');
  assert.deepEqual(importsOf(file), [], 'CLI 与页面都要能直接吃它，不能带任何依赖');
});

test('install-guide 是双侧共用的纯模块：零 import', () => {
  const file = path.join(SRC, 'web', 'install-guide.js');
  assert.deepEqual(importsOf(file), [], 'CLI 与页面都要能直接吃安装指引，不能带任何依赖');
});

// ── plugin 例外边界：plugin/ 是零依赖底线的唯一例外，边界钉死在这四条里 ──────

/** plugin 闸门要跨 .mjs 与 package.json，与上面只收 .js 的 walk 分开。 */
function walkPluginGate(dir, keep, skipDirs) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkPluginGate(full, keep, skipDirs));
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

test('plugin 例外边界：根 package.json 无 dependencies/devDependencies/workspaces', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, '主体运行时不许有依赖（例外只在 plugin/ 内）');
  assert.equal(pkg.devDependencies, undefined, '主体测试也不许有依赖');
  assert.equal(pkg.workspaces, undefined, '不用 npm workspaces：plugin/ 是独立子包（ADR-2）');
});

test('plugin 例外边界：全仓 package.json 清单只许根与 plugin/ 两份', () => {
  // 第三个 package.json 出现即红——那是零依赖例外在静默扩散，先改设计再动手。
  const found = walkPluginGate(
    ROOT,
    (name) => name === 'package.json',
    new Set(['node_modules', '.git']),
  ).map(rel).sort();
  assert.deepEqual(found, ['package.json', 'plugin/package.json']);
});

test('plugin 例外边界：主体无任何 import/require 指向 plugin/（plugin 是叶子）', () => {
  const offenders = [];
  for (const scope of ['src', 'tests', 'scripts', 'site']) {
    const dir = path.join(ROOT, scope);
    if (!fs.existsSync(dir)) continue;
    const jsFiles = walkPluginGate(
      dir,
      (name) => name.endsWith('.js') || name.endsWith('.mjs'),
      new Set(['node_modules']),
    );
    for (const file of jsFiles) {
      const text = fs.readFileSync(file, 'utf8');
      const specs = [
        ...importsOf(file),
        ...[...text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
      ];
      for (const spec of specs) {
        const resolved = spec.startsWith('.') || spec.startsWith('/')
          ? rel(path.resolve(path.dirname(file), spec))
          : spec;
        if (resolved === 'plugin' || resolved.startsWith('plugin/')) {
          offenders.push(`${rel(file)} → ${spec}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `主体禁止依赖 plugin/：\n${offenders.join('\n')}`);
});

test('plugin 例外边界：根 files 白名单无 plugin 前缀条目（主体包不夹带插件）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const leaked = (pkg.files ?? []).filter((entry) => entry.startsWith('plugin'));
  assert.deepEqual(leaked, [], '插件经 plugin-v* 独立发 npm，不进主体 npm 包');
});

// ── 覆盖率门槛脚本自身的判定（TST-07） ────────────────────────────────────

const LCOV = [
  'TN:',
  'SF:src/lib/shq.js',
  'DA:1,1', 'DA:2,1', 'DA:3,0', 'DA:4,1', 'DA:5,1', 'DA:6,1', 'DA:7,1', 'DA:8,1', 'DA:9,1', 'DA:10,1',
  'BRF:4', 'BRH:3', 'FNF:2', 'FNH:1',
  'end_of_record',
  'TN:',
  'SF:src/tunnel.js',
  'DA:1,1', 'DA:2,0', 'DA:3,0', 'DA:4,1',
  'end_of_record',
  'TN:',
  'SF:src/web/router.js',
  'DA:1,1', 'DA:2,1', 'DA:3,1', 'DA:4,1', 'DA:5,0',
  'BRF:2', 'BRH:1', 'FNF:1', 'FNH:1',
  'end_of_record',
  'TN:',
  'SF:src/web/components/tabbar.js',
  'DA:1,0', 'DA:2,0', 'DA:3,0', 'DA:4,1',
  'BRF:6', 'BRH:0', 'FNF:3', 'FNH:0',
  'end_of_record',
  '',
].join('\n');

function temporarySources(t, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-source-set-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries(entries)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return root;
}

test('parseLcov 逐文件算行覆盖', () => {
  const parsed = parseLcov(LCOV);
  assert.deepEqual(parsed.map((f) => f.file), ['src/lib/shq.js', 'src/tunnel.js', 'src/web/router.js', 'src/web/components/tabbar.js']);
  assert.equal(parsed[0].pct, 90);
  assert.equal(parsed[1].pct, 50);
  assert.deepEqual(parsed[0].branches, { found: 4, hit: 3 });
  assert.deepEqual(parsed[0].functions, { found: 2, hit: 1 });
  assert.equal(parsed[1].branches, null, '缺 BRH/BRF 的旧记录仍可解析');
  assert.equal(parsed[1].functions, null, '缺 FNH/FNF 的旧记录仍可解析');
});

test('parseLcov 合并 query/fragment 路径别名与重复 DA：同一行任一命中即命中', (t) => {
  const root = temporarySources(t, {
    'src/alias.js': 'export const alias = true;\n',
  });
  const absolute = path.join(root, 'src', 'alias.js');
  const duplicated = [
    'SF:src/alias.js?worker=one',
    'DA:1,0', 'DA:2,1', 'DA:2,0',
    'end_of_record',
    `SF:${absolute}?worker=two`,
    'DA:1,1', 'DA:3,0',
    'end_of_record',
    'SF:src/alias.js#worker=three',
    'DA:3,1',
    'end_of_record',
    '',
  ].join('\n');

  const parsed = parseLcov(duplicated, root);
  assert.deepEqual(parsed.map((file) => file.file), ['src/alias.js']);
  assert.deepEqual(
    { found: parsed[0].found, hit: parsed[0].hit, pct: parsed[0].pct },
    { found: 3, hit: 3, pct: 100 },
  );
});

test('parseLcov 保留磁盘上真实含 ?/# 的 JS 文件，不与无后缀文件合并', (t) => {
  const root = temporarySources(t, {
    'src/same.js': 'export const base = 1;\n',
    'src/same.js?variant.js': 'export const queryName = 1;\n',
    'src/same.js#fragment.js': 'export const fragmentName = 1;\n',
  });
  const report = [
    'SF:src/same.js', 'DA:1,1', 'DA:2,1', 'DA:3,1', 'end_of_record',
    'SF:src/same.js?variant.js', 'DA:1,1', 'DA:2,0', 'DA:3,0', 'end_of_record',
    'SF:src/same.js#fragment.js', 'DA:1,1', 'DA:2,1', 'DA:3,0', 'end_of_record',
  ].join('\n');

  const parsed = parseLcov(report, root);
  assert.deepEqual(
    parsed.map(({ file, found, hit }) => ({ file, found, hit })),
    [
      { file: 'src/same.js', found: 3, hit: 3 },
      { file: 'src/same.js?variant.js', found: 3, hit: 1 },
      { file: 'src/same.js#fragment.js', found: 3, hit: 2 },
    ],
  );
  assert.deepEqual(
    parsed.slice(0, 2).reduce(
      (total, file) => ({ found: total.found + file.found, hit: total.hit + file.hit }),
      { found: 0, hit: 0 },
    ),
    { found: 6, hit: 4 },
    'same.js 与 same.js?variant.js 的真实 4/6 不能被错误合并成 3/3',
  );
});

test('总闸与分档各判各的，components 计入 overall 但不计 web-logic', () => {
  const tiers = evaluateTiers(parseLcov(LCOV));
  const byId = Object.fromEntries(tiers.map((t) => [t.id, t]));

  assert.equal(byId.overall.min, 95);
  assert.equal(byId.overall.files, 4, 'components 必须计入全仓总闸');
  assert.equal(byId.overall.found, 23);
  assert.equal(byId.overall.hit, 16);
  assert.equal(byId.overall.ok, false);
  assert.equal(byId.lib.min, 90);
  assert.equal(byId.lib.ok, true, '90% 刚好达标');
  assert.equal(byId.modules.ok, false, '50% 该被卡住');
  assert.equal(byId['web-logic'].ok, true, '80% 刚好达标');
  assert.equal(byId['web-components'].ok, true, '组件层只报告');
  assert.equal(byId['web-components'].min, null);
  assert.equal(byId['web-logic'].files, 1, 'components 不能混进 web-logic 档');
});

test('overall 是首位 95% 总闸，原分档门槛保持不变', () => {
  assert.deepEqual(
    TIERS.map(({ id, min }) => ({ id, min })),
    [
      { id: 'overall', min: 95 },
      { id: 'lib', min: 90 },
      { id: 'modules', min: 75 },
      { id: 'web-logic', min: 80 },
      { id: 'web-components', min: null },
    ],
  );
});

test('overall 按 DA 行数加权：94.9% 红，95% 刚好绿', () => {
  const large = {
    file: 'src/large.js', found: 999, hit: 949, pct: (949 / 999) * 100,
  };
  const component = {
    file: 'src/web/components/tiny.js', found: 1, hit: 0, pct: 0,
  };
  const overall = (files_) => evaluateTiers(files_).find((tier) => tier.id === 'overall');

  const red = overall([large, component]);
  assert.equal(Number(red.pct.toFixed(1)), 94.9);
  assert.deepEqual({ hit: red.hit, found: red.found }, { hit: 949, found: 1_000 });
  assert.equal(red.ok, false);

  const green = overall([large, { ...component, hit: 1, pct: 100 }]);
  assert.equal(green.pct, 95);
  assert.deepEqual({ hit: green.hit, found: green.found }, { hit: 950, found: 1_000 });
  assert.equal(green.ok, true);
});

test('branch/function 独立聚合并只作诊断，不参与 overall.ok', () => {
  const files_ = parseLcov(LCOV);
  assert.deepEqual(aggregateDiagnostics(files_), {
    files: 4,
    branches: { found: 12, hit: 4, files: 3 },
    functions: { found: 6, hit: 2, files: 3 },
  });

  const linePass = [{
    file: 'src/a.js',
    found: 20,
    hit: 19,
    pct: 95,
    branches: { found: 100, hit: 0 },
    functions: { found: 50, hit: 0 },
  }];
  const tiers = evaluateTiers(linePass);
  assert.equal(tiers.find((tier) => tier.id === 'overall').ok, true, '诊断指标再低也不许扩大门槛');
  const report = formatReport(tiers, aggregateDiagnostics(linePass));
  assert.match(report, /全仓诊断（不设门槛）/);
  assert.match(report, /branch BRH\/BRF 0\/100/);
  assert.match(report, /function FNH\/FNF 0\/50/);
});

test('lcov 空报告不能让 overall 假绿', () => {
  const overall = evaluateTiers(parseLcov('')).find((tier) => tier.id === 'overall');
  assert.equal(overall.pct, 0);
  assert.equal(overall.ok, false);
});

test('sourceJsFiles 扫全普通 src/**/*.js：含嵌套、忽略非 JS、结果稳定排序', (t) => {
  const root = temporarySources(t, {
    'src/z.js': 'export const z = 1;\n',
    'src/nested/a.js': 'export const a = 1;\n',
    'src/nested/readme.txt': '不是源码\n',
  });

  assert.deepEqual(sourceJsFiles(root), ['src/nested/a.js', 'src/z.js']);
});

test('sourceJsFiles 在递归前拒绝 src 根目录软链', (t) => {
  const root = temporarySources(t, {
    'outside/untested.js': 'throw new Error("未覆盖");\n',
  });
  fs.symlinkSync(
    path.join(root, 'outside'),
    path.join(root, 'src'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  assert.throws(
    () => sourceJsFiles(root),
    (error) => error.code === 'COVERAGE_SOURCE_SYMLINK'
      && error.message.includes('src')
      && error.message.includes('软链'),
    'src 根目录本身是软链时，也必须在 readdir 解析目标前 fail-closed',
  );
});

test('sourceJsFiles 对 src 树内文件与目录软链 fail-closed，并点名路径和原因', (t) => {
  const root = temporarySources(t, {
    'src/regular.js': 'export const regular = true;\n',
    'outside/untested.js': 'throw new Error("未覆盖");\n',
    'outside/linked-dir/escape.js': 'throw new Error("不该扫描仓库外目标");\n',
  });
  const fileLink = path.join(root, 'src', 'untested.js');
  fs.symlinkSync(path.join(root, 'outside', 'untested.js'), fileLink, 'file');

  assert.throws(
    () => sourceJsFiles(root),
    (error) => error.code === 'COVERAGE_SOURCE_SYMLINK'
      && error.message.includes('src/untested.js')
      && error.message.includes('软链'),
    '外部 JS 文件软链不能被静默跳过，否则可绕过 overall 95% 总闸',
  );

  fs.rmSync(fileLink);
  fs.symlinkSync(
    path.join(root, 'outside', 'linked-dir'),
    path.join(root, 'src', 'linked-outside'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () => sourceJsFiles(root),
    (error) => error.code === 'COVERAGE_SOURCE_SYMLINK'
      && error.message.includes('src/linked-outside')
      && error.message.includes('软链'),
    '目录软链也必须在解析目标前 fail-closed',
  );
});

test('sourceJsFiles 不把 strings/templates/regex 中的 pragma 字样当作 suppression 注释', (t) => {
  const literals = [
    "export const single = 'escaped \\' /* node:coverage disable */';",
    'export const double = "escaped \\" // c8 ignore next";',
    'export const template = `',
    '/* c8 ignore next */',
    '${`nested ${"// node:coverage disable"}`}',
    '`;',
    'export const blockRegex = /\\/\\* istanbul ignore file \\*\\//;',
    'export const lineRegex = /\\/\\/ node:coverage disable/;',
    '',
  ].join('\n');
  const root = temporarySources(t, {
    'src/literals.js': literals,
  });

  assert.deepEqual(findCoverageSuppressions(literals), []);
  assert.deepEqual(sourceJsFiles(root), ['src/literals.js']);
});

test('findCoverageSuppressions 按上下文区分关键字、属性名与除法/regex', () => {
  const evasions = [
    'of / /* node:coverage disable */ divisor;',
    'obj.return / /* c8 ignore next */ divisor;',
    'obj?.return / /* istanbul ignore next */ divisor;',
    'for (of / /* istanbul ignore file */ divisor; ; ) consume(of);',
  ].join('\n');
  assert.deepEqual(findCoverageSuppressions(evasions), [
    { line: 1, directive: 'node:coverage disable' },
    { line: 2, directive: 'c8 ignore next' },
    { line: 3, directive: 'istanbul ignore next' },
    { line: 4, directive: 'istanbul ignore file' },
  ]);

  const realRegex = [
    'function pattern() { return /\\/\\* node:coverage disable \\*\\//; }',
    'for (const item of /\\/\\* c8 ignore next \\*\\//g) consume(item);',
    'for (const key in /\\/\\/ istanbul ignore next/) consume(key);',
    'for await (const item of /\\/\\/ c8 ignore next/) consume(item);',
  ].join('\n');
  assert.deepEqual(
    findCoverageSuppressions(realRegex),
    [],
    'return 与 for-header 的 of/in 后可合法起 regex，regex 内伪 pragma 不是注释',
  );
});

test('findCoverageSuppressions 按 ECMAScript Unicode 标识符边界区分除法与 regex', () => {
  const evasions = [
    'π / /* node:coverage disable */ divisor;',
    'café / /* c8 ignore next */ divisor;',
    '𐐀value / /* istanbul ignore next */ divisor;',
    'a\u200Cb / /* node:coverage ignore next */ divisor;',
    'a\u200Db / /* c8 ignore start */ divisor;',
  ].join('\n');
  assert.deepEqual(findCoverageSuppressions(evasions), [
    { line: 1, directive: 'node:coverage disable' },
    { line: 2, directive: 'c8 ignore next' },
    { line: 3, directive: 'istanbul ignore next' },
    { line: 4, directive: 'node:coverage ignore next' },
    { line: 5, directive: 'c8 ignore start' },
  ]);

  const realRegex = [
    'function unicodePattern() { return /π \\/\\* node:coverage disable \\*\\//u; }',
    'for (const café of /𐐀 \\/\\* c8 ignore next \\*\\//u) consume(café);',
    'for (const 𐐀value in /π \\/\\/ istanbul ignore next/u) consume(𐐀value);',
  ].join('\n');
  assert.deepEqual(
    findCoverageSuppressions(realRegex),
    [],
    'Unicode 标识符前后真正的 regex 仍须完整跳过，regex 内伪 pragma 不是注释',
  );
});

test('sourceJsFiles 拒绝 inline/trailing 及 template 表达式里的真实 suppression 注释', (t) => {
  const entries = {
    'src/inline.js': 'export const inline = 1; /* c8 ignore next */\n',
    'src/trailing.js': 'export const trailing = 1; // node:coverage disable\n',
    'src/nested.js': [
      'export const nested = `${',
      '  1 + (/* istanbul ignore next */ 2)',
      '}`;',
      '',
    ].join('\n'),
  };
  const root = temporarySources(t, entries);

  assert.deepEqual(findCoverageSuppressions(entries['src/inline.js']), [
    { line: 1, directive: 'c8 ignore next' },
  ]);
  assert.deepEqual(findCoverageSuppressions(entries['src/trailing.js']), [
    { line: 1, directive: 'node:coverage disable' },
  ]);
  assert.deepEqual(findCoverageSuppressions(entries['src/nested.js']), [
    { line: 2, directive: 'istanbul ignore next' },
  ]);
  assert.throws(
    () => sourceJsFiles(root),
    (error) => error.code === 'COVERAGE_SUPPRESSION_PRAGMA'
      && error.message.includes('src/inline.js:1 c8 ignore next')
      && error.message.includes('src/trailing.js:1 node:coverage disable')
      && error.message.includes('src/nested.js:2 istanbul ignore next'),
    'pragma 在同行代码后或 template 表达式中仍是真注释，不能绕过静态闸门',
  );
});

test('sourceJsFiles 静态拒绝 Node/c8/istanbul coverage suppression pragma 并列出文件与指令', (t) => {
  const root = temporarySources(t, {
    'src/node.js': '/* node:coverage disable */\nexport const node = true;\n',
    'src/nested/c8.js': '/* c8 ignore next */\nexport const c8 = true;\n',
    'src/nested/istanbul.js': '/* istanbul ignore file */\nexport const istanbul = true;\n',
  });

  assert.throws(
    () => sourceJsFiles(root),
    (error) => error.code === 'COVERAGE_SUPPRESSION_PRAGMA'
      && error.message.includes('src/node.js:1 node:coverage disable')
      && error.message.includes('src/nested/c8.js:1 c8 ignore next')
      && error.message.includes('src/nested/istanbul.js:1 istanbul ignore file'),
    'coverage suppression 会直接缩小 DA 分母，必须静态 fail-closed 并点名文件与指令',
  );
});

test('missingSourceFiles 对齐磁盘与 lcov：全覆盖绿、缺一个点名，绝对/相对路径视同', (t) => {
  const root = temporarySources(t, {
    'src/a.js': 'export const a = 1;\n',
    'src/nested/b.js': 'export const b = 1;\n',
    'src/nested/data.json': '{}\n',
  });
  const absoluteA = path.join(root, 'src', 'a.js');
  const relativeB = ['src', 'nested', 'b.js'].join(path.sep);
  const completeLcov = [
    `SF:${absoluteA}`, 'DA:1,1', 'end_of_record',
    `SF:${relativeB}`, 'DA:1,1', 'end_of_record',
  ].join('\n');
  const complete = parseLcov(completeLcov, root);

  assert.deepEqual(complete.map((file) => file.file), ['src/a.js', 'src/nested/b.js']);
  assert.deepEqual(
    missingSourceFiles(complete, root),
    [],
    'lcov 的绝对与相对路径都应归一到 repo-relative POSIX 路径',
  );
  const onlyA = parseLcov('SF:src\\a.js\nDA:1,1\nend_of_record\n', root);
  assert.deepEqual(
    missingSourceFiles(onlyA, root),
    ['src/nested/b.js'],
    '反斜杠路径也要归一，且缺失名单按路径稳定排序',
  );
});

test('coverageVerdict 顺序固定，并把 missing 纳入主退出判据', () => {
  const covered = [{
    file: 'src/a.js', found: 20, hit: 19, pct: 95,
  }];
  const tiers = evaluateTiers(covered);
  const emptyTiers = evaluateTiers([]);

  const testFailure = coverageVerdict({
    testExit: 2, files: [], tiers: emptyTiers, missing: ['src/untested.js'],
  });
  assert.equal(testFailure.phase, 'tests', '测试退出码优先于空 lcov 与缺失源码');
  assert.equal(testFailure.exitCode, 2);
  assert.equal(coverageVerdict({
    testExit: 0, files: [], tiers: emptyTiers, missing: ['src/untested.js'],
  }).phase, 'empty-lcov', '空 lcov 优先给出采集失败原因');

  assert.equal(coverageVerdict({
    testExit: 0, files: covered, tiers, missing: [],
  }).ok, true);
  const missing = coverageVerdict({
    testExit: 0, files: covered, tiers, missing: ['src/untested.js'],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.exitCode, 1);
  assert.deepEqual(missing.missing, ['src/untested.js']);
});

test('前端不碰 innerHTML 一类的 HTML 注入口', () => {
  // `el()` 里有运行期闸（传 html 就抛），但直接 `node.innerHTML = x` 绕得过去。
  // 远端 stderr 会原样进日志、日志会进页面——这条路上一旦当 HTML 解析就是 XSS。
  const SINKS = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write'];
  const bad = [];
  for (const file of walk(path.join(SRC, 'web'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      if (/禁止 innerHTML/.test(line)) continue; // utils.js 里那道闸自己要提这个词
      for (const sink of SINKS) {
        if (line.includes(sink)) bad.push(`${rel(file)}:${i + 1} ${sink}`);
      }
    }
  }
  assert.deepEqual(bad, [], `动态文本一律走 textContent：\n${bad.join('\n')}`);
});

// ── 行为清单闸门自身的判定（harness 支柱 B） ──────────────────────────────
//
// 与覆盖率闸门同款待遇：判定逻辑是纯函数，正反算例都放在架构护栏里，
// 免得「闸门永远说绿」这种最安静的失败方式活下来。

test('inventory 提取：路由表正则转可读路径，`([^/]+)` 归一为 :name', () => {
  const source = [
    "  const routes = [",
    "    ['GET', /^\\/api\\/hosts$/, (req, res) => {}],",
    "    ['POST', /^\\/api\\/hosts\\/([^/]+)\\/start$/, (req, res) => {}],",
    "    ['PUT', /^\\/api\\/config\\/defaults$/, (req, res) => {}],",
    '  ];',
  ].join('\n');
  assert.deepEqual(apiRoutesFrom(source), [
    'GET /api/hosts',
    'POST /api/hosts/:name/start',
    'PUT /api/config/defaults',
  ]);
  assert.deepEqual(apiRoutesFrom('const x = 1;'), [], '没有路由表就是空清单，不许编');
});

test('inventory 提取：退出码去重升序，0 不算占用', () => {
  const source = 'a || { echo "ERR=x"; exit 9; }; b || exit 8; c; exit 0; d || exit 9';
  assert.deepEqual(protoExitCodesFrom(source), [8, 9]);
});

test('inventory 提取：COMMANDS 只取顶层键，嵌套对象与后续代码不混进来', () => {
  const source = [
    'export const COMMANDS = {',
    "  init: { usage: 'dshc init', needsServer: false, run: cmdInit },",
    "  up: { usage: 'dshc up', needsServer: false, run: cmdUp },",
    '',
    "  ls: { usage: 'dshc ls', needsServer: true, run: cmdLs },",
    '};',
    '',
    'export function usageText() {',
    '  const other = { notACommand: { x: 1 } };',
    '  return other;',
    '}',
  ].join('\n');
  assert.deepEqual(cliCommandsFrom(source), ['init', 'up', 'ls']);
  assert.throws(() => cliCommandsFrom('const x = 1;'), /找不到 COMMANDS 表/);
});

test('inventory：六个面都有内容，且 key 全库唯一', () => {
  const inventory = collectInventory(ROOT);
  const keys = inventory.items.map((item) => item.key);
  assert.equal(new Set(keys).size, keys.length, 'key 撞号会让某个行为的登记被另一个吃掉');
  for (const surface of SURFACES) {
    assert.ok(
      inventory.bySurface[surface].length > 0,
      `${surface} 面清单为空：提取器多半跟源码形状脱节了`,
    );
  }
  assert.ok(keys.includes('FSM:running→degraded'));
  assert.ok(keys.includes('SCN:pid-reuse') === false, '场景表里没有的 id 不该凭空出现');
});

test('matrix-gate 判定：未登记 / 死行为 / 引用悬空 / 豁免没写理由 各自判红', () => {
  const inventory = {
    items: [
      { surface: 'API', id: 'GET /api/hosts', key: 'API:GET /api/hosts', origin: 'src/api.js' },
      { surface: 'EXIT', id: '8', key: 'EXIT:8', origin: 'src/lib/proto.js' },
    ],
  };
  const text = [
    '| `API:GET /api/hosts` | `tests/api.test.js` |',
    '| `ERR:GONE_CODE` | `tests/nope.test.js` |',
  ].join('\n');
  const exists = (ref) => ref === 'tests/api.test.js';

  const verdict = matrixVerdict(
    inventory,
    parseRegistrations(text),
    parseFileRefs(text),
    exists,
    parseBadExemptions(text),
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.unregistered.map((item) => item.key), ['EXIT:8']);
  assert.deepEqual(verdict.dead.map((entry) => entry.key), ['ERR:GONE_CODE']);
  assert.deepEqual(verdict.dangling.map((entry) => entry.ref), ['tests/nope.test.js']);
  assert.match(formatVerdict(verdict), /新增行为未登记/);

  const clean = '| `API:GET /api/hosts` `EXIT:8` | `tests/api.test.js` |';
  const good = matrixVerdict(
    inventory,
    parseRegistrations(clean),
    parseFileRefs(clean),
    exists,
    parseBadExemptions(clean),
  );
  assert.equal(good.ok, true, formatVerdict(good));
  assert.match(formatVerdict(good), /行为清单与矩阵一致/);
});

test('matrix-gate 判定：豁免要写理由，写了才算登记', () => {
  const withReason = '| `EXIT:8` | EXEMPT(真机)：需要真远端不可写目录 |';
  assert.deepEqual(parseBadExemptions(withReason), []);
  assert.equal(parseRegistrations(withReason)[0].exempt, '真机：需要真远端不可写目录');

  for (const bad of ['| `EXIT:8` | EXEMPT(真机) |', '| `EXIT:8` | EXEMPT()：x |', '| `EXIT:8` | EXEMPT(人工)： |']) {
    assert.equal(parseBadExemptions(bad).length, 1, `应判红：${bad}`);
  }
});

test('matrix-gate 引用抽取：只收仓库内路径，glob 只要命中一个就算落地', () => {
  const text = [
    '| x | `tests/api.test.js`、`scripts/check.mjs` |',
    '| y | `npm run check`、`node_modules/dsh-center`、`plugin/tests` |',
    '| z | `tests/web/*mount*.test.js`、`src/lib/**` |',
  ].join('\n');
  assert.deepEqual(
    parseFileRefs(text).map((entry) => entry.ref),
    ['tests/api.test.js', 'scripts/check.mjs', 'tests/web/*mount*.test.js', 'src/lib/**'],
    '命令、npm 包名、无扩展名的目录都不该被当成文件引用',
  );

  assert.equal(globHasMatch('tests/web/*mount*.test.js', ROOT), true);
  assert.equal(globHasMatch('src/lib/**', ROOT), true);
  assert.equal(globHasMatch('tests/web/*nope*.test.js', ROOT), false);
  assert.equal(globHasMatch('src/nope/**', ROOT), false);
});

test('scripts/lib/inventory.mjs 是闸门专用：src/ 不许引它（依赖方向不倒挂）', () => {
  const offenders = [];
  for (const file of files) {
    for (const spec of importsOf(file)) {
      if (spec.includes('inventory')) offenders.push(`${rel(file)} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `行为清单是测试设施，产品代码不该知道它存在：\n${offenders.join('\n')}`);
});

// ── 墙钟基线闸自身的判定（harness 支柱 A 的软闸那一半） ──────────────────

test('median：奇偶数样本各自取法正确，空集不炸', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.equal(median([]), 0);
});

test('perfVerdict：超带判红、带内放行、缺基线与死场景都要红', () => {
  const baseline = { a: { ms: 100 }, b: { ms: 100 }, gone: { ms: 100 } };
  const measured = {
    a: { ms: 249, samples: [], kind: 'path' }, // ×2.49，带内
    b: { ms: 251, samples: [], kind: 'path' }, // ×2.51，超带
    fresh: { ms: 10, samples: [], kind: 'micro' }, // 基线里没有
  };
  const verdict = perfVerdict(measured, baseline);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.regressions.map((r) => r.id), ['b'], '恰好压线的 a 不该判红');
  assert.deepEqual(verdict.missing.map((r) => r.id), ['fresh']);
  assert.deepEqual(verdict.stale, ['gone'], '基线里有、场景表里没有：死场景也要报');
  const report = formatPerf(verdict);
  assert.match(report, /墙钟退化/);
  assert.match(report, /--record/, '判红时必须告诉人怎么处置');

  const clean = perfVerdict(
    { a: { ms: 120, samples: [], kind: 'path' } },
    { a: { ms: 100 } },
  );
  assert.equal(clean.ok, true, formatPerf(clean));
  assert.match(formatPerf(clean), /宽容带内/);
});

test('perfVerdict：噪声地板以下不判红（几毫秒的量测里 GC 一停就翻三倍）', () => {
  const tiny = perfVerdict(
    { micro: { ms: 4.9, samples: [], kind: 'micro' } },
    { micro: { ms: 0.6 } },
  );
  assert.equal(tiny.ok, true, `×8 但两边都在 ${NOISE_FLOOR_MS}ms 地板下，不该判红`);
  assert.equal(tiny.rows[0].belowFloor, true);

  // 只要有一边冒出地板，就照常判
  const grown = perfVerdict(
    { micro: { ms: 50, samples: [], kind: 'micro' } },
    { micro: { ms: 0.6 } },
  );
  assert.equal(grown.ok, false, '从 0.6ms 涨到 50ms 是真退化，地板不该护着它');
});

test('BASELINE.json 与场景表逐一对应（改场景 id 等于弃掉那条历史）', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'perf', 'BASELINE.json'), 'utf8'));
  assert.equal(baseline.tolerance, TOLERANCE, '基线文件里的宽容带与闸门实现对不上');
  assert.equal(baseline.repeats, REPEATS);
  assert.deepEqual(
    Object.keys(baseline.scenarios).sort(),
    PERF_SCENARIOS.map((s) => s.id).sort(),
    '场景表与基线不同步：跑一次 npm run perf:gate -- --record',
  );
  for (const [id, entry] of Object.entries(baseline.scenarios)) {
    assert.ok(entry.ms > 0, `${id} 的基线是 ${entry.ms}ms，不像量出来的`);
  }
  assert.equal(new Set(PERF_SCENARIOS.map((s) => s.id)).size, PERF_SCENARIOS.length, '场景 id 撞号');
});

test('集成测试的端口段整体低于临时端口区（探进去就会偶发假红）', async () => {
  // 段与段互斥只挡得住测试进程之间的互抢。段一旦落进内核的临时端口区，内核就可能把
  // 同一个端口发给任何人——包括另一个测试自己的 `--port 0` 降级重拉；portFree() 探完
  // 到真正 bind 之间还有窗口，探测再勤也堵不上。这条曾经真红过：remote 段最高摸到
  // 58994，而 macOS 的临时端口从 49152 起，于是「固定端口路径」偶发被降级成 --port 0，
  // loop.test.js 断言 actualPort 即约定端口的那条报「期望 55050，实得 55101」。
  const { PORT_PLAN } = await import('./integration/helpers.js');
  assert.ok(
    PORT_PLAN.ceiling < PORT_PLAN.ephemeralFloor,
    `端口段最高 ${PORT_PLAN.ceiling}，已探进临时端口区 ${PORT_PLAN.ephemeralFloor}+`,
  );
  // 红线取 Linux（32768 起）与 macOS（49152 起）里更小的那个，两个平台都得安全
  assert.ok(PORT_PLAN.ephemeralFloor <= 32_768, '红线放宽到 Linux 默认之上就等于没设');
  assert.ok(PORT_PLAN.localOrigin >= 1_024, '别踩注册端口区');
  assert.ok(PORT_PLAN.remoteOrigin >= PORT_PLAN.localOrigin + PORT_PLAN.slotCount * 50, '两段重叠了');
});

// ── 测试卫生（harness 支柱 C） ────────────────────────────────────────────

/** 断言口子：node:assert 的调用、t.assert.*、以及 assert.fail 之类。 */
const ASSERTION_RE = /\b(?:assert(?:\.\w+)*\s*\(|t\.assert\.\w+\s*\(|\.assertSnapshot\s*\()/u;

test('每个用例文件至少有一处断言（没有断言的测试只是在跑代码）', () => {
  const bare = [];
  for (const file of walk(path.join(ROOT, 'tests'))) {
    if (!file.endsWith('.test.js')) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!ASSERTION_RE.test(text)) bare.push(rel(file));
  }
  assert.deepEqual(bare, [], `这些用例文件没有任何断言：\n${bare.join('\n')}`);
});

test('harness 支柱三个目录的依赖围栏：只许 node 内置与本仓 src/tests/scripts', () => {
  // 这三个目录是「体系自身」，最容易在赶时间时顺手 npm i 一个 bench/fuzz 库进来——
  // 那正是零依赖底线的破口。plugin/（唯一的依赖例外）同样不许伸手进来。
  const allowed = ['src/', 'tests/', 'scripts/'];
  const offenders = [];
  for (const scope of ['adversarial', 'perf', 'fuzz']) {
    const dir = path.join(ROOT, 'tests', scope);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      for (const spec of importsOf(file)) {
        if (spec.startsWith('node:')) continue;
        const resolved = spec.startsWith('.')
          ? rel(path.resolve(path.dirname(file), spec))
          : spec;
        if (allowed.some((prefix) => resolved.startsWith(prefix))) continue;
        offenders.push(`${rel(file)} → ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `harness 支柱目录越界依赖：\n${offenders.join('\n')}`);
});

// ── 变异闸门自身的判定（harness 支柱 B） ─────────────────────────────────
//
// 与覆盖率、矩阵、墙钟三闸同款待遇：判定逻辑是纯函数，正反算例都钉在这里。
// 变异闸门尤其需要——它最坏的失败方式是「一个变异体都没生成」然后报 kill 率 100%。

test('js-scan：代码区与字符串/模板/正则/注释各自认得清', () => {
  const source = [
    'const a = 1 === 2;',
    "const s = 'x === y';",
    'const t = `raw === ${1 === 2} raw`;',
    'const r = /a===b/u.test(s);',
    '// c === d',
    '/* e === f */',
  ].join('\n');
  const { code, comments } = scanJs(source);
  const at = (needle, nth = 0) => {
    let index = -1;
    for (let i = 0; i <= nth; i += 1) index = source.indexOf(needle, index + 1);
    return index;
  };

  assert.equal(isCodeSpan(code, at('==='), at('===') + 3), true, '第一处 === 就在代码里');
  assert.equal(isCodeSpan(code, at('==='), at('===') + 3), true);
  assert.equal(isCodeSpan(code, at('=== y'), at('=== y') + 3), false, '字符串里的 === 不是代码');
  assert.equal(isCodeSpan(code, at('=== ${'), at('=== ${') + 3), false, '模板原文里的 === 不是代码');
  assert.equal(isCodeSpan(code, at('=== 2}'), at('=== 2}') + 3), true, '`${}` 里面重新算代码');
  assert.equal(isCodeSpan(code, at('a===b'), at('a===b') + 5), false, '正则字面量里的 === 不是代码');
  assert.equal(isCodeSpan(code, at('c === d'), at('c === d') + 7), false, '行注释里的不是代码');
  assert.equal(isCodeSpan(code, at('e === f'), at('e === f') + 7), false, '块注释里的不是代码');

  assert.deepEqual(comments.map((c) => c.text.trim()), ['c === d', 'e === f']);
  assert.deepEqual(comments.map((c) => c.line), [5, 6], '注释行号要对，coverage-gate 的点名靠它');

  // 越界与空区间一律判否，别让调用方拿到一个「看着是代码」的假答案
  assert.equal(isCodeSpan(code, -1, 3), false);
  assert.equal(isCodeSpan(code, 0, source.length + 1), false);
  assert.equal(isCodeSpan(code, 5, 5), false);
});

test('变异算子：只改代码区，且不误伤 => / >>> / 0x / 浮点 / BigInt', () => {
  const source = [
    'const arrow = (x) => x;',
    'const shift = 1 >>> 2;',
    'const hex = 0x1f;',
    'const float = 1.5;',
    'const big = 7n;',
    'const ident = a1 + b2;',
    "const msg = 'a === b && c';",
    'const cmp = a === b && c < d;',
  ].join('\n');
  const mutants = enumerateMutants(source, { file: 'src/x.js' });
  const ops = mutants.map((m) => m.op);

  assert.deepEqual(
    mutants.filter((m) => m.line === 1),
    [],
    '箭头函数里的 => 被当成 > 改掉的话，产出的全是语法错误',
  );
  assert.deepEqual(
    mutants.filter((m) => m.line === 2).map((m) => `${m.op}:${m.from}`),
    ['num-minus-1:1', 'num-plus-1:1', 'num-minus-1:2', 'num-plus-1:2'],
    '>>> 不该被当成 >；两个数字字面量照改（同位置多算子按算子名排序，保证顺序稳定）',
  );
  assert.deepEqual(mutants.filter((m) => m.line === 3), [], '0x1f 不是十进制整数');
  assert.deepEqual(mutants.filter((m) => m.line === 4), [], '1.5 的整数部分不许被单独 ±1');
  assert.deepEqual(mutants.filter((m) => m.line === 5), [], 'BigInt 的 7n 不许被当成 7');
  assert.deepEqual(mutants.filter((m) => m.line === 6), [], 'a1 / b2 里的数字是标识符的一部分');
  assert.deepEqual(mutants.filter((m) => m.line === 7), [], '字符串里的 === 与 && 一个都不许动');

  const last = mutants.filter((m) => m.line === 8);
  assert.deepEqual(last.map((m) => m.op), ['eq-to-ne', 'and-to-or', 'lt-to-le'], '最后一行三个算子各来一次，顺序按出现位置');
  assert.ok(ops.every((op) => OPERATORS.includes(op)), `产出了白名单外的算子：${ops.filter((op) => !OPERATORS.includes(op))}`);
});

test('变异算子：早退语句与单行守卫子句都能删，含分号正文与注释里的一律跳过', () => {
  const source = [
    'function f(a) {',
    '  if (!a) throw new Error("no");',
    '  if (isX(a, b)) return 2;',
    '  return a;',
    '  // return 9;',
    '  const x = a; return x;',
    '  return f(";");',
    '  if (a) { return 1; }',
    '}',
  ].join('\n');
  const drops = enumerateMutants(source, { file: 'src/x.js' }).filter((m) => m.op === 'drop-exit');
  assert.deepEqual(
    drops.map((m) => `${m.line}:${m.from}`),
    ['2:throw new Error("no");', '3:return 2;', '4:return a;'],
    '注释里的、与别的语句同行的、正文含分号的、带花括号的，一律跳过（保守但绝不出错）',
  );
  assert.ok(drops.every((m) => m.to === ';'));

  // 守卫只删「后果」，`if (…)` 留着——换出来必须仍是合法语句，否则算子只会造语法错误
  assert.match(applyMutant(source, drops[0]), /if \(!a\) ;/u);
  assert.match(applyMutant(source, drops[1]), /if \(isX\(a, b\)\) ;/u, '条件里带括号也要切对');
});

test('变异体 id 与行号无关、与那一行的内容有关', () => {
  const body = 'export const f = (a) => a === 1;\n';
  const base = enumerateMutants(body, { file: 'src/x.js' });
  const shifted = enumerateMutants(`// 新加的注释\n// 又一行\n${body}`, { file: 'src/x.js' });
  assert.deepEqual(
    shifted.map((m) => m.id),
    base.map((m) => m.id),
    '在文件开头插两行注释就让全部豁免悬空，这份基线没人维护得下去',
  );
  assert.notEqual(shifted[0].line, base[0].line, '行号本身还是要跟着走（报告里要指得准）');

  const edited = enumerateMutants('export const f = (a) => a === 2;\n', { file: 'src/x.js' });
  assert.notDeepEqual(
    edited.map((m) => m.id),
    base.map((m) => m.id),
    '那一行的逻辑改了，旧的「为什么杀不掉」的理由就不再适用，必须重新发号',
  );

  // 同一行同算子出现多次时按序号区分，不许撞号
  const twice = enumerateMutants('const b = a === 1 && c === 2;\n', { file: 'src/x.js' });
  const eq = twice.filter((m) => m.op === 'eq-to-ne');
  assert.equal(eq.length, 2);
  assert.equal(new Set(eq.map((m) => m.id)).size, 2, '同行同算子的两处必须是两个 id');
});

test('applyMutant：逐字替换，与源码对不上时立刻抛（不许改错位置）', () => {
  const source = 'const ok = a === b;\n';
  const [mutant] = enumerateMutants(source, { file: 'src/x.js' });
  assert.equal(applyMutant(source, mutant), 'const ok = a !== b;\n');
  assert.throws(
    () => applyMutant('const ok = a !== b;\n', mutant),
    /与源码对不上/u,
    '源码已经变了还照着旧偏移改，会静静地改掉别的地方',
  );
});

test('mutationVerdict：新幸存者判红、已登记的放行、复活的要报', () => {
  const targets = [{
    id: 'lib', label: 'lib', enabled: true, enforce: true, minKill: 50, match: (f) => f.startsWith('src/lib/'),
  }];
  const row = (id, outcome, file = 'src/lib/a.js') => ({
    id, file, op: 'eq-to-ne', line: 1, code: 'x', outcome,
  });

  const strict = mutationVerdict({
    results: [row('a|eq-to-ne|h|0', 'killed'), row('b|eq-to-ne|h|0', 'survived')],
    allowed: new Map(),
    targets,
  });
  assert.equal(strict.ok, false);
  assert.equal(strict.exitCode, 1);
  assert.deepEqual(strict.tiers[0].newSurvivors.map((r) => r.id), ['b|eq-to-ne|h|0']);
  assert.match(formatMutation(strict), /新幸存/u);
  assert.match(formatMutation(strict), /ALLOWED_SURVIVORS/u, '判红时必须告诉人怎么处置');

  const excused = mutationVerdict({
    results: [row('a|eq-to-ne|h|0', 'killed'), row('b|eq-to-ne|h|0', 'survived')],
    allowed: new Map([['b|eq-to-ne|h|0', { id: 'b|eq-to-ne|h|0', file: 'src/lib/a.js', why: '等价变异' }]]),
    targets,
  });
  assert.equal(excused.ok, true, formatMutation(excused));

  // 登记过的幸存者被杀掉了：豁免该删，否则基线会越攒越大且没人敢动
  const back = mutationVerdict({
    results: [row('b|eq-to-ne|h|0', 'killed')],
    allowed: new Map([['b|eq-to-ne|h|0', { id: 'b|eq-to-ne|h|0', file: 'src/lib/a.js', why: '等价变异' }]]),
    targets,
  });
  assert.deepEqual(back.tiers[0].resurrected.map((r) => r.id), ['b|eq-to-ne|h|0']);
  assert.match(formatMutation(back), /已被杀掉却还挂着豁免/u);
});

test('mutationVerdict：语法不合法不进分母，超时算杀死，只报告档不影响退出码', () => {
  const enforced = {
    id: 'lib', label: 'lib', enabled: true, enforce: true, minKill: 80, match: (f) => f.startsWith('src/lib/'),
  };
  const advisoryTier = {
    id: 'modules', label: 'modules', enabled: true, enforce: false, minKill: null, match: (f) => /^src\/[^/]+\.js$/u.test(f),
  };
  const row = (file, outcome, n) => ({
    id: `${file}|eq-to-ne|h|${n}`, file, op: 'eq-to-ne', line: 1, code: 'x', outcome,
  });

  const verdict = mutationVerdict({
    results: [
      row('src/lib/a.js', 'killed', 0),
      row('src/lib/a.js', 'timeout', 1),
      row('src/lib/a.js', 'syntax', 2),
      row('src/lib/a.js', 'syntax', 3),
      // 只报告档里一片幸存，也不许影响结论
      row('src/b.js', 'survived', 0),
      row('src/b.js', 'survived', 1),
    ],
    allowed: new Map(),
    targets: [enforced, advisoryTier],
  });
  const lib = verdict.tiers.find((t) => t.id === 'lib');
  assert.equal(lib.scored, 2, '语法不合法的变异体什么都没说明，不该进分母把数字撑高');
  assert.equal(lib.killRate, 100, '超时算杀死：行为差异确实被察觉到了');
  assert.equal(lib.syntax, 2);
  assert.equal(verdict.ok, true, `只报告档的幸存者不该判红：\n${formatMutation(verdict)}`);
  assert.equal(verdict.tiers.find((t) => t.id === 'modules').ok, true);

  // 设卡档 kill 率不够就判红，哪怕一个新幸存者都没有（全被豁免了）
  const thin = mutationVerdict({
    results: [row('src/lib/a.js', 'killed', 0), row('src/lib/a.js', 'survived', 1)],
    allowed: new Map([['src/lib/a.js|eq-to-ne|h|1', { id: 'src/lib/a.js|eq-to-ne|h|1', file: 'src/lib/a.js', why: '等价变异' }]]),
    targets: [enforced],
  });
  assert.equal(thin.ok, false, 'kill 率 50% < 80%，豁免再多也不该算达标');
  assert.match(formatMutation(thin), /kill 率没到/u);
});

test('mutationVerdict：悬空豁免要报，但 --only / --op 缩过范围时不算悬空', () => {
  const targets = [{
    id: 'lib', label: 'lib', enabled: true, enforce: true, minKill: null, match: (f) => f.startsWith('src/lib/'),
  }];
  const allowed = new Map([
    ['src/lib/gone.js|eq-to-ne|h|0', { id: 'src/lib/gone.js|eq-to-ne|h|0', file: 'src/lib/gone.js', op: 'eq-to-ne', why: '等价变异' }],
  ]);
  const results = [{
    id: 'src/lib/a.js|eq-to-ne|h|0', file: 'src/lib/a.js', op: 'eq-to-ne', line: 1, code: 'x', outcome: 'killed',
  }];

  const full = mutationVerdict({
    results, allowed, targets, scopedFiles: new Set(['src/lib/a.js', 'src/lib/gone.js']),
  });
  assert.deepEqual(full.stale.map((e) => e.id), ['src/lib/gone.js|eq-to-ne|h|0']);
  assert.equal(full.ok, false);
  assert.match(formatMutation(full), /悬空豁免/u);

  const scoped = mutationVerdict({
    results, allowed, targets, scopedFiles: new Set(['src/lib/a.js']),
  });
  assert.deepEqual(scoped.stale, [], '范围外的豁免当然跑不到，那不是悬空');
  assert.equal(scoped.ok, true);

  // 按算子缩范围同理。少了这层收窄，`--op num-plus-1` 这种局部跑会把所有别的算子的
  // 豁免全报成悬空——闸门一旦学会了误报，人就学会了不看它。
  const byOp = mutationVerdict({
    results,
    allowed,
    targets,
    scopedFiles: new Set(['src/lib/a.js', 'src/lib/gone.js']),
    scopedOps: new Set(['num-plus-1']),
  });
  assert.deepEqual(byOp.stale, [], '这一轮压根没生成 eq-to-ne 的变异体，找不到不等于悬空');
  assert.equal(byOp.ok, true);

  const inScope = mutationVerdict({
    results,
    allowed,
    targets,
    scopedFiles: new Set(['src/lib/a.js', 'src/lib/gone.js']),
    scopedOps: new Set(['eq-to-ne']),
  });
  assert.deepEqual(inScope.stale.map((e) => e.id), ['src/lib/gone.js|eq-to-ne|h|0'], '算子在范围内就照报');
});

test('parseAllowed：没写理由 / 占位符 / 形状不符 / 重复登记 各自报出来', () => {
  const good = {
    entries: [{
      id: 'src/lib/a.js|eq-to-ne|abcd1234|0',
      file: 'src/lib/a.js',
      op: 'eq-to-ne',
      why: '这处比较两侧恒等，改成 !== 后走的是同一条分支',
    }],
  };
  assert.deepEqual(parseAllowed(good).problems, []);
  assert.equal(parseAllowed(good).entries.size, 1);

  const bad = (patch) => parseAllowed({ entries: [{ ...good.entries[0], ...patch }] }).problems.join('\n');
  assert.match(bad({ id: 'nope' }), /id 形状不符/u);
  assert.match(bad({ why: '暂时' }), /why 必填/u);
  assert.match(bad({ why: 'TODO：回头再看' }), /占位符/u);
  assert.match(bad({ why: '   ' }), /why 必填/u);
  assert.match(bad({ file: 'src/lib/b.js' }), /与 id 里的文件名不一致/u);
  assert.match(bad({ id: 'src/lib/a.js|no-such-op|abcd1234|0' }), /不在白名单里/u);
  assert.match(parseAllowed({ entries: 'nope' }).problems.join('\n'), /需要顶层/u);
  assert.match(
    parseAllowed({ entries: [good.entries[0], good.entries[0]] }).problems.join('\n'),
    /重复登记/u,
  );
});

test('ALLOWED_SURVIVORS.json 自身合格，且每条都指向真实存在的变异体', () => {
  const file = path.join(ROOT, ...ALLOWED_FILE.split('/'));
  const { entries, problems } = parseAllowed(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(problems, [], `豁免基线自己就不合格：\n${problems.join('\n')}`);

  // 悬空豁免在闸门里也会报，但那要跑完整轮变异（分钟级）；这里静态就能查
  const byFile = new Map();
  const dangling = [];
  for (const entry of entries.values()) {
    if (!byFile.has(entry.file)) {
      const source = fs.readFileSync(path.join(ROOT, ...entry.file.split('/')), 'utf8');
      byFile.set(entry.file, new Set(enumerateMutants(source, { file: entry.file }).map((m) => m.id)));
    }
    if (!byFile.get(entry.file).has(entry.id)) dangling.push(entry.id);
  }
  assert.deepEqual(dangling, [], `这些豁免指向的变异体已经不存在了（那一行改过？）：\n${dangling.join('\n')}`);
});

test('变异靶标表：id 不撞、设卡档有门槛、没启用的档要写清为什么', () => {
  assert.equal(new Set(MUTATION_TARGETS.map((t) => t.id)).size, MUTATION_TARGETS.length);
  for (const tier of MUTATION_TARGETS) {
    if (tier.enforce) {
      assert.equal(typeof tier.minKill, 'number', `${tier.id} 设了卡却没有 kill 率门槛`);
      assert.ok(tier.enabled, `${tier.id} 设了卡却没启用`);
    }
    if (!tier.enabled) {
      assert.ok(
        typeof tier.why === 'string' && tier.why.length > 10,
        `${tier.id} 是预留插槽，得写清缺什么才能启用——不然它就只是一行死代码`,
      );
    }
  }
  // 分档必须互斥：一个文件落进两档，kill 率会被算两遍
  const overlaps = [];
  for (const file of ['src/lib/shq.js', 'src/api.js', 'src/web/store.js', 'src/web/components/x.js']) {
    const hit = MUTATION_TARGETS.filter((t) => t.match(file)).map((t) => t.id);
    if (hit.length > 1) overlaps.push(`${file} → ${hit.join('、')}`);
  }
  assert.deepEqual(overlaps, [], `分档重叠：\n${overlaps.join('\n')}`);
});

test('变异跑测的「文件→用例」映射：同名约定 + 直接 import，都空则不装作跑过了', () => {
  const deps = buildImportGraph(ROOT);
  const testsOf = testSetResolver(deps, ROOT);

  const shq = testsOf('src/lib/shq.js');
  assert.ok(shq.direct.includes('tests/lib/shq.test.js'), '同名约定的用例必须在直接集里');
  assert.ok(shq.direct.length >= 2, '直接 import 了 shq 的用例不止一个');
  assert.equal(
    shq.direct.some((t) => shq.closure.includes(t)),
    false,
    '闭包集要减掉直接集：同一个文件跑两遍纯属浪费',
  );
  assert.ok(shq.closure.length > 0, 'shq 是底层件，闭包里必然还有别的用例');

  // 每个设卡档的文件都得有用例能到达，否则那些变异体只会被记成「未跑」
  const enforced = MUTATION_TARGETS.filter((t) => t.enforce);
  const orphan = [];
  for (const file of walk(SRC).map(rel)) {
    if (!enforced.some((t) => t.match(file))) continue;
    const { direct, closure } = testsOf(file);
    if (direct.length + closure.length === 0) orphan.push(file);
  }
  assert.deepEqual(orphan, [], `设卡档里这些文件没有任何用例能到达：\n${orphan.join('\n')}`);
});

test('变异体按文件轮转排队：时间盒到点时跑过的那部分横跨所有文件', () => {
  const mutants = [
    { id: 'a1', file: 'a' }, { id: 'a2', file: 'a' }, { id: 'a3', file: 'a' },
    { id: 'b1', file: 'b' },
    { id: 'c1', file: 'c' }, { id: 'c2', file: 'c' },
  ];
  const order = interleaveByFile(mutants);
  assert.equal(order.length, mutants.length, '轮转不许丢也不许重复');
  assert.deepEqual(order.map((m) => m.id), ['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
  assert.deepEqual(
    new Set(order.slice(0, 3).map((m) => m.file)),
    new Set(['a', 'b', 'c']),
    '前三个就该把三个文件都碰到——不然时间盒一到，后面的文件等于没测',
  );
  assert.deepEqual(interleaveByFile([]), []);
});
