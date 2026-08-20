#!/usr/bin/env node
/**
 * 发版守卫：tag 推上来之后、建 GitHub Release 之前把三件事核清楚。
 *
 *   守卫一  tag 名 == v${package.json version}      —— 版本号只有一个源，别对不上
 *   守卫二  CHANGELOG 有对应小节且正文非空          —— 没写变更就不算发版
 *   守卫三  tag 提交包含于 main；**正式版**还要求正在 release HEAD 上
 *
 * 三关都过则把 CHANGELOG 小节正文写到 --body-out 指定的文件，供 gh release create
 * 当正文用。任一关红就退 1 并把人话原因打到 stderr。
 *
 * 预发布（`v0.2.0-rc.1`）与正式版的区别只在守卫三：rc 是拿给人试的，**不动稳定指针**，
 * 所以只要求它出自 main，不要求 release 分支跟着走；正式版仍必须打在 release HEAD 上。
 * 除此之外 rc 与正式版一视同仁——版本号要对得上，CHANGELOG 要写。
 *
 * 守卫三需要 git 信息（release HEAD 与 main 的祖先关系），由调用方经参数传入，
 * 本模块只做判定——这样每条规则都能在本机单测里跑到（tests/tooling.test.js）。
 *
 * 用法（release.yml 里）：
 *   node scripts/release-guard.mjs --tag "$GITHUB_REF_NAME" \
 *     --tag-sha "$SHA" --release-sha "$RELEASE_SHA" --in-main true \
 *     --body-out release-body.md --vars-out "$GITHUB_OUTPUT"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { parseVersion } from '../src/lib/semver.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `refs/tags/v0.2.0-rc.1` 或 `v0.1.0` → `0.2.0-rc.1` / `0.1.0`；形状不对给 null。
 *
 * 形状判定借 `src/lib/semver.js`，不在这里另写一条正则——「什么是合法版本号」
 * 有两份定义的话，迟早出现「更新逻辑认、守卫不认」的 tag。这里额外要求：
 * 必须带 `v` 前缀（tag 命名口径），不许带 build 元数据（`+xxx` 不参与比较，
 * 但 package.json 的 version 里不会有它，放过去只会让守卫一莫名其妙地红）。
 * @param {string} ref
 * @returns {string|null}
 */
export function versionFromTag(ref) {
  const name = String(ref ?? '').replace(/^refs\/tags\//, '');
  if (!name.startsWith('v')) return null;
  const parsed = parseVersion(name);
  if (!parsed || parsed.build !== null) return null;
  return parsed.version;
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
 * @returns {{ok:boolean, version:string|null, prerelease:boolean, body:string,
 *   problems:string[]}}
 */
export function evaluateGuards({
  tag, pkgVersion, changelog, tagSha = null, releaseSha = null, inMain = null,
}) {
  const problems = [];
  const version = versionFromTag(tag);
  const prerelease = version !== null && parseVersion(version).prerelease.length > 0;

  if (!version) {
    problems.push(`tag「${tag}」不是 v<主>.<次>.<修>[-预发布] 形状，发版 tag 必须形如 v0.1.0 或 v0.2.0-rc.1`);
  } else if (version !== pkgVersion) {
    problems.push(`tag 是 v${version}，但 package.json 的 version 是 ${pkgVersion}——版本号只认 package.json，先对齐再打 tag`);
  }

  const body = version ? extractChangelogSection(changelog, version) : '';
  if (version && body === '') {
    problems.push(`CHANGELOG.md 里没有 v${version} 的小节，或小节正文是空的——没写变更就不算发版`);
  }

  // 守卫三：两个 sha 都给了才判（本地跑守卫做预检时可以只给前两关）。
  // 预发布跳过这一条：rc 不动 release 分支，稳定指针继续指着上一个正式版。
  if (!prerelease && tagSha && releaseSha && tagSha !== releaseSha) {
    problems.push(`tag 指向 ${tagSha.slice(0, 8)}，但 release 分支 HEAD 是 ${releaseSha.slice(0, 8)}——正式版 tag 只许打在 release HEAD 上`);
  }
  // 「出自 main」对 rc 同样成立：rc 也不许从野分支上凭空长出来
  if (inMain === false) {
    problems.push('tag 提交不在 main 上——发版 tag 只许打在 main 的提交上，出现独有提交说明流程被绕过了');
  }

  return { ok: problems.length === 0, version, prerelease, body, problems };
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

  // 追加而不是覆写：这个文件通常就是 $GITHUB_OUTPUT，里面已经有别人的行
  const vars = arg(argv, 'vars-out');
  if (vars) {
    fs.appendFileSync(vars, `version=${verdict.version}\nprerelease=${verdict.prerelease}\n`);
  }

  const kind = verdict.prerelease ? '预发布' : '正式版';
  process.stdout.write(
    `发版守卫通过：v${verdict.version}（${kind}），CHANGELOG 正文 ${verdict.body.split('\n').length} 行`
    + `${out ? ` → ${out}` : ''}\n`,
  );
}

if (isMainEntry(import.meta.url)) await main();
