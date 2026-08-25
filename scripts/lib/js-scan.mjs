/**
 * JS 源码浅扫描器（闸门专用，零依赖）。
 *
 * 它回答的问题只有一个：**源码里哪些字符是代码，哪些是字符串／模板原文／正则／注释**。
 * 不是 parser，不建 AST，不认语义——但把「跳过非代码区」这件事做对，因为两个闸门
 * 都栽在同一个坑上：
 *
 *   coverage-gate  要找注释里的 coverage suppression pragma，可 `'// c8 ignore next'`
 *                  写在字符串里不算
 *   mutation-gate  要把 `===` 改成 `!==`，可字符串里的 `'==='` 改了等于改文案，
 *                  会平白造出一堆「幸存者」把闸门的信噪比毁掉
 *
 * 以前这套跳过逻辑只长在 coverage-gate 里，且只对外交出 pragma 列表、不交出区间。
 * 第二个消费者一来，要么复制一份（两份逻辑必然漂移），要么把它提到这里。选后者。
 *
 * 边界（都是刻意的，不是遗漏）：
 *   - 不认 JSX、不认 TS（本仓没有），不认 HTML 注释语法
 *   - 正则与除号的歧义靠一套「上一个 token 能否接正则」的启发式判断，不是文法
 *   - 未闭合的字符串／注释按「一直到行尾／文件尾」处理，绝不抛
 */

const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'instanceof', 'new',
  'return', 'throw', 'typeof', 'void', 'yield',
]);
const FOR_HEADER_OPERATORS = new Set(['in', 'of']);
const IDENTIFIER_START = /^(?:[$_]|\p{ID_Start})$/u;
const IDENTIFIER_CONTINUE = /^(?:[$_\u200C\u200D]|\p{ID_Continue})$/u;

/**
 * @typedef {object} JsScan
 * @property {Uint8Array} code 逐字符掩码：1 = 代码，0 = 字符串/模板原文/正则/注释
 * @property {Array<{start:number, end:number, line:number, text:string}>} comments
 *   注释**内容**区间——界符本身不算在内（行注释去掉开头两个斜杠，块注释去掉两端界符）
 */

/**
 * 扫一遍源码。
 *
 * @param {string} source
 * @returns {JsScan}
 */
export function scanJs(source) {
  const text = String(source);
  const code = new Uint8Array(text.length).fill(1);
  const comments = [];

  // 行号按需算：整份源码只算一次前缀表，比每次从头数快得多，也不必为此改调用方
  let lineStarts = null;
  const lineOf = (offset) => {
    if (lineStarts === null) {
      lineStarts = [0];
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '\n') lineStarts.push(i + 1);
      }
    }
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  const blank = (start, end) => {
    for (let i = Math.max(0, start); i < Math.min(end, text.length); i += 1) code[i] = 0;
  };

  const codeFrame = (templateExpression) => ({
    type: 'code',
    templateExpression,
    braces: 0,
    canStartRegex: true,
    afterPropertyAccess: false,
    pendingFor: false,
    parens: [],
  });
  const frames = [codeFrame(false)];
  const top = () => frames[frames.length - 1];
  const codePointAt = (offset) => {
    const value = text.codePointAt(offset);
    return value === undefined ? '' : String.fromCodePoint(value);
  };

  const noteComment = (start, end) => {
    blank(start, end);
    comments.push({
      start, end, line: lineOf(start), text: text.slice(start, end),
    });
  };

  /** `'…'` / `"…"`。未闭合就到行尾收工——源码坏了不是扫描器该抛的错。 */
  const skipQuoted = (start, quote) => {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        if (text[index - 1] === '\r' && text[index] === '\n') index += 1;
      } else if (text[index] === quote) {
        return index + 1;
      } else if (text[index] === '\n' || text[index] === '\r') {
        return index;
      } else {
        index += 1;
      }
    }
    return index;
  };

  const skipRegex = (start) => {
    let index = start + 1;
    let inClass = false;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        index += 2;
      } else if (char === '[') {
        inClass = true;
        index += 1;
      } else if (char === ']' && inClass) {
        inClass = false;
        index += 1;
      } else if (char === '/' && !inClass) {
        index += 1;
        while (/[A-Za-z]/.test(text[index] ?? '')) index += 1;
        return index;
      } else if (char === '\n' || char === '\r') {
        return index;
      } else {
        index += 1;
      }
    }
    return index;
  };

  let index = 0;
  while (index < text.length) {
    const frame = top();
    const char = text[index];
    const next = text[index + 1];
    const codePoint = codePointAt(index);

    if (frame.type === 'template') {
      // 模板原文：`${` 之外的一切都是数据，逐字标 0
      if (char === '\\') {
        blank(index, index + 2);
        index += 2;
      } else if (char === '`') {
        blank(index, index + 1);
        frames.pop();
        index += 1;
      } else if (char === '$' && next === '{') {
        blank(index, index + 2);
        frames.push(codeFrame(true));
        index += 2;
      } else {
        blank(index, index + 1);
        index += 1;
      }
      continue;
    }

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const end = skipQuoted(index, char);
      blank(index, end);
      index = end;
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      continue;
    }
    if (char === '`') {
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      blank(index, index + 1);
      frames.push({ type: 'template' });
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      const contentStart = index + 2;
      blank(index, contentStart);
      let end = text.indexOf('\n', contentStart);
      if (end === -1) end = text.length;
      noteComment(contentStart, end);
      index = end;
      continue;
    }
    if (char === '/' && next === '*') {
      const contentStart = index + 2;
      const close = text.indexOf('*/', contentStart);
      const contentEnd = close === -1 ? text.length : close;
      blank(index, contentStart);
      noteComment(contentStart, contentEnd);
      const end = close === -1 ? text.length : close + 2;
      blank(contentEnd, end);
      index = end;
      continue;
    }
    if (char === '/') {
      if (frame.canStartRegex) {
        const end = skipRegex(index);
        blank(index, end);
        index = end;
        frame.canStartRegex = false;
      } else {
        index += 1;
        frame.canStartRegex = true;
      }
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      continue;
    }
    if (IDENTIFIER_START.test(codePoint)) {
      const start = index;
      index += codePoint.length;
      while (IDENTIFIER_CONTINUE.test(codePointAt(index))) {
        index += codePointAt(index).length;
      }
      const word = text.slice(start, index);
      const propertyName = frame.afterPropertyAccess;
      const inForHeader = frame.parens.includes('for');
      const precededByExpression = !frame.canStartRegex;
      frame.afterPropertyAccess = false;
      if (!propertyName && word === 'for') {
        frame.pendingFor = true;
        frame.canStartRegex = true;
      } else if (!propertyName && frame.pendingFor && word === 'await') {
        frame.canStartRegex = true;
      } else {
        frame.pendingFor = false;
        frame.canStartRegex = !propertyName && (
          REGEX_PREFIX_KEYWORDS.has(word)
          || (inForHeader && precededByExpression && FOR_HEADER_OPERATORS.has(word))
        );
      }
      continue;
    }
    if (/[0-9]/.test(char)) {
      index += 1;
      while (/[A-Za-z0-9_.]/.test(text[index] ?? '')) index += 1;
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      continue;
    }
    if (char === '(') {
      frame.parens.push(frame.pendingFor ? 'for' : 'normal');
      frame.canStartRegex = true;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      index += 1;
      continue;
    }
    if (char === ')') {
      frame.parens.pop();
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      index += 1;
      continue;
    }
    if (char === '.' && next === '.' && text[index + 2] === '.') {
      frame.canStartRegex = true;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      index += 3;
      continue;
    }
    if (char === '.' && /[0-9]/.test(next ?? '')) {
      index += 2;
      while (/[0-9_]/.test(text[index] ?? '')) index += 1;
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      continue;
    }
    if (char === '.' || (
      char === '?' && next === '.' && !/[0-9]/.test(text[index + 2] ?? '')
    )) {
      frame.canStartRegex = false;
      frame.afterPropertyAccess = true;
      frame.pendingFor = false;
      index += char === '.' ? 1 : 2;
      continue;
    }
    if (frame.templateExpression && char === '}') {
      if (frame.braces === 0) {
        blank(index, index + 1);
        frames.pop();
      } else {
        frame.braces -= 1;
        frame.canStartRegex = false;
        frame.afterPropertyAccess = false;
        frame.pendingFor = false;
      }
      index += 1;
      continue;
    }
    if (char === '{') {
      if (frame.templateExpression) frame.braces += 1;
      frame.canStartRegex = true;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      index += 1;
      continue;
    }
    if (char === ']' || char === '}') {
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      index += 1;
      continue;
    }
    if ((char === '+' || char === '-') && next === char) {
      frame.canStartRegex = false;
      frame.afterPropertyAccess = false;
      frame.pendingFor = false;
      index += 2;
      continue;
    }
    frame.canStartRegex = true;
    frame.afterPropertyAccess = false;
    frame.pendingFor = false;
    index += 1;
  }

  return { code, comments };
}

/**
 * 该区间是否整段都是代码。`[start, end)`，越界即判否。
 * @param {Uint8Array} mask
 */
export function isCodeSpan(mask, start, end) {
  if (start < 0 || end > mask.length || start >= end) return false;
  for (let i = start; i < end; i += 1) {
    if (mask[i] !== 1) return false;
  }
  return true;
}
