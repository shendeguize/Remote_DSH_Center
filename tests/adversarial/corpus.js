/**
 * 攻击语料库（harness 支柱 D：安全对抗）。
 *
 * 只增不改：每个安全修复都要在这里留下一条会永久回放的语料（CONTRIBUTING RV-10）。
 * 语料是数据不是代码——runner 只有三个（按攻击面分），加一条语料不用写测试。
 *
 * 条目形状：
 *   id       AV-<面>-NNN，全库唯一，删条目等于放弃一次回归，不许改号
 *   surface  launch-argv | fingerprint | http
 *   entry    该面内的注入点（runner 按它分派）
 *   payload  攻击载荷（字符串或该面自定的对象）
 *   canary   要追踪的标记串，缺省即 payload；不许含单引号（shq 会把它拆开）
 *   expect   { reject: '<错误码>' } | { canary: 'single-quoted' } | 该面自定的判据
 *   origin   这条语料的来历（issue / 红队轮次 / fuzz 种子），出事时能顺着查
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SURFACES = Object.freeze(['launch-argv', 'fingerprint', 'http']);

/**
 * @param {object} entry
 * @param {string} surface
 * @returns {string[]} 形状问题（空数组即合格）
 */
export function validateEntry(entry, surface) {
  const problems = [];
  const id = entry?.id;
  if (typeof id !== 'string' || !/^AV-[A-Z]+-\d{3}$/u.test(id)) {
    problems.push(`id 形状不符（要 AV-<面>-NNN）：${JSON.stringify(id)}`);
  }
  if (entry?.surface !== surface) {
    problems.push(`${id}：surface 应为 ${surface}，实为 ${JSON.stringify(entry?.surface)}`);
  }
  if (typeof entry?.entry !== 'string' || entry.entry === '') {
    problems.push(`${id}：entry（注入点）必填`);
  }
  // 载荷可以是独立的 payload（注入值），也可以整体是一次请求（http 面）；不能都没有
  const hasRequest = entry?.request !== null && typeof entry?.request === 'object';
  if (entry?.payload === undefined && !hasRequest) {
    problems.push(`${id}：payload 与 request 至少要有一个（不带载荷的语料没在攻击任何东西）`);
  }
  if (typeof entry?.origin !== 'string' || entry.origin.trim() === '') {
    problems.push(`${id}：origin 必填（这条语料从哪来的，出事时要能顺着查）`);
  }
  const expect = entry?.expect;
  if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) {
    problems.push(`${id}：expect 必须是对象`);
  } else if (Object.keys(expect).length === 0) {
    problems.push(`${id}：expect 不能是空对象（不判任何东西的语料等于没有）`);
  }
  const canary = canaryOf(entry);
  if (canary !== null) {
    if (canary === '') problems.push(`${id}：canary 不能为空串`);
    if (canary.includes("'")) {
      problems.push(`${id}：canary 不许含单引号（shq 会拆成 '\\'' ，正文里不逐字出现）`);
    }
    if (typeof entry.payload === 'string' && !entry.payload.includes(canary)) {
      problems.push(`${id}：canary 不是 payload 的子串，追踪的不是同一个东西`);
    }
  }
  return problems;
}

/** 需要追踪金丝雀的条目才有 canary；纯 reject 语料可以没有。 */
export function canaryOf(entry) {
  if (typeof entry?.canary === 'string') return entry.canary;
  if (typeof entry?.payload === 'string' && entry?.expect?.canary) return entry.payload;
  return null;
}

/**
 * @param {string} surface
 * @returns {object[]}
 */
export function loadCorpus(surface) {
  if (!SURFACES.includes(surface)) throw new Error(`未知攻击面：${surface}`);
  const file = path.join(HERE, 'corpus', `${surface}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${surface}.json 顶层必须是数组`);
  return parsed;
}

/** 全部面的条目，附带来源文件名。 */
export function loadAll() {
  return SURFACES.flatMap((surface) => loadCorpus(surface).map((entry) => ({ surface, entry })));
}
