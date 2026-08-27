import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  acquireLock, compareEvidence, readLatestEvidence, redact, renderEvidenceMarkdown, writeEvidence,
} from '../../scripts/lib/acceptance.mjs';
import { FLAKY_RETRIES } from '../../scripts/acceptance-flaky.mjs';

test('redact removes secrets, home paths, and host aliases recursively', () => {
  const value = redact({
    host: 'pod-secret',
    token: 'do-not-print',
    detail: '/Users/alice/private --token=abc',
    nested: ['Bearer xyz', '/root/.ssh/id'],
  }, { hostAliases: ['pod-secret'] });
  assert.deepEqual(value, {
    host: '<host>',
    token: '[REDACTED]',
    detail: '<home>/private [REDACTED]',
    nested: ['[REDACTED]', '<home>/.ssh/id'],
  });
});

test('acquireLock rejects a concurrent owner and release is idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-accept-lock-'));
  const lock = path.join(root, 'run.lock');
  const release = acquireLock(lock, { runId: 'one' });
  assert.throws(() => acquireLock(lock), /已被占用/u);
  release();
  release();
  assert.equal(fs.existsSync(lock), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('compareEvidence detects pass-to-fail regressions and recovery', () => {
  const old = { runId: 'old', cases: [{ id: 'IT-01', status: 'pass' }, { id: 'IT-02', status: 'fail' }] };
  const current = {
    cases: [{ id: 'IT-01', status: 'fail', note: 'broken' }, { id: 'IT-02', status: 'pass' }],
  };
  const result = compareEvidence(old, current);
  assert.deepEqual(result.regressions[0].id, 'IT-01');
  assert.deepEqual(result.improvements[0].id, 'IT-02');
});

test('writeEvidence writes machine report and readable summary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-accept-evidence-'));
  const report = {
    runId: '20260828T000000Z',
    tier: 'smoke',
    host: 'pod-secret',
    startedAt: '2026-08-28T00:00:00.000Z',
    finishedAt: '2026-08-28T00:01:00.000Z',
    ok: true,
    cases: [{ id: 'IT-01', status: 'pass', note: 'Bearer abc', ms: 1000 }],
    versions: { center: '0.6.0', remoteDsh: '0.1.1' },
    drift: [],
  };
  const saved = writeEvidence(report, { directory: root, hostAliases: ['pod-secret'] });
  assert.equal(readLatestEvidence(root).host, '<host>');
  assert.match(fs.readFileSync(saved.markdownPath, 'utf8'), /PASS/u);
  assert.doesNotMatch(fs.readFileSync(saved.jsonPath, 'utf8'), /Bearer/u);
  assert.match(renderEvidenceMarkdown(saved.report), /IT-01/u);
  fs.rmSync(root, { recursive: true, force: true });
});

test('flaky registry is explicit and bounded', () => {
  assert.ok(Object.keys(FLAKY_RETRIES).length > 0);
  for (const count of Object.values(FLAKY_RETRIES)) {
    assert.ok(Number.isInteger(count) && count >= 0 && count <= 1);
  }
});

test('真机收尾没有宽匹配 dsh web 的误杀路径', () => {
  const source = fs.readFileSync(new URL('../../scripts/real-acceptance.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /pkill\s+-f\s+["']dsh web["']/u);
  assert.match(source, /buildStopScript/u);
});
