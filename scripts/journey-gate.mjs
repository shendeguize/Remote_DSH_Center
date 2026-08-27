#!/usr/bin/env node
/**
 * 用户旅程规格闸门：验证旅程结构、行为 ID 绑定和生成文档。
 *
 * 规格真源是 acceptance-journeys.mjs；本入口不把叙事 markdown 当作第二份
 * 真源。`--write` 只写生成物，执行副作用由 journey-runner/real-acceptance
 * 在显式环境中承担。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { collectInventory } from './lib/inventory.mjs';
import { JOURNEYS, JOURNEY_MATRIX } from './acceptance-journeys.mjs';
import { COVERAGE_OVERRIDES } from './acceptance-coverage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'tests', 'ACCEPTANCE_JOURNEYS.md');

export function validateJourneys(journeys, inventory, mappings = JOURNEY_MATRIX, matrixText = null) {
  const errors = [];
  const ids = new Set();
  const bound = new Set();
  const journeyById = new Map(journeys.map((journey) => [journey.id, journey]));
  for (const journey of journeys) {
    if (!journey.id || ids.has(journey.id)) errors.push(`旅程 id 缺失或重复：${journey.id ?? '(empty)'}`);
    ids.add(journey.id);
    if (!journey.title || !journey.tier) errors.push(`旅程元数据不完整：${journey.id}`);
    if (!Array.isArray(journey.steps) || journey.steps.length === 0) {
      errors.push(`旅程没有步骤：${journey.id}`);
      continue;
    }
    const stepIds = new Set();
    for (const item of journey.steps) {
      if (!item.id || stepIds.has(item.id)) errors.push(`步骤 id 缺失或重复：${journey.id}/${item.id ?? '(empty)'}`);
      stepIds.add(item.id);
      if (!Array.isArray(item.command) || item.command.length === 0 || item.command.some((part) => typeof part !== 'string' || !part)) {
        errors.push(`步骤命令无效：${journey.id}/${item.id}`);
      }
      if (!item.expect || !Array.isArray(item.behaviorIds) || item.behaviorIds.length === 0) {
        errors.push(`步骤缺少 expect 或 behaviorIds：${journey.id}/${item.id}`);
      }
      for (const key of item.behaviorIds ?? []) {
        if (!inventory.items.some((entry) => entry.key === key)) {
          errors.push(`旅程绑定了不存在的行为：${journey.id}/${item.id} -> ${key}`);
        }
      }
      for (const behaviorId of item.behaviorIds ?? []) bound.add(behaviorId);
    }
  }
  for (const item of inventory.items) {
    if (item.coverage !== 'e2e') continue;
    if (!bound.has(item.key)) errors.push(`必须端到端的行为未绑定旅程：${item.key}`);
    const owners = journeys.filter((journey) => journey.steps.some((stepItem) => stepItem.behaviorIds.includes(item.key)));
    if (!owners.some((journey) => journey.tier)) errors.push(`端到端行为没有可执行旅程：${item.key}`);
  }
  for (const mapping of mappings) {
    if (!journeyById.has(mapping.journey)) errors.push(`矩阵映射引用不存在的旅程：${mapping.row} -> ${mapping.journey}`);
    if (matrixText !== null && !matrixText.includes(`JOURNEY:${mapping.journey}`)) {
      errors.push(`矩阵缺少旅程锚点：JOURNEY:${mapping.journey}`);
    }
  }
  for (const key of Object.keys(COVERAGE_OVERRIDES)) {
    if (!inventory.items.some((item) => item.key === key)) errors.push(`覆盖层级声明引用不存在的行为：${key}`);
  }
  return { ok: errors.length === 0, errors };
}

export function renderJourneysMarkdown(journeys) {
  const lines = [
    '# 可执行用户旅程清单',
    '',
    '> 本文件由 `scripts/acceptance-journeys.mjs` 生成，请勿手工编辑。',
    '',
  ];
  for (const journey of journeys) {
    lines.push(`## ${journey.id}：${journey.title}`, '', `- tier: \`${journey.tier}\``, '', '| 步骤 | 命令 | 期望 | 行为绑定 |', '|---|---|---|---|');
    for (const item of journey.steps) {
      lines.push(`| ${item.id} | \`${item.command.join(' ')}\` | \`${JSON.stringify(item.expect)}\` | ${item.behaviorIds.map((id) => `\`${id}\``).join('、')} |`);
    }
    lines.push('');
  }
  lines.push('## 矩阵锚点', '', '| 功能章节 | 旅程 |', '|---|---|');
  for (const mapping of JOURNEY_MATRIX) {
    lines.push(`| ${mapping.row} | \`JOURNEY:${mapping.journey}\` |`);
  }
  return `${lines.join('\n')}`;
}

async function main() {
  const write = process.argv.includes('--write');
  const matrix = fs.readFileSync(path.join(ROOT, 'tests', 'COVERAGE_MATRIX.md'), 'utf8');
  const verdict = validateJourneys(JOURNEYS, collectInventory(ROOT), JOURNEY_MATRIX, matrix);
  if (!verdict.ok) {
    process.stderr.write(`${verdict.errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  const markdown = renderJourneysMarkdown(JOURNEYS);
  if (write) {
    fs.writeFileSync(OUTPUT, markdown);
    process.stdout.write(`已生成 ${path.relative(ROOT, OUTPUT)}\n`);
  } else {
    if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, 'utf8') !== markdown) {
      process.stderr.write(`旅程 markdown 已过期：请运行 node scripts/journey-gate.mjs --write\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`旅程规格有效：${JOURNEYS.length} 条、${JOURNEYS.reduce((n, item) => n + item.steps.length, 0)} 步骤\n`);
  }
}

if (isMainEntry(import.meta.url)) await main();

export { OUTPUT };
