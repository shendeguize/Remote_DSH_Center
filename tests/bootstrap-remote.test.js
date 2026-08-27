import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts', 'bootstrap-remote.sh');

test('bootstrap-remote 是独立的操作员脚本且 shell 语法有效', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /操作员脚本/u);
  assert.match(source, /Rescanning SSH config/u);
  assert.doesNotMatch(source, /apt(?:-get)?\s+install[^;\n]*python/u);
  const syntax = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('bootstrap-remote help 不触碰远端', () => {
  const result = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--deep/u);
  assert.match(result.stdout, /never installs dsh or Python/u);
});
