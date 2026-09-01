import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createAnalysisService,
  isCompatibleVersion,
  selectAnalysisRows,
} from '../src/analysis.js';

test('Sidecar 版本握手遵守最低版本', () => {
  assert.equal(isCompatibleVersion('agent-sidecar 0.9.0'), true);
  assert.equal(isCompatibleVersion('0.8.9'), false);
  assert.equal(isCompatibleVersion('unknown'), false);
});

test('舰队分析按需执行并缓存结果', async () => {
  const calls = [];
  const spawnImpl = (file, args) => {
    calls.push([file, ...args]);
    const child = new EventEmitter();
    child.pid = 1234;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      const output = args[0] === '--version'
        ? 'agent-sidecar 0.9.0\n'
        : args[0] === 'cluster'
          ? '[{"cluster_id":"c1","project":"/tmp/secret","agent":"dsh","model":"m","count":1,"hosts":["pod"]}]'
          : '摘要 /tmp/private 不应被返回';
      child.stdout.end(output);
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  };
  const service = createAnalysisService({
    env: { AGENT_SIDECAR_BIN: 'sidecar', DSH_BIN: 'dsh' },
    spawnImpl,
  });

  const first = await service.analyze();
  const second = await service.analyze();
  assert.equal(first.clusters.length, 1);
  assert.equal(first.partial, false);
  assert.equal(first.report, '摘要 [path] 不应被返回');
  assert.equal(second.cached, true);
  assert.equal(calls.filter((call) => call[1] === 'cluster').length, 1);
});

test('语义载荷选择器按规则排序并限制数量', () => {
  const rows = [
    { cluster_id: 'small', count: 1, time_bucket: 30, agent: 'z' },
    { cluster_id: 'large', count: 9, time_bucket: 10, agent: 'a' },
    { cluster_id: 'recent', count: 2, time_bucket: 40, agent: 'm' },
  ];
  assert.deepEqual(
    selectAnalysisRows(rows, { rules: ['largest', 'recent'], maxGroups: 2 })
      .map((row) => row.cluster_id),
    ['large', 'recent'],
  );
  assert.deepEqual(
    selectAnalysisRows(rows, { rules: ['agent', 'max-groups'], maxGroups: 200 })
      .map((row) => row.cluster_id),
    ['large', 'recent', 'small'],
  );
  assert.throws(() => selectAnalysisRows(rows, { rules: ['unknown'] }));
  assert.throws(() => selectAnalysisRows(rows, { maxGroups: 0 }));
});

test('Sidecar 不可用或版本不兼容时分析 fail-closed', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => child.emit('error', new Error('not installed')));
    return child;
  };
  const service = createAnalysisService({
    env: { AGENT_SIDECAR_BIN: 'missing', DSH_BIN: 'dsh' },
    spawnImpl,
  });
  const result = await service.analyze();
  assert.equal(result.partial, true);
  assert.equal(result.failures[0].code, 'unavailable');

  const incompatible = createAnalysisService({
    env: { AGENT_SIDECAR_BIN: 'sidecar', DSH_BIN: 'dsh' },
    spawnImpl: (file, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end(args[0] === '--version' ? '0.8.0\n' : '');
        child.stderr.end();
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  const blocked = await incompatible.analyze();
  assert.equal(blocked.failures[0].code, 'version_incompatible');
});

test('舰队分析对坏 JSON 和命令失败保留确定性结果', async () => {
  const spawnImpl = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      if (args[0] === '--version') {
        child.stdout.end('agent-sidecar 0.9.0\n');
        child.stderr.end();
        child.emit('close', 0, null);
      } else if (args[0] === 'cluster') {
        child.stdout.end('{broken');
        child.stderr.end();
        child.emit('close', 0, null);
      } else {
        child.stdout.end('');
        child.stderr.end('headless failed');
        child.emit('close', 1, null);
      }
    });
    return child;
  };
  const result = await createAnalysisService({
    env: { AGENT_SIDECAR_BIN: 'sidecar', DSH_BIN: 'dsh' },
    spawnImpl,
  }).analyze();
  assert.equal(result.partial, true);
  assert.deepEqual(result.clusters, []);
  assert.ok(result.failures.some((failure) => failure.code === 'malformed_json'));
  assert.equal(result.report, null);
});
