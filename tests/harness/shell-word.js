/**
 * POSIX 单引号词解析（src/lib/shq.js 的 shq 的逆）。
 * 单独成文件：垫片主流程在 import 时即执行，纯函数必须可被测试单独 import。
 */
export function unshq(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      i += 1;
      while (i < s.length && s[i] !== "'") { out += s[i]; i += 1; }
      i += 1;
    } else if (s[i] === '\\') {
      out += s[i + 1] ?? '';
      i += 2;
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

/**
 * `cd -- <TOK>` 里 TOK 的反解（workdirToken 的逆）：`"$HOME"` 前缀按远端家目录展开，
 * 其余段走 unshq。真远端由 sh 做这件事，垫片得自己做。
 */
export function unshqWorkdir(tok, home) {
  const HOME_TOK = '"$HOME"';
  return tok.startsWith(HOME_TOK) ? home + unshq(tok.slice(HOME_TOK.length)) : unshq(tok);
}
