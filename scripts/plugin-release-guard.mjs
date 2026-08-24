#!/usr/bin/env node
/**
 * 插件发版守卫：plugin-v* tag 推上来之后、npm publish 之前把三件事核清楚。
 *
 *   守卫一  tag 名 == plugin-v${plugin/package.json version} —— 版本号只有一个源
 *   守卫二  plugin/CHANGELOG.md 有对应小节且正文非空       —— 没写变更就不算发版
 *   守卫三  tag 提交包含于 main
 *
 * 与主仓 release-guard 的偏离（一句话）：守卫三不绑 release 分支 HEAD——release 是
 * 主体 standalone 发布的稳定指针，插件版本独立演进且不产出 standalone 包
 * （设计 §8.4、CONTRIBUTING「插件发版」）。
 *
 * 任一关红就退 1 并把人话原因打到 stderr；三关全过时 --vars-out 追加
 * version= 与 prerelease= 两行（给后续 job 用，「什么是预发布」的判定只有
 * src/lib/semver.js 那一份口径，不在 shell 里再猜一次）。
 *
 * 守卫三需要 git 信息（tag 提交是否包含于 main），由调用方经 --in-main 传入，
 * 本模块只做判定——与 release-guard 同款纪律，每条规则都能在本机单测里跑到
 * （tests/tooling.test.js）。
 *
 * 用法（plugin-publish.yml 的 publish job 里）：
 *   node scripts/plugin-release-guard.mjs "$GITHUB_REF_NAME" \
 *     --in-main true --vars-out "$GITHUB_OUTPUT"
 *
 * 查询模式（release job 用，tag 跟在模式参数后面）：
 *   --extract-notes <tag>   对应 CHANGELOG 小节正文 → stdout（当 release notes 用）
 *   --is-prerelease <tag>   true / false → stdout（rc 判定复用 src/lib/semver.js）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { parseVersion } from '../src/lib/semver.js';

import { extractChangelogSection } from './release-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `refs/tags/plugin-v0.1.0` 或 `plugin-v0.2.0-rc.1` → `0.1.0` / `0.2.0-rc.1`；
 * 形状不对给 null。剥掉 `plugin-` 前缀后剩 `v<版本>`，形状判定借 src/lib/semver.js
 * ——「什么是合法版本号」不另写第二份；build 元数据（`+xxx`）同样拒收，
 * 理由同 release-guard 的 versionFromTag。
 * @param {string} ref
 * @returns {string|null}
 */
export function versionFromPluginTag(ref) {
  const name = String(ref ?? '').replace(/^refs\/tags\//, '');
  if (!name.startsWith('plugin-v')) return null;
  const parsed = parseVersion(name.slice('plugin-'.length));
  if (!parsed || parsed.build !== null) return null;
  return parsed.version;
}

/**
 * 三道守卫的判定（纯函数，不碰 IO）。
 * @param {object} input
 * @param {string} input.tag             GITHUB_REF_NAME（形如 plugin-v0.1.0）
 * @param {string} input.pkgVersion      plugin/package.json 的 version
 * @param {string} input.changelog       plugin/CHANGELOG.md 全文
 * @param {boolean|null} [input.inMain]  tag 提交是否包含于 main（本地预检可不给）
 * @returns {{ok:boolean, version:string|null, prerelease:boolean, body:string,
 *   problems:string[]}}
 */
export function evaluatePluginGuards({ tag, pkgVersion, changelog, inMain = null }) {
  const problems = [];
  const version = versionFromPluginTag(tag);
  const prerelease = version !== null && parseVersion(version).prerelease.length > 0;

  if (!version) {
    problems.push(`tag「${tag}」不是 plugin-v<主>.<次>.<修>[-预发布] 形状，插件发版 tag 必须形如 plugin-v0.1.0 或 plugin-v0.2.0-rc.1`);
  } else if (version !== pkgVersion) {
    problems.push(`tag 是 plugin-v${version}，但 plugin/package.json 的 version 是 ${pkgVersion}——插件版本号只认 plugin/package.json，先对齐再打 tag`);
  }

  const body = version ? extractChangelogSection(changelog, version) : '';
  if (version && body === '') {
    problems.push(`plugin/CHANGELOG.md 里没有 [${version}] 的小节，或小节正文是空的——没写变更就不算发版`);
  }

  // 守卫三只看「出自 main」，rc 与正式版一视同仁；刻意不绑 release 分支 HEAD（偏离说明见文件头）。
  if (inMain === false) {
    problems.push('tag 提交不在 main 上——插件发版 tag 只许打在 main 的提交上，出现独有提交说明流程被绕过了');
  }

  return { ok: problems.length === 0, version, prerelease, body, problems };
}

/**
 * --extract-notes 的正文口径（纯函数）：tag 解出版本 → 截对应小节，空正文也算失败。
 * @param {string} changelog plugin/CHANGELOG.md 全文
 * @param {string} tag       形如 plugin-v0.1.0
 * @returns {{ok:boolean, notes:string, problem:string|null}}
 */
export function pluginNotesFromChangelog(changelog, tag) {
  const version = versionFromPluginTag(tag);
  if (!version) {
    return { ok: false, notes: '', problem: `tag「${tag}」不是 plugin-v<主>.<次>.<修>[-预发布] 形状，取不出 CHANGELOG 小节` };
  }
  const notes = extractChangelogSection(changelog, version);
  if (notes === '') {
    return { ok: false, notes: '', problem: `plugin/CHANGELOG.md 里没有 [${version}] 的小节，或小节正文是空的——没有正文就没有 release notes` };
  }
  return { ok: true, notes, problem: null };
}

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

function tri(raw) {
  if (raw === null || raw === undefined) return null;
  return raw === 'true';
}

const readPluginFile = (name) => fs.readFileSync(path.join(REPO, 'plugin', name), 'utf8');

async function main() {
  const argv = process.argv.slice(2);

  const notesTag = arg(argv, 'extract-notes');
  if (notesTag !== null) {
    const verdict = pluginNotesFromChangelog(readPluginFile('CHANGELOG.md'), notesTag);
    if (!verdict.ok) {
      process.stderr.write(`${verdict.problem}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${verdict.notes}\n`);
    return;
  }

  const preTag = arg(argv, 'is-prerelease');
  if (preTag !== null) {
    const version = versionFromPluginTag(preTag);
    if (version === null) {
      process.stderr.write(`tag「${preTag}」不是 plugin-v<主>.<次>.<修>[-预发布] 形状，判不出是不是预发布\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${parseVersion(version).prerelease.length > 0}\n`);
    return;
  }

  const verdict = evaluatePluginGuards({
    tag: argv[0] ?? '',
    pkgVersion: JSON.parse(readPluginFile('package.json')).version,
    changelog: readPluginFile('CHANGELOG.md'),
    inMain: tri(arg(argv, 'in-main')),
  });

  if (!verdict.ok) {
    process.stderr.write(`插件发版守卫未过：\n${verdict.problems.map((p) => `  ✘ ${p}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  // 追加而不是覆写：这个文件通常就是 $GITHUB_OUTPUT，里面已经有别人的行
  const vars = arg(argv, 'vars-out');
  if (vars) {
    fs.appendFileSync(vars, `version=${verdict.version}\nprerelease=${verdict.prerelease}\n`);
  }

  const kind = verdict.prerelease ? '预发布' : '正式版';
  process.stdout.write(
    `插件发版守卫通过：plugin-v${verdict.version}（${kind}），CHANGELOG 正文 ${verdict.body.split('\n').length} 行\n`,
  );
}

if (isMainEntry(import.meta.url)) await main();
