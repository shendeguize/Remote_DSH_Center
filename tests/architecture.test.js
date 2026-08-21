/**
 * 架构护栏（ENG-24）：依赖图无环 + 分层不倒挂 + 零 npm 依赖。
 *
 * 11 §1 把模块签名与依赖方向定死了；这些约束一旦破了，
 * 表现是「某天 import 顺序一改就炸」这类极难定位的问题，所以让测试盯住。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateTiers, parseLcov, TIERS } from '../scripts/coverage-gate.mjs';

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

// ── 覆盖率门槛脚本自身的判定（TST-07） ────────────────────────────────────

const LCOV = [
  'TN:',
  'SF:src/lib/shq.js',
  'DA:1,1', 'DA:2,1', 'DA:3,0', 'DA:4,1', 'DA:5,1', 'DA:6,1', 'DA:7,1', 'DA:8,1', 'DA:9,1', 'DA:10,1',
  'end_of_record',
  'TN:',
  'SF:src/tunnel.js',
  'DA:1,1', 'DA:2,0', 'DA:3,0', 'DA:4,1',
  'end_of_record',
  'TN:',
  'SF:src/web/router.js',
  'DA:1,1', 'DA:2,1', 'DA:3,1', 'DA:4,1', 'DA:5,0',
  'end_of_record',
  'TN:',
  'SF:src/web/components/tabbar.js',
  'DA:1,0', 'DA:2,0', 'DA:3,0', 'DA:4,1',
  'end_of_record',
  '',
].join('\n');

test('parseLcov 逐文件算行覆盖', () => {
  const parsed = parseLcov(LCOV);
  assert.deepEqual(parsed.map((f) => f.file), ['src/lib/shq.js', 'src/tunnel.js', 'src/web/router.js', 'src/web/components/tabbar.js']);
  assert.equal(parsed[0].pct, 90);
  assert.equal(parsed[1].pct, 50);
});

test('三档门槛各判各的，components 只报告不设卡', () => {
  const tiers = evaluateTiers(parseLcov(LCOV));
  const byId = Object.fromEntries(tiers.map((t) => [t.id, t]));

  assert.equal(byId.lib.min, 90);
  assert.equal(byId.lib.ok, true, '90% 刚好达标');
  assert.equal(byId.modules.ok, false, '50% 该被卡住');
  assert.equal(byId['web-logic'].ok, true, '80% 刚好达标');
  assert.equal(byId['web-components'].ok, true, '组件层只报告');
  assert.equal(byId['web-components'].min, null);
  assert.equal(byId['web-logic'].files, 1, 'components 不能混进 web-logic 档');
});

test('门槛表覆盖 14 §6 的三档', () => {
  assert.deepEqual(TIERS.filter((t) => t.min !== null).map((t) => t.min).sort((a, b) => a - b), [75, 80, 90]);
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
