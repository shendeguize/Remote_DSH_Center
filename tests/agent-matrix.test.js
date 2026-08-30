import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENTS, DEFAULT_PARALLEL, DEFAULT_TIMEOUT_MS, parseArgs, pluginUrl, runMatrix,
} from '../scripts/agent-matrix.mjs';

test('matrix defaults to all five agents and bounded execution', () => {
  const args = parseArgs(['--fixture']);
  assert.deepEqual(args.agents, AGENTS);
  assert.equal(args.parallel, DEFAULT_PARALLEL);
  assert.equal(args.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test('matrix rejects unsafe hosts, duplicate agents, and invalid bounds', () => {
  assert.throws(() => parseArgs(['--host', 'bad host']), /host/u);
  assert.throws(() => parseArgs(['--fixture', '--agents', 'claude,claude']), /duplicates/u);
  assert.throws(() => parseArgs(['--fixture', '--parallel', '6']), /parallel/u);
  assert.throws(() => parseArgs(['--fixture', '--timeout', '999']), /timeout/u);
});

test('fixture matrix keeps stable five-agent order and never reports real pass', async () => {
  const report = await runMatrix(parseArgs([
    '--fixture',
    '--parallel',
    '5',
    '--agents',
    'dsh,kimi,claude,copilot,codex',
  ]));
  assert.equal(report.fixture, true);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.cases.map((item) => item.agent),
    ['dsh', 'kimi', 'claude', 'copilot', 'codex'],
  );
  assert.ok(report.cases.every((item) => item.outcome === 'simulated'));
  assert.equal(report.retryCount, 0);
  assert.equal(report.knownContracts.kimiUnknownIsTerminal, true);
});

test('real matrix requires an explicit host unless fixture or dry-run is selected', () => {
  assert.throws(() => parseArgs([]), /--host/u);
  assert.doesNotThrow(() => parseArgs(['--dry-run']));
});

test('plugin URLs do not duplicate the mapped root slash', () => {
  assert.equal(
    pluginUrl('http://127.0.0.1:17901/', '/plugins/agent-sidecar/api/state'),
    'http://127.0.0.1:17901/plugins/agent-sidecar/api/state',
  );
});
