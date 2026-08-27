/**
 * 行为 ID 的验收层级声明。
 *
 * `unit` 表示行为仍由常规单测/集成测试负责；`e2e` 表示必须出现在一个
 * real/harness 用户旅程中。这个小表是第一轴的政策入口，未知 ID 由
 * journey-gate 立即判红，避免新增关键行为悄悄退回 unit-only。
 */

export const COVERAGE_OVERRIDES = Object.freeze({
  'CLI:probe': 'e2e',
  'CLI:start': 'e2e',
  'CLI:stop': 'e2e',
  'CLI:reconnect': 'e2e',
  'CLI:restart': 'e2e',
  'CLI:log': 'e2e',
  'CLI_EXIT:0': 'e2e',
  'CLI_EXIT:1': 'e2e',
  'CLI_EXIT:3': 'e2e',
  'API:POST /api/hosts/probe': 'e2e',
  'API:POST /api/hosts/:name/probe': 'e2e',
  'API:POST /api/hosts/:name/start': 'e2e',
  'API:POST /api/hosts/:name/stop': 'e2e',
  'API:POST /api/hosts/:name/reconnect': 'e2e',
  'API:POST /api/hosts/:name/restart': 'e2e',
  'API:GET /api/hosts/:name/log': 'e2e',
});
