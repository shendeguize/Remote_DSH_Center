/**
 * 变异算子（mutation-gate 的纯判定层）。
 *
 * 变异测试问的不是「测试跑过了吗」，而是**「把产品代码改坏，测试会不会发现」**。
 * 覆盖率只能证明某一行被执行过；变异测试能证明那一行的**结果**被断言过。
 * 一个被执行了 100 次却从没被断言的分支，覆盖率是 100%，变异测试会立刻把它点出来。
 *
 * 算子表是**白名单**，不是「能改的都改」。挑选标准只有一条：**改坏之后，一个称职的
 * 测试必须能发现**。所以：
 *   - 比较与逻辑运算符互换、边界 ±1、布尔取反、早退语句删除 —— 全都在表里，
 *     它们对应的正是最容易漏断言的那些判据
 *   - 不改字符串字面量（文案变了测试八成不该红，那是等价变异，只会造噪声）
 *   - 不改 `==`/`!=`（本仓不用松散相等，改了也只是造语法上合法的死代码）
 *   - 不碰非代码区（字符串／模板原文／正则／注释）—— 由 `js-scan.mjs` 的掩码保证。
 *     这一条不做的话，`shq.js` 里那些含 `===` 的错误文案会被批量「变异」，
 *     制造出成百条永远杀不掉的假幸存者，闸门的信噪比就没了
 *
 * 等价变异（改了但语义不变，测试永远杀不掉）不可能靠静态规则完全避免——那是
 * `tests/mutation/ALLOWED_SURVIVORS.json` 的活：逐条写清为什么杀不掉。
 */

import { createHash } from 'node:crypto';

import { isCodeSpan, scanJs } from './js-scan.mjs';

/** 参与「最长 run」切分的运算符字符。切成 run 才不会把 `=>` 误当成 `>`。 */
const PUNCT_CHARS = new Set(['=', '!', '<', '>', '&', '|']);

/**
 * run 原文 → 变异结果。只列**恰好**是这些 run 的情形；
 * `=>`、`>>>`、`&&=`、`==`、`!=`、`=` 等一概不在表里，也就一概不变异。
 */
const PUNCT_MUTATIONS = Object.freeze({
  '===': { op: 'eq-to-ne', to: '!==' },
  '!==': { op: 'ne-to-eq', to: '===' },
  '<=': { op: 'le-to-lt', to: '<' },
  '<': { op: 'lt-to-le', to: '<=' },
  '>=': { op: 'ge-to-gt', to: '>' },
  '>': { op: 'gt-to-ge', to: '>=' },
  '&&': { op: 'and-to-or', to: '||' },
  '||': { op: 'or-to-and', to: '&&' },
});

/** 早退语句本体：return / throw / continue / break，正文里不含分号（保守）。 */
const EXIT_STATEMENT = String.raw`(?:return\b[^;]*;|throw\b[^;]*;|continue;|break;)`;
/** 整行恰好是一条早退。 */
const EARLY_EXIT = new RegExp(`^${EXIT_STATEMENT}$`, 'u');
/**
 * 单行守卫子句：`if (…) throw …;`。本仓大量判据是这么写的，
 * 而它恰恰是最该被变异的形态——守卫没了还全绿，说明「非法输入会被拒」从没被断言过。
 * 贪婪的 `.*` 加上尾锚，条件里带括号也能切对（`if (isX(a)) return 1;`）。
 */
const GUARD_CLAUSE = new RegExp(`^if \\(.*\\)\\s+(${EXIT_STATEMENT})$`, 'u');

/** 十进制整数字面量（含数字分隔符）。前后不许接标识符字符或点——那样就是别的东西了。 */
const INT_LITERAL = /\d[\d_]*/gu;

export const OPERATORS = Object.freeze([
  'eq-to-ne', 'ne-to-eq', 'le-to-lt', 'lt-to-le', 'ge-to-gt', 'gt-to-ge',
  'and-to-or', 'or-to-and', 'num-plus-1', 'num-minus-1',
  'true-to-false', 'false-to-true', 'drop-exit',
]);

/**
 * 闸门默认跑的算子——比 `OPERATORS` 少一个 `num-minus-1`，理由是实测出来的：
 * 数字算子占 lib 档变异体的 46%，而 `±1` 两个方向问的是同一个问题
 * （「这个边界有没有被断言过」），留一个方向就够定性。留 `+1` 而不是 `-1`：
 * 把边界**放宽**才是有安全含义的那个方向（本该拒的被放过去了）。
 *
 * `-1` 没删掉，只是不进默认集——想深挖时 `--op num-minus-1` 单独跑。
 */
export const DEFAULT_OPERATORS = Object.freeze(OPERATORS.filter((op) => op !== 'num-minus-1'));

/**
 * @typedef {object} Mutant
 * @property {string} id     稳定键（不含行号，见下）
 * @property {string} file   仓库相对路径
 * @property {string} op     算子 id
 * @property {number} line   行号（1 起；只为可读性，不进 id）
 * @property {number} start  原文区间起
 * @property {number} end    原文区间止
 * @property {string} from   被替换的原文
 * @property {string} to     替换成什么
 * @property {string} code   该行 trim 后的原文（报告里给人看）
 */

/**
 * 枚举一个文件的全部变异体，按出现顺序。
 *
 * @param {string} source
 * @param {{file:string}} opts
 * @returns {Mutant[]}
 */
export function enumerateMutants(source, { file }) {
  const text = String(source);
  const { code } = scanJs(text);
  const lines = lineIndex(text);
  const raw = [];

  /**
   * @param {{whole?:boolean}} [opts] whole=false 只要求区间**起点**在代码区。
   *   删整条语句时用得上：`throw new Error('炸了');` 的正文里当然有字符串，
   *   但那不妨碍整条删掉——要防的只是「这条语句本身其实在注释或模板原文里」。
   */
  const push = (start, end, op, to, { whole = true } = {}) => {
    const inCode = whole ? isCodeSpan(code, start, end) : code[start] === 1;
    if (!inCode) return;
    const line = lines.lineAt(start);
    raw.push({
      file,
      op,
      line,
      start,
      end,
      from: text.slice(start, end),
      to,
      code: lines.textOf(line).trim(),
    });
  };

  collectPunctuators(text, code, push);
  collectLiterals(text, push);
  collectEarlyExits(text, code, lines, push);

  raw.sort((a, b) => a.start - b.start || a.op.localeCompare(b.op));
  return withStableIds(raw);
}

/**
 * 运算符：按「最长 run」切分再整体查表。
 *
 * 为什么不直接正则找 `>`：`=>`、`>=`、`>>>` 里都有 `>`，逐字符匹配会把箭头函数
 * 改成 `=>=`。切成 run 之后 `=>` 整体查不到表，自然一个字都不动。
 */
function collectPunctuators(text, code, push) {
  let i = 0;
  while (i < text.length) {
    if (!PUNCT_CHARS.has(text[i]) || code[i] !== 1) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < text.length && PUNCT_CHARS.has(text[end]) && code[end] === 1) end += 1;
    const run = text.slice(i, end);
    const hit = PUNCT_MUTATIONS[run];
    if (hit) push(i, end, hit.op, hit.to);
    i = end;
  }
}

function collectLiterals(text, push) {
  for (const m of text.matchAll(INT_LITERAL)) {
    const start = m.index;
    const end = start + m[0].length;
    // 前后接了标识符字符或点，说明它是 `a1` / `0x1f` / `1.5` / `1e3` / `1n` 的一部分
    if (/[\w$.]/u.test(text[start - 1] ?? '')) continue;
    if (/[\w$.]/u.test(text[end] ?? '')) continue;
    const value = Number(m[0].replaceAll('_', ''));
    // 超出安全整数范围时 ±1 是恒等变换，造出来的必然是等价变异
    if (!Number.isSafeInteger(value)) continue;
    push(start, end, 'num-plus-1', String(value + 1));
    push(start, end, 'num-minus-1', String(value - 1));
  }

  for (const m of text.matchAll(/\b(?:true|false)\b/gu)) {
    const start = m.index;
    if (text[start - 1] === '.') continue; // 属性名，不是布尔字面量
    push(start, start + m[0].length, m[0] === 'true' ? 'true-to-false' : 'false-to-true', m[0] === 'true' ? 'false' : 'true');
  }
}

/**
 * 早退删除：把整行的 `return …;` / `throw …;` 换成一个空语句。
 *
 * 这一族算子专门打「守卫子句」——`if (!ok) throw …;` 里的 throw 被删掉之后，
 * 只有真的断言过「非法输入会被拒」的测试才会红。校验器最容易在这儿糊。
 *
 * 换成 `;` 而不是整行删掉，是为了在无花括号的 `if (a) return b;` 里仍然合法
 * （`if (a) ;`）；剩下的语法风险由 `node --check` 兜。
 */
function collectEarlyExits(text, code, lines, push) {
  for (let line = 1; line <= lines.count; line += 1) {
    const full = lines.textOf(line);
    const trimmed = full.trim();
    const lineStart = lines.startOf(line) + full.indexOf(trimmed);

    if (EARLY_EXIT.test(trimmed)) {
      push(lineStart, lineStart + trimmed.length, 'drop-exit', ';', { whole: false });
      continue;
    }
    const guard = GUARD_CLAUSE.exec(trimmed);
    if (guard) {
      const start = lineStart + (trimmed.length - guard[1].length);
      push(start, start + guard[1].length, 'drop-exit', ';', { whole: false });
    }
  }
}

/**
 * 变异体的稳定 id：`<文件>|<算子>|<该行内容的哈希>|<同行同算子内的序号>`。
 *
 * **不含行号**——否则在文件开头加一行注释，就会把 ALLOWED_SURVIVORS 里的每一条
 * 豁免都变成悬空引用。反过来，行**内容**变了就该重新发号：那一行的逻辑既然改了，
 * 旧的「为什么杀不掉」的理由也就不再适用，必须让人重新看一眼。
 */
function withStableIds(raw) {
  const seen = new Map();
  return raw.map((mutant) => {
    const anchor = `${mutant.file}|${mutant.op}|${hash8(normalizeLine(mutant.code))}`;
    const nth = seen.get(anchor) ?? 0;
    seen.set(anchor, nth + 1);
    return { ...mutant, id: `${anchor}|${nth}` };
  });
}

/** 空白折叠：改缩进（换个 if 嵌套层级）不该让豁免失效。 */
function normalizeLine(code) {
  return code.replaceAll(/\s+/gu, ' ').trim();
}

export function hash8(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

/** 应用一个变异体，返回变异后的源码。 */
export function applyMutant(source, mutant) {
  const text = String(source);
  const actual = text.slice(mutant.start, mutant.end);
  if (actual !== mutant.from) {
    throw new Error(
      `变异体 ${mutant.id} 与源码对不上：${mutant.start}..${mutant.end} 处是 `
      + `${JSON.stringify(actual)}，登记的是 ${JSON.stringify(mutant.from)}`,
    );
  }
  return text.slice(0, mutant.start) + mutant.to + text.slice(mutant.end);
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return {
    count: starts.length,
    startOf: (line) => starts[line - 1],
    textOf: (line) => {
      const start = starts[line - 1];
      const end = line < starts.length ? starts[line] - 1 : text.length;
      return text.slice(start, end);
    },
    lineAt: (offset) => {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid] <= offset) low = mid;
        else high = mid - 1;
      }
      return low + 1;
    },
  };
}
