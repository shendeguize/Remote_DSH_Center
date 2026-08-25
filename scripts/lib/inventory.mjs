/**
 * 行为清单提取器（harness 支柱 B：功能覆盖）。
 *
 * 覆盖率闸门只管「行」；这里管「行为面」——从源码里把外部可观察的行为清单**算**出来，
 * 而不是靠人记：
 *   API   src/api.js 的路由表
 *   FSM   src/lib/machine.js 的 TRANSITIONS 全表
 *   SCN   tests/harness/scenarios.js 的场景表
 *   EXIT  src/lib/proto.js 远端脚本占用的退出码
 *   ERR   src/lib/errors.js 的错误码表
 *   CLI   src/cli.js 的命令表
 *
 * 纯模块（能 import 的表就直接 import，只有嵌在模板/字面量里的才静态抽取），
 * 由 scripts/matrix-gate.mjs 与 tests/architecture.test.js 消费；src/ 不许引它。
 */

import fs from 'node:fs';
import path from 'node:path';

import { TRANSITIONS } from '../../src/lib/machine.js';
import { ERROR_HTTP_STATUS } from '../../src/lib/errors.js';
import { SCENARIOS } from '../../tests/harness/scenarios.js';

/** 清单面。顺序即报告顺序。 */
export const SURFACES = Object.freeze(['API', 'FSM', 'SCN', 'EXIT', 'ERR', 'CLI']);

/**
 * 路由表抽取：`['GET', /^\/api\/hosts\/([^/]+)\/log$/, …]`。
 * 正则转回可读路径，`([^/]+)` 归一为 `:name`——矩阵里写的是人能认的那一份。
 * @param {string} source src/api.js 正文
 * @returns {string[]} 形如 'GET /api/hosts/:name/log'
 */
export function apiRoutesFrom(source) {
  const out = [];
  for (const m of String(source).matchAll(/\[\s*'([A-Z]+)'\s*,\s*\/\^(.+?)\$\/\s*,/gu)) {
    const method = m[1];
    const routePath = m[2]
      .replaceAll('\\/', '/')
      .replaceAll('([^/]+)', ':name');
    out.push(`${method} ${routePath}`);
  }
  return out;
}

/**
 * 远端脚本的退出码占用表。协议模板是字符串，只能静态抽：`exit 8`、`exit 12`。
 * 新增分支撞号的第一现场就是这张表（AGENTS.md「退出码占用表」）。
 * @param {string} source src/lib/proto.js 正文
 * @returns {number[]} 升序去重
 */
export function protoExitCodesFrom(source) {
  const codes = new Set();
  for (const m of String(source).matchAll(/\bexit\s+(\d+)\b/gu)) {
    const code = Number(m[1]);
    if (code > 0) codes.add(code);
  }
  return [...codes].sort((a, b) => a - b);
}

/**
 * CLI 命令表。直接 import src/cli.js 会把 store/api 一起拉起来（且它有入口副作用），
 * 故只静态读 `export const COMMANDS = { … }` 这一段的顶层键。
 * @param {string} source src/cli.js 正文
 * @returns {string[]}
 */
export function cliCommandsFrom(source) {
  const text = String(source);
  const start = text.indexOf('export const COMMANDS = {');
  if (start === -1) throw new Error('src/cli.js 里找不到 COMMANDS 表，行为清单无法提取');
  const body = text.slice(start);
  const out = [];
  let depth = 0;
  for (const line of body.split('\n')) {
    const opens = (line.match(/\{/gu) ?? []).length;
    const closes = (line.match(/\}/gu) ?? []).length;
    if (depth === 1) {
      const m = /^\s{2}([A-Za-z][\w-]*)\s*:\s*\{/u.exec(line);
      if (m) out.push(m[1]);
    }
    depth += opens - closes;
    if (depth <= 0 && out.length > 0) break;
  }
  if (out.length === 0) throw new Error('COMMANDS 表形状不符，抽不出命令名');
  return out;
}

/** FSM 迁移 id（`from→to`），自环只有出现在 TRANSITIONS 里才登记。 */
export function fsmTransitions(transitions = TRANSITIONS) {
  const out = [];
  for (const [from, tos] of Object.entries(transitions)) {
    for (const to of tos) out.push(`${from}→${to}`);
  }
  return out;
}

const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');

/**
 * 汇总全部行为面。
 * @param {string} root 仓库根
 * @returns {{items: Array<{surface:string, id:string, key:string, origin:string}>,
 *   bySurface: Record<string, string[]>}}
 */
export function collectInventory(root) {
  const bySurface = {
    API: apiRoutesFrom(read(root, 'src/api.js')),
    FSM: fsmTransitions(),
    SCN: Object.keys(SCENARIOS),
    EXIT: protoExitCodesFrom(read(root, 'src/lib/proto.js')).map(String),
    ERR: Object.keys(ERROR_HTTP_STATUS),
    CLI: cliCommandsFrom(read(root, 'src/cli.js')),
  };
  const origin = {
    API: 'src/api.js',
    FSM: 'src/lib/machine.js',
    SCN: 'tests/harness/scenarios.js',
    EXIT: 'src/lib/proto.js',
    ERR: 'src/lib/errors.js',
    CLI: 'src/cli.js',
  };
  const items = [];
  for (const surface of SURFACES) {
    const ids = bySurface[surface] ?? [];
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) continue; // 同一行为登记一次就够（重复出现不是新行为）
      seen.add(id);
      items.push({
        surface, id, key: `${surface}:${id}`, origin: origin[surface],
      });
    }
  }
  return { items, bySurface };
}
