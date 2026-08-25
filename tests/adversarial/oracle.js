/**
 * 金丝雀 oracle（harness 支柱 D：安全对抗）。
 *
 * 业务 oracle 只能说「结果对不对」；这个 oracle 直接判「注入值有没有逃逸」——
 * 把远端脚本正文按 POSIX 引用规则扫一遍，逐字符标出它处在哪种引用态，再看金丝雀串
 * 落在哪：
 *
 *   single  单引号词内 → 安全。单引号里没有任何展开与元字符语义。
 *   double  双引号内   → 逃逸。`$` / 反引号 / `\` 在双引号里仍然活着。
 *   bare    裸露       → 逃逸。分词、重定向、命令替换全都生效。
 *
 * 再加一层词位判据：金丝雀所在的词若是某条命令的第一个词，则它成了**命令名**——
 * 即便被单引号包着也是逃逸（`'$(x)'` 不会执行，但 `'/bin/sh'` 作为命令名会）。
 *
 * 金丝雀串不许含单引号：shq 会把 `'` 拆成 `'\''`，含引号的串在正文里根本不逐字出现，
 * 无从定位（corpus.js 的形状校验会拦住这种语料）。
 */

/** 引用态。`syntax` 是引号/分隔符本身，不属于任何值。 */
export const MODES = Object.freeze(['bare', 'single', 'double', 'syntax']);

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const COMMAND_BREAK = new Set([';', '&', '|', '(', ')', '\n']);
const WORD_BREAK = new Set(['<', '>']);

/**
 * 逐字符标注引用态 + 切出词与命令边界。
 *
 * 不冒充 sh parser：只处理引用、分词与命令分隔，够 oracle 用。`$(` 里的第一个词会
 * 因为 `(` 被当成命令分隔而落到命令位——对判「有没有逃逸」来说，宁可报得更狠。
 *
 * @param {string} body
 * @returns {{modes:string[], words:Array<{text:string,start:number,end:number,
 *   commandIndex:number,wordIndex:number}>}}
 */
export function scanShell(body) {
  const text = String(body);
  const modes = Array.from({ length: text.length }, () => 'syntax');
  const words = [];
  let current = null;
  let commandIndex = 0;
  let wordsInCommand = 0;
  let quote = null; // null | "'" | '"'

  const startWord = (at) => {
    if (current) return current;
    current = {
      text: '', start: at, end: at, commandIndex, wordIndex: wordsInCommand,
    };
    words.push(current);
    return current;
  };
  const endWord = () => {
    if (!current) return;
    current = null;
    wordsInCommand += 1;
  };
  const endCommand = () => {
    endWord();
    if (wordsInCommand > 0) {
      commandIndex += 1;
      wordsInCommand = 0;
    }
  };
  const take = (at, mode) => {
    const word = startWord(at);
    modes[at] = mode;
    word.text += text[at];
    word.end = at + 1;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else take(i, 'single');
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && i + 1 < text.length) {
        take(i + 1, 'double');
        i += 1;
      } else {
        take(i, 'double');
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      startWord(i);
      continue;
    }
    if (char === '\\' && i + 1 < text.length) {
      take(i + 1, 'bare');
      i += 1;
      continue;
    }
    if (COMMAND_BREAK.has(char)) {
      endCommand();
      continue;
    }
    if (WHITESPACE.has(char)) {
      endWord();
      continue;
    }
    if (WORD_BREAK.has(char)) {
      endWord();
      continue;
    }
    take(i, 'bare');
  }
  return { modes, words };
}

/**
 * 找出金丝雀的每一次出现及其位置性质。
 * @param {string} body
 * @param {string} canary
 * @returns {Array<{index:number, mode:string, commandPosition:boolean, word:string|null}>}
 */
export function locateCanary(body, canary) {
  const text = String(body);
  const needle = String(canary);
  if (needle === '') throw new Error('金丝雀串不能为空');
  const { modes, words } = scanShell(text);
  const out = [];
  let from = text.indexOf(needle);
  while (from !== -1) {
    const span = modes.slice(from, from + needle.length);
    const mode = span.includes('bare')
      ? 'bare'
      : (span.includes('double') ? 'double' : 'single');
    const word = words.find((w) => w.start <= from && w.end >= from + needle.length) ?? null;
    out.push({
      index: from,
      mode,
      commandPosition: word ? word.wordIndex === 0 : true,
      word: word ? word.text : null,
    });
    from = text.indexOf(needle, from + 1);
  }
  return out;
}

/**
 * 逃逸判定。
 * @param {string} body 远端脚本正文
 * @param {string} canary
 * @param {{requireOccurrence?:boolean}} [opts] 默认要求金丝雀确实抵达（否则语料在空转）
 * @returns {{ok:boolean, occurrences:Array<object>, escapes:Array<object>, reason:string|null}}
 */
export function canaryVerdict(body, canary, { requireOccurrence = true } = {}) {
  const occurrences = locateCanary(body, canary);
  if (occurrences.length === 0) {
    return {
      ok: !requireOccurrence,
      occurrences,
      escapes: [],
      reason: requireOccurrence ? '金丝雀没有抵达远端脚本：这条语料没在测任何东西' : null,
    };
  }
  const escapes = occurrences.filter((o) => o.mode !== 'single' || o.commandPosition);
  const reason = escapes.length === 0 ? null : escapes
    .map((o) => `偏移 ${o.index} 落在 ${o.mode}${o.commandPosition ? ' 且处于命令位' : ''}（词：${o.word}）`)
    .join('；');
  return {
    ok: escapes.length === 0, occurrences, escapes, reason,
  };
}

/**
 * argv 层判据（Host 名一类不经 shq、直接进 ssh 参数表的位置）：
 * 金丝雀不许成为命令名，也不许变成选项。
 * @param {string[]} argv
 * @param {string} canary
 */
export function argvCanaryVerdict(argv, canary) {
  const hits = argv
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => String(value).includes(canary));
  const escapes = hits.filter(({ value, index }) => index === 0 || String(value).startsWith('-'));
  return {
    ok: hits.length > 0 && escapes.length === 0,
    hits,
    escapes,
    reason: escapes.length === 0
      ? (hits.length === 0 ? '金丝雀没有抵达 argv' : null)
      : escapes.map((h) => `argv[${h.index}] = ${h.value}`).join('；'),
  };
}
