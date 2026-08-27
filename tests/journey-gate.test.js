import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { JOURNEYS, JOURNEY_MATRIX } from '../scripts/acceptance-journeys.mjs';
import { collectInventory } from '../scripts/lib/inventory.mjs';
import { renderJourneysMarkdown, validateJourneys } from '../scripts/journey-gate.mjs';

test('用户旅程规格所有步骤都有命令、断言和有效行为绑定', () => {
  const matrix = fs.readFileSync(path.join(process.cwd(), 'tests', 'COVERAGE_MATRIX.md'), 'utf8');
  const result = validateJourneys(JOURNEYS, collectInventory(process.cwd()), JOURNEY_MATRIX, matrix);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('用户旅程规格拒绝不存在的行为绑定', () => {
  const result = validateJourneys([{
    id: 'broken',
    title: 'broken',
    tier: 'harness',
    steps: [{
      id: 'step',
      command: ['echo', 'broken'],
      expect: { code: 0 },
      behaviorIds: ['NOPE:missing'],
    }],
  }], { items: [] });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /不存在的行为/u);
});

test('旅程 markdown 明确标记为生成物并包含命令断言', () => {
  const markdown = renderJourneysMarkdown(JOURNEYS);
  assert.match(markdown, /请勿手工编辑/u);
  assert.match(markdown, /remote-host-closed-loop/u);
  assert.match(markdown, /"code":0/u);
});
