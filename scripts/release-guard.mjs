#!/usr/bin/env node
/**
 * 发版守卫：tag 推上来之后、建 GitHub Release 之前把三件事核清楚。
 *
 *   守卫一  tag 名 == v${package.json version}      —— 版本号只有一个源，别对不上
 *   守卫二  CHANGELOG 有对应小节且正文非空          —— 没写变更就不算发版
 *   守卫三  tag 提交 == release HEAD 且包含于 main   —— 双分支同源性没被破坏
 *
 * 三关都过则把 CHANGELOG 小节正文写到 --body-out 指定的文件，供 gh release create
 * 当正文用。任一关红就退 1 并把人话原因打到 stderr。
 *
 * 守卫三需要 git 信息（release HEAD 与 main 的祖先关系），由调用方经参数传入，
 * 本模块只做判定——这样每条规则都能在本机单测里跑到（tests/tooling.test.js）。
 *
 * 用法（release.yml 里）：
 *   node scripts/release-guard.mjs --tag "$GITHUB_REF_NAME" \
 *     --tag-sha "$SHA" --release-sha "$RELEASE_SHA" --in-main true \
 *     --body-out release-body.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `refs/tags/v0.1.0` 或 `v0.1.0` → `0.1.0`；形状不对给 null。
 * 只认 `v` + 三段数字（预发布后缀留到真需要时再放宽，宁可拦住也别放过打错的 tag）。
 * @param {string} ref
 * @returns {string|null}
 */
export function versionFromTag(ref) {
  const name = String(ref ?? '').replace(/^refs\/tags\//, '');
  const m = /^v(\d+\.\d+\.\d+)$/.exec(name);
  return m ? m[1] : null;
}

/**
 * 从 CHANGELOG 里截出某个版本的小节正文（不含标题行）。
 * 小节到下一个 `## ` 标题或链接引用区（`[x]: http…`）为止。
 * @param {string} changelog
 * @param {string} version 形如 0.1.0
 * @returns {string} 去掉首尾空行的正文；没有该小节或正文为空则给 ''
 */
export function extractChangelogSection(changelog, version) {
  const lines = String(changelog ?? '').split('\n');
  // 标题形如 `## [0.1.0] - 2026-08-21`，也容忍不带方括号与日期的写法
  const head = new RegExp(`^##\\s+\\[?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return '';

  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (/^\[[^\]]+\]:\s*\S+/.test(line)) break;
    body.push(line);
  }
  return body.join('\n').replace(/^\s*\n+/, '').replace(/\s+$/, '');
}

/**
 * 三道守卫的判定（纯函数，不碰 IO）。
 * @param {object} input
 * @param {string} input.tag                    GITHUB_REF_NAME
 * @param {string} input.pkgVersion             package.json 的 version
 * @param {string} input.changelog              CHANGELOG.md 全文
 * @param {string|null} [input.tagSha]          tag 指向的提交
 * @param {string|null} [input.releaseSha]      release 分支 HEAD
 * @param {boolean|null} [input.inMain]         tag 提交是否包含于 main
 * @returns {{ok:boolean, version:string|null, body:string, problems:string[]}}
 */
export function evaluateGuards({
  tag, pkgVersion, changelog, tagSha = null, releaseSha = null, inMain = null,
}) {
  const problems = [];
  const version = versionFromTag(tag);

  if (!version) {
    problems.push(`tag「${tag}」不是 v<主>.<次>.<修> 形状，发版 tag 必须形如 v0.1.0`);
  } else if (version !== pkgVersion) {
    problems.push(`tag 是 v${version}，但 package.json 的 version 是 ${pkgVersion}——版本号只认 package.json，先对齐再打 tag`);
  }

  const body = version ? extractChangelogSection(changelog, version) : '';
  if (version && body === '') {
    problems.push(`CHANGELOG.md 里没有 v${version} 的小节，或小节正文是空的——没写变更就不算发版`);
  }

  // 守卫三：两个 sha 都给了才判（本地跑守卫做预检时可以只给前两关）
  if (tagSha && releaseSha && tagSha !== releaseSha) {
    problems.push(`tag 指向 ${tagSha.slice(0, 8)}，但 release 分支 HEAD 是 ${releaseSha.slice(0, 8)}——tag 只许打在 release HEAD 上`);
  }
  if (inMain === false) {
    problems.push('tag 提交不在 main 上——release 只许从 main 快进，出现独有提交说明流程被绕过了');
  }

  return { ok: problems.length === 0, version, body, problems };
}

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

function tri(raw) {
  if (raw === null || raw === undefined) return null;
  return raw === 'true';
}

async function main() {
  const argv = process.argv.slice(2);
  const verdict = evaluateGuards({
    tag: arg(argv, 'tag', ''),
    pkgVersion: JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version,
    changelog: fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8'),
    tagSha: arg(argv, 'tag-sha'),
    releaseSha: arg(argv, 'release-sha'),
    inMain: tri(arg(argv, 'in-main')),
  });

  if (!verdict.ok) {
    process.stderr.write(`发版守卫未过：\n${verdict.problems.map((p) => `  ✘ ${p}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const out = arg(argv, 'body-out');
  if (out) fs.writeFileSync(out, `${verdict.body}\n`);
  process.stdout.write(`发版守卫通过：v${verdict.version}，CHANGELOG 正文 ${verdict.body.split('\n').length} 行${out ? ` → ${out}` : ''}\n`);
}

if (isMainEntry(import.meta.url)) await main();
