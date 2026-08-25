#!/usr/bin/env node
/**
 * 行为清单闸门（harness 支柱 B：功能覆盖）。
 *
 * 覆盖率闸门数的是「行」，这一关数的是「行为」：把 scripts/lib/inventory.mjs 从源码
 * 算出来的行为清单，与 tests/COVERAGE_MATRIX.md 登记的 ID 三方对账：
 *
 *   1. 清单里有、矩阵没登记 → 红「新增行为未登记」（加了路由/场景/退出码却没写矩阵）
 *   2. 矩阵登记了、清单里没有 → 红「死行为」（代码删了，矩阵还留着）
 *   3. 矩阵引用的 tests/ scripts/ src/ site/ 路径不存在 → 红「矩阵引用悬空」
 *
 * 登记形式是行内 code span：`API:GET /api/hosts`、`FSM:running→degraded`、
 * `SCN:pid-reuse`、`EXIT:8`、`ERR:KILL_REFUSED`、`CLI:start`。
 * 只认自动化覆盖不了、写明理由的豁免：同一行带 `EXEMPT(真机)：…` 一类标记。
 *
 * 用法：
 *   npm run matrix:gate
 *   npm run matrix:gate -- --suggest    # 未登记项 + 候选测试文件，供补矩阵时抄
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { collectInventory, SURFACES } from './lib/inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MATRIX_FILE = 'tests/COVERAGE_MATRIX.md';

/** 只核对这几个目录下的引用：其余 code span 是命令、配置路径、包名等，不该当文件判。 */
const REF_PREFIXES = ['tests/', 'scripts/', 'src/', 'site/', '.github/'];
const REF_EXT = /\.(?:js|mjs|json|md|html|css|yml|yaml|svg|sh)$/u;

/**
 * 抽取矩阵里的行为 ID 登记。
 * @param {string} text
 * @returns {Array<{key:string, surface:string, id:string, line:number, exempt:string|null}>}
 */
export function parseRegistrations(text) {
  const out = [];
  const lines = String(text).split('\n');
  const surfaces = SURFACES.join('|');
  const re = new RegExp(`\`(${surfaces}):([^\`]+)\``, 'gu');
  lines.forEach((line, index) => {
    const exempt = /EXEMPT\(([^)]*)\)[：:]\s*(\S.*?)\s*(?:\||$)/u.exec(line);
    for (const m of line.matchAll(re)) {
      out.push({
        key: `${m[1]}:${m[2]}`,
        surface: m[1],
        id: m[2],
        line: index + 1,
        exempt: exempt ? `${exempt[1]}：${exempt[2]}` : null,
      });
    }
  });
  return out;
}

/** 形状不完整的豁免标记（没写理由）也要红：豁免必须留下为什么。 */
export function parseBadExemptions(text) {
  const bad = [];
  String(text).split('\n').forEach((line, index) => {
    for (const m of line.matchAll(/EXEMPT\(([^)]*)\)([：:])?\s*([^|]*)/gu)) {
      const reason = (m[3] ?? '').trim();
      if (m[1].trim() === '' || !m[2] || reason === '') {
        bad.push({ line: index + 1, text: line.trim() });
      }
    }
  });
  return bad;
}

/**
 * 抽取矩阵里引用的仓库内路径（code span 内）。glob 形态原样返回，由调用方解析。
 * @param {string} text
 * @returns {Array<{ref:string, line:number}>}
 */
export function parseFileRefs(text) {
  const out = [];
  const seen = new Set();
  String(text).split('\n').forEach((line, index) => {
    for (const m of line.matchAll(/`([^`\s]+)`/gu)) {
      const ref = m[1];
      if (!REF_PREFIXES.some((p) => ref.startsWith(p))) continue;
      if (!ref.includes('*') && !REF_EXT.test(ref)) continue;
      const key = `${ref}@${index + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref, line: index + 1 });
    }
  });
  return out;
}

/**
 * 极简 glob：只支持路径段内 `*` 与整段 `**`。够矩阵里那几种写法用，不引入依赖。
 * @param {string} pattern 仓库相对
 * @param {string} root
 * @returns {boolean} 是否至少命中一个真实条目
 */
export function globHasMatch(pattern, root) {
  const segments = pattern.split('/').filter((s) => s !== '');
  const walk = (dir, index) => {
    if (index >= segments.length) return true;
    const segment = segments[index];
    if (segment === '**') {
      if (index === segments.length - 1) return fs.existsSync(dir);
      const stack = [dir];
      while (stack.length > 0) {
        const current = stack.pop();
        if (walk(current, index + 1)) return true;
        let entries = [];
        try {
          entries = fs.readdirSync(current, { withFileTypes: true });
        } catch { continue; }
        for (const entry of entries) {
          if (entry.isDirectory()) stack.push(path.join(current, entry.name));
        }
      }
      return false;
    }
    if (!segment.includes('*')) return walk(path.join(dir, segment), index + 1);
    const re = new RegExp(`^${segment.split('*').map((s) => s.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*')}$`, 'u');
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return false; }
    return entries.some((entry) => re.test(entry.name) && walk(path.join(dir, entry.name), index + 1));
  };
  return walk(root, 0);
}

const refExists = (ref, root) => (ref.includes('*')
  ? globHasMatch(ref, root)
  : fs.existsSync(path.join(root, ...ref.split('/'))));

/**
 * 纯判定：清单 × 登记 × 引用 → 结论。主流程只负责读文件与打印。
 * @param {{items:Array<{key:string,surface:string,id:string,origin:string}>}} inventory
 * @param {ReturnType<typeof parseRegistrations>} registrations
 * @param {Array<{ref:string, line:number}>} refs
 * @param {(ref:string) => boolean} exists
 * @param {ReturnType<typeof parseBadExemptions>} [badExemptions]
 */
export function matrixVerdict(inventory, registrations, refs, exists, badExemptions = []) {
  const registered = new Map();
  for (const entry of registrations) {
    if (!registered.has(entry.key)) registered.set(entry.key, entry);
  }
  const known = new Set(inventory.items.map((item) => item.key));

  const unregistered = inventory.items.filter((item) => !registered.has(item.key));
  const dead = [...registered.values()].filter((entry) => !known.has(entry.key));
  const dangling = refs.filter((entry) => !exists(entry.ref));
  const exempt = [...registered.values()].filter((entry) => entry.exempt !== null);

  const ok = unregistered.length === 0
    && dead.length === 0
    && dangling.length === 0
    && badExemptions.length === 0;
  return {
    ok,
    total: inventory.items.length,
    registered: registered.size,
    unregistered,
    dead,
    dangling,
    exempt,
    badExemptions,
  };
}

export function formatVerdict(verdict) {
  const lines = [];
  const bySurface = new Map();
  for (const item of verdict.unregistered) {
    bySurface.set(item.surface, [...(bySurface.get(item.surface) ?? []), item.id]);
  }
  lines.push(`行为清单：${verdict.total} 项，矩阵登记 ${verdict.registered} 项（其中豁免 ${verdict.exempt.length} 项）`);
  if (verdict.unregistered.length > 0) {
    lines.push(`✘ 新增行为未登记 ${verdict.unregistered.length} 项（写进 ${MATRIX_FILE}，或标注 EXEMPT(真机)：理由）：`);
    for (const [surface, ids] of bySurface) {
      lines.push(`    ${surface}: ${ids.map((id) => `\`${surface}:${id}\``).join('、')}`);
    }
  }
  if (verdict.dead.length > 0) {
    lines.push(`✘ 死行为 ${verdict.dead.length} 项（代码里已经没有，矩阵还登记着）：`);
    for (const entry of verdict.dead) lines.push(`    ${MATRIX_FILE}:${entry.line} \`${entry.key}\``);
  }
  if (verdict.dangling.length > 0) {
    lines.push(`✘ 矩阵引用悬空 ${verdict.dangling.length} 处（文件/glob 没有对应物）：`);
    for (const entry of verdict.dangling) lines.push(`    ${MATRIX_FILE}:${entry.line} ${entry.ref}`);
  }
  if (verdict.badExemptions.length > 0) {
    lines.push(`✘ 豁免没写理由 ${verdict.badExemptions.length} 处（EXEMPT(原因)：一句话为什么自动化覆盖不了）：`);
    for (const entry of verdict.badExemptions) lines.push(`    ${MATRIX_FILE}:${entry.line} ${entry.text}`);
  }
  if (verdict.ok) lines.push('✔ 行为清单与矩阵一致，引用全部落地。');
  return lines.join('\n');
}

// ── --suggest：给未登记项找候选测试，供补矩阵时抄 ─────────────────────────

function probeTokens(item) {
  switch (item.surface) {
    case 'API': return item.id.split(' ')[1].split('/:name').flatMap((s) => (s ? [s] : []));
    case 'FSM': return item.id.split('→');
    case 'SCN': return [`'${item.id}'`];
    case 'EXIT': return [`exit ${item.id}`];
    case 'ERR': return [item.id];
    case 'CLI': return [`'${item.id}'`];
    default: return [item.id];
  }
}

function sourceIndex(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|mjs)$/u.test(entry.name)) {
        out.push({
          file: path.relative(root, full).split(path.sep).join('/'),
          text: fs.readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(path.join(root, 'tests'));
  walk(path.join(root, 'scripts'));
  return out;
}

function suggest(verdict, root) {
  const index = sourceIndex(root);
  const lines = ['', '候选覆盖（含全部 probe token 的文件，仅供参考，须人工确认）：'];
  for (const item of verdict.unregistered) {
    const tokens = probeTokens(item);
    const hits = index
      .filter(({ text }) => tokens.every((token) => text.includes(token)))
      .map(({ file }) => file)
      .slice(0, 4);
    lines.push(`| \`${item.key}\` | ${hits.map((f) => `\`${f}\``).join('、') || '（无候选：可能真的没测）'} |`);
  }
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const text = fs.readFileSync(path.join(ROOT, ...MATRIX_FILE.split('/')), 'utf8');
  const verdict = matrixVerdict(
    collectInventory(ROOT),
    parseRegistrations(text),
    parseFileRefs(text),
    (ref) => refExists(ref, ROOT),
    parseBadExemptions(text),
  );
  process.stdout.write(`\n${formatVerdict(verdict)}\n`);
  if (argv.includes('--suggest') && verdict.unregistered.length > 0) {
    process.stdout.write(`${suggest(verdict, ROOT)}\n`);
  }
  if (!verdict.ok) process.exitCode = 1;
}

if (isMainEntry(import.meta.url)) await main();
