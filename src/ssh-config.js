/**
 * ~/.ssh/config 解析 → 主机清单（11 §1.2）。
 * 规则：只收 Host 块；含 * ? ! 的 pattern 剔除；同名后写覆盖；
 * Include 由 loadHosts 展开后逐段调用 parseSshConfig。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {{name:string, hostName?:string, user?:string, port?:number}} SshHost */

const WILDCARD_RE = /[*?!]/;

/**
 * 纯函数：解析文本 → 主机数组。
 * @param {string} text
 * @returns {SshHost[]}
 */
export function parseSshConfig(text) {
  /** @type {Map<string, SshHost>} */
  const hosts = new Map();
  /** @type {string[]} */
  let current = [];

  for (const rawLine of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    // ssh_config 允许 `Key value` 与 `Key=value` 两种形式
    const eq = line.indexOf('=');
    const sp = line.search(/\s/);
    let key;
    let value;
    if (eq !== -1 && (sp === -1 || eq < sp)) {
      key = line.slice(0, eq).trim();
      value = line.slice(eq + 1).trim();
    } else if (sp !== -1) {
      key = line.slice(0, sp).trim();
      value = line.slice(sp + 1).trim();
    } else {
      key = line;
      value = '';
    }

    const lower = key.toLowerCase();

    if (lower === 'host') {
      current = value
        .split(/\s+/)
        .filter((p) => p !== '' && !WILDCARD_RE.test(p));
      for (const name of current) {
        if (!hosts.has(name)) hosts.set(name, { name });
      }
      continue;
    }

    if (lower === 'match') {
      // Match 块的条件语义超出 v1 需要，整块跳过（不归属任何 Host）
      current = [];
      continue;
    }

    if (current.length === 0) continue;

    for (const name of current) {
      const entry = hosts.get(name);
      if (!entry) continue;
      if (lower === 'hostname') entry.hostName = value;
      else if (lower === 'user') entry.user = value;
      else if (lower === 'port') {
        const p = Number.parseInt(value, 10);
        if (Number.isInteger(p) && p >= 1 && p <= 65535) entry.port = p;
      }
    }
  }

  return [...hosts.values()];
}

/** Include 的 glob 只需支持 ssh_config 实际用法：`*` 与 `?`，单层目录内匹配。 */
function expandIncludeGlob(pattern, baseDir) {
  const abs = path.isAbsolute(pattern) ? pattern : path.join(baseDir, pattern);
  if (!/[*?]/.test(abs)) return [abs];

  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && re.test(d.name))
      .map((d) => path.join(dir, d.name))
      .sort();
  } catch {
    return [];
  }
}

function readSegments(file, sshDir, visited, depth, out) {
  if (depth > 3 || visited.has(file)) return;
  visited.add(file);

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  // Include 行按出现顺序原地展开：先把 Include 之前的段落交给解析器，再递归。
  const lines = text.replace(/\r/g, '').split('\n');
  let buffer = [];
  for (const line of lines) {
    const m = /^\s*[Ii]nclude\s+(.+)$/.exec(line);
    if (!m) {
      buffer.push(line);
      continue;
    }
    out.push(buffer.join('\n'));
    buffer = [];
    for (const token of m[1].trim().split(/\s+/)) {
      for (const target of expandIncludeGlob(token, sshDir)) {
        readSegments(target, sshDir, visited, depth + 1, out);
      }
    }
  }
  out.push(buffer.join('\n'));
}

/**
 * 读 ~/.ssh/config，展开 Include（glob，递归深度 ≤3，环路防护：已访问路径集合）。
 * SSH_CONFIG_PATH 环境变量可覆盖（测试隔离用）。
 * @returns {SshHost[]}
 */
export function loadHosts({ configPath, homedir = os.homedir() } = {}) {
  const file = configPath || process.env.DSHC_SSH_CONFIG || path.join(homedir, '.ssh', 'config');
  const sshDir = path.dirname(file);
  /** @type {string[]} */
  const segments = [];
  readSegments(file, sshDir, new Set(), 1, segments);

  /** @type {Map<string, SshHost>} */
  const merged = new Map();
  for (const seg of segments) {
    for (const host of parseSshConfig(seg)) {
      // 同名后写覆盖（只覆盖已给出的字段）
      merged.set(host.name, { ...merged.get(host.name), ...host });
    }
  }
  return [...merged.values()];
}
