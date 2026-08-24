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
