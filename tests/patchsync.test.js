import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reopenSsh } from '../src/lib/ssh.js';
import {
  hashFile,
  remoteName,
  safeBase,
  syncPatches,
} from '../src/patchsync.js';

function patchFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-patchsync-'));
  const saved = Object.fromEntries(
    ['HOME', 'DSHC_SSH_BIN', 'DSHC_SCP_BIN'].map((key) => [key, process.env[key]]),
  );
  process.env.HOME = path.join(dir, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  reopenSsh();

  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reopenSsh();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function danglingTarget(target, missing) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(missing, target);
}

test('local：初始目标是 dangling symlink 时避让，既不覆盖链接也不写到链接目的地', async (t) => {
  const dir = patchFixture(t);
  const source = path.join(dir, 'source.yml');
  fs.writeFileSync(source, 'safe patch\n');
  const initialName = remoteName(await hashFile(source), source);
  const initialTarget = path.join(process.env.HOME, '.dsh_center_remote', 'patches', initialName);
  const missing = path.join(dir, 'must-not-be-created.yml');
  danglingTarget(initialTarget, missing);

  const synced = await syncPatches('local', [source], { files: {} }, { local: true });

  assert.equal(synced.uploaded, 1);
  assert.notEqual(synced.remoteNames[0], initialName);
  assert.equal(fs.lstatSync(initialTarget).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(initialTarget), missing);
  assert.equal(fs.existsSync(missing), false, '不能沿未知链接写出受控目录');
  assert.equal(
    fs.readFileSync(
      path.join(process.env.HOME, '.dsh_center_remote', 'patches', synced.remoteNames[0]),
      'utf8',
    ),
    'safe patch\n',
  );
});

test('local：全部稳定候选均被占用时有界失败，保留所有未知既有项', async (t) => {
  const dir = patchFixture(t);
  const source = path.join(dir, 'source.yml');
  const content = 'namespace exhaustion\n';
  fs.writeFileSync(source, content);

  const lexical = path.resolve(source);
  const real = fs.realpathSync(source);
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  const sourceKey = crypto
    .createHash('sha256')
    .update(lexical)
    .update('\0')
    .update(real)
    .digest('hex')
    .slice(0, 16);
  const patchesDir = path.join(process.env.HOME, '.dsh_center_remote', 'patches');
  const occupiedNames = [
    remoteName(contentHash.slice(0, 12), source),
    ...Array.from({ length: 256 }, (_, attempt) => {
      const ordinal = attempt === 0 ? '' : `-${attempt}`;
      return `${contentHash.slice(0, 16)}-local-${sourceKey}${ordinal}-${safeBase(source)}`;
    }),
  ];
  for (const [index, name] of occupiedNames.entries()) {
    danglingTarget(path.join(patchesDir, name), path.join(dir, `missing-${index}`));
  }

  await assert.rejects(
    () => syncPatches('local', [source], { files: {} }, { local: true }),
    (err) => err?.code === 'LOCAL_COPY_FAILED'
      && /找不到不会覆盖既有文件的安全目标/.test(err.message)
      && /256 个稳定候选/.test(err.detail),
  );
  assert.equal(
    fs.readdirSync(patchesDir).length,
    occupiedNames.length,
    '有界失败不得删除或覆盖任何占位项',
  );
  assert.ok(
    occupiedNames.every((name) => fs.lstatSync(path.join(patchesDir, name)).isSymbolicLink()),
  );
});

test('remote：cleanup 回报 mkdir 失败时禁止继续 scp，并保留协议诊断', async (t) => {
  const dir = patchFixture(t);
  const patch = path.join(dir, 'remote.yml');
  const ssh = path.join(dir, 'ssh.mjs');
  const scp = path.join(dir, 'scp.mjs');
  const scpCalls = path.join(dir, 'scp-calls.log');
  fs.writeFileSync(patch, 'remote patch\n');
  fs.writeFileSync(ssh, "process.stdout.write('ERR=mkdir\\nCLEAN_DONE=yes\\n');\n");
  fs.writeFileSync(scp, [
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(scpCalls)}, 'called\\n');`,
  ].join('\n'));
  process.env.DSHC_SSH_BIN = `${process.execPath} ${ssh}`;
  process.env.DSHC_SCP_BIN = `${process.execPath} ${scp}`;

  await assert.rejects(
    () => syncPatches('gpu-1', [patch], { files: {} }),
    (err) => err?.code === 'INTERNAL'
      && /无法创建 patch 目录/.test(err.message)
      && /ERR=mkdir/.test(err.detail),
  );
  assert.equal(fs.existsSync(scpCalls), false, '清理/建目录失败后不能继续半套上传');
});
