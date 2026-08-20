#!/usr/bin/env node
/**
 * 统一质量闸门：一条命令跑完发版前该跑的所有东西，给一份摘要与一个退出码。
 *
 * 分五关，任一关红就整体红（退出码 1）：
 *   tests     全量测试 + 三档覆盖率门槛（架构护栏用例也在这一关里）
 *   ui        真浏览器冒烟（无头 Chrome + CDP）；没装 Chrome 则跳过，除非 --require-browser
 *   site      站点构建 + 无头 demo 冒烟 + 双语 README 链接与命令核对
 *   pack      npm 打包产物清单核对：该进的都在、tests/.local 之类别混进去
 *   cli       装出来的 dshc 能被 node 直接执行（--help 走通）
 *
 * 真机验收（scripts/real-acceptance.mjs）不在这里：它要连共享远端，得由人挑时机跑。
 *
 * 用法：
 *   npm run check                    # 全部
 *   npm run check -- --only tests    # 只跑某几关（逗号分隔）
 *   npm run check -- --skip ui
 *   npm run check -- --require-browser   # CI 上要求 Chrome 必须在
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';

import { findChrome } from './ui-smoke.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 打包产物必须包含 / 必须排除的路径（前缀匹配）。
 *
 * 这张表同时是发布包 app/ 的内容口径（scripts/build-bundle.mjs 直接用 npm pack 的
 * 清单并过 verifyPackFiles）——两处各写一份白名单迟早对不上，而且「发布包里多了
 * tests/」这种事没人会注意到。
 *
 * `scripts/install.mjs` 必须在内：发布包里还要靠它摘链/重链/装服务（安装规则只有一份）。
 */
export const PACK_RULES = Object.freeze({
  required: [
    'package.json', 'README.md', 'LICENSE',
    'src/cli.js', 'src/server.js', 'src/web/index.html', 'src/web/style.css',
    'scripts/install.mjs',
  ],
  forbidden: ['tests/', '.local/', 'scripts/real-acceptance', '.github/'],
});

/**
 * @param {string[]} files npm pack 报出的文件清单
 * @returns {{ok:boolean, missing:string[], leaked:string[], count:number}}
 */
export function verifyPackFiles(files) {
  const missing = PACK_RULES.required.filter((r) => !files.includes(r));
  const leaked = files.filter((f) => PACK_RULES.forbidden.some((p) => f.startsWith(p)));
  return { ok: missing.length === 0 && leaked.length === 0, missing, leaked, count: files.length };
}

/**
 * 关卡选择：--only 与 --skip 都按 id 匹配，未知 id 直接报错（打错字不该被静默忽略）。
 * @param {Array<{id:string}>} stages
 * @param {{only?:string|null, skip?:string|null}} [sel]
 */
export function selectStages(stages, { only = null, skip = null } = {}) {
  const ids = new Set(stages.map((s) => s.id));
  const parse = (raw, label) => {
    if (!raw) return null;
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((id) => !ids.has(id));
    if (bad.length > 0) throw new Error(`${label} 里有未知关卡：${bad.join(', ')}（可选：${[...ids].join(', ')}）`);
    return new Set(list);
  };
  const keep = parse(only, '--only');
  const drop = parse(skip, '--skip');
  return stages.filter((s) => (keep ? keep.has(s.id) : true) && !(drop?.has(s.id)));
}

export function summarize(results) {
  const width = Math.max(...results.map((r) => r.label.length));
  const mark = { pass: '✔', fail: '✘', skip: '·' };
  const lines = results.map((r) => {
    const secs = `${(r.ms / 1000).toFixed(1)}s`.padStart(7);
    return `${mark[r.status]} ${r.label.padEnd(width)} ${secs}  ${r.note}`;
  });
  return lines.join('\n');
}

// ── 关卡实现 ─────────────────────────────────────────────────────────────

function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: REPO,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
    }
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: String(err.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const node = (script, args = [], opts) => run(process.execPath, [path.join(REPO, 'scripts', script), ...args], opts);

const STAGES = [
  {
    id: 'tests',
    label: '全量测试 + 覆盖率门槛',
    async run() {
      const res = await node('coverage-gate.mjs');
      if (res.code !== 0) throw new Error('测试或覆盖率门槛未过（详见上方输出）');
      return '三档达标';
    },
  },
  {
    id: 'ui',
    label: '真浏览器冒烟',
    async run({ requireBrowser }) {
      const chrome = findChrome();
      if (!chrome) {
        if (requireBrowser) throw new Error('未找到 Chrome/Chromium，而 --require-browser 已开');
        return { skipped: '未装 Chrome，已跳过（要求必跑就加 --require-browser）' };
      }
      const res = await node('ui-smoke.mjs');
      if (res.code !== 0) throw new Error('浏览器冒烟未过（详见上方输出）');
      return path.basename(chrome);
    },
  },
  {
    id: 'site',
    // 交接面也要有人把关：README 里写错的命令、站点里断掉的链接、
    // demo 因为前端改动而打不开——这三样全靠这一关拦住。
    label: '站点与文档',
    async run({ requireBrowser }) {
      const args = requireBrowser ? ['--require-browser'] : [];
      const res = await node('site-check.mjs', args);
      if (res.code !== 0) throw new Error('站点或文档检查未过（详见上方输出）');
      return findChrome() ? '构建 + demo 冒烟 + 双语文档' : '构建 + 双语文档（无 Chrome，demo 冒烟已跳过）';
    },
  },
  {
    id: 'pack',
    label: '打包产物清单',
    async run() {
      const res = await run('npm', ['pack', '--dry-run', '--json'], { capture: true });
      if (res.code !== 0) throw new Error(`npm pack 失败：${res.stderr.trim().split('\n').pop()}`);
      let files;
      try {
        files = JSON.parse(res.stdout)[0].files.map((f) => f.path);
      } catch {
        throw new Error('npm pack --json 输出无法解析');
      }
      const verdict = verifyPackFiles(files);
      if (verdict.missing.length > 0) throw new Error(`产物缺文件：${verdict.missing.join(', ')}`);
      if (verdict.leaked.length > 0) throw new Error(`产物混入了不该发的：${verdict.leaked.slice(0, 5).join(', ')}`);
      return `${verdict.count} 个文件`;
    },
  },
  {
    id: 'cli',
    label: 'CLI 入口可执行',
    async run() {
      const res = await run(process.execPath, [path.join(REPO, 'src', 'cli.js'), '--help'], { capture: true });
      if (res.code !== 0) throw new Error(`dshc --help 退出码 ${res.code}：${res.stderr.trim()}`);
      if (!res.stdout.includes('dshc')) throw new Error('dshc --help 没吐出用法文本');
      return '用法可打印';
    },
  },
];

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(`--${name}`);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
  };

  if (flag('list')) {
    process.stdout.write(`${STAGES.map((s) => `${s.id.padEnd(6)} ${s.label}`).join('\n')}\n`);
    return;
  }

  let stages;
  try {
    stages = selectStages(STAGES, { only: opt('only'), skip: opt('skip') });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 3;
    return;
  }

  const requireBrowser = flag('require-browser');
  const results = [];
  for (const stage of stages) {
    process.stdout.write(`\n── ${stage.label} ${'─'.repeat(Math.max(0, 56 - stage.label.length))}\n`);
    const started = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop -- 关卡按顺序跑，前一关红了后面的结论没意义
      const out = await stage.run({ requireBrowser });
      const skipped = typeof out === 'object' && out?.skipped;
      results.push({
        id: stage.id, label: stage.label, status: skipped ? 'skip' : 'pass', note: skipped || out, ms: Date.now() - started,
      });
    } catch (err) {
      results.push({
        id: stage.id, label: stage.label, status: 'fail', note: err.message, ms: Date.now() - started,
      });
      break; // 快败：后面的关卡结论已无参考价值
    }
  }

  const skippedStages = stages.slice(results.length).map((s) => s.label);
  process.stdout.write(`\n\n检查结果：\n${summarize(results)}\n`);
  if (skippedStages.length > 0) process.stdout.write(`（因前面失败未跑：${skippedStages.join('、')}）\n`);

  const failed = results.filter((r) => r.status === 'fail');
  if (failed.length > 0) {
    process.stdout.write(`\n未通过：${failed.map((f) => f.label).join('、')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n全部通过。\n');
}

if (isMainEntry(import.meta.url)) await main();
