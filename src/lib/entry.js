/**
 * 「这个模块是不是被直接执行的」判定。
 *
 * 看似 `process.argv[1] === fileURLToPath(import.meta.url)` 就够，实则不够：
 * 装到 PATH 的入口是一条软链（`npm link` 与 scripts/install.mjs 都这么干），
 * 此时 argv[1] 是链接名（如 ~/.local/bin/dshc），而 import.meta.url 已经是
 * 解引用后的真身（src/cli.js）——只比字面路径会判成「被 import」，于是
 * 命令什么都不做、还退 0，排查起来极难。故两边都取 realpath 再比。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {string} importMetaUrl 调用方的 import.meta.url */
export function isMainEntry(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return realOf(argv1) === realOf(fileURLToPath(importMetaUrl));
}

function realOf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
