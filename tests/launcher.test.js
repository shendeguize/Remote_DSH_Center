import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _setWait,
  runLaunchSequence,
  stopRemote,
  tailRemoteLog,
} from '../src/launcher.js';
import {
  buildLaunchPollScript,
  buildLaunchScript,
  buildLogTailScript,
  buildPatchCleanupScript,
  buildStopScript,
  buildVerifyScript,
} from '../src/lib/proto.js';
import { hashFile, remoteName, syncPatches } from '../src/patchsync.js';
import { unshq } from './harness/shell-word.js';

function recorderFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-launcher-transport-'));
  const recorder = path.join(dir, 'record.mjs');
  const marks = {
    local: path.join(dir, 'local.ndjson'),
    ssh: path.join(dir, 'ssh.ndjson'),
    scp: path.join(dir, 'scp.ndjson'),
  };
  fs.writeFileSync(recorder, [
    "import fs from 'node:fs';",
    'const [kind, mark, ...args] = process.argv.slice(2);',
    "fs.appendFileSync(mark, `${JSON.stringify({ kind, args })}\\n`);",
    "const body = args.at(-1) ?? '';",
    "if (body.includes('echo \"PID=$!\"')) process.stdout.write('PID=43210\\n');",
    "else if (body.includes('POLL_DONE')) process.stdout.write('URL=dsh web: http://127.0.0.1:19001\\nBIND_ERR=no\\nALIVE=yes\\nPOLL_DONE=yes\\n');",
    "else if (body.includes('VERIFY_DONE')) process.stdout.write('ALIVE=yes\\nARGS<<EOF\\ndsh web --no-open --host 127.0.0.1 --port 19001\\nEOF\\nLISTEN=yes\\nCWD=/tmp/local-workdir\\nVERIFY_DONE=yes\\n');",
    "else if (body.includes('STOP_DONE')) process.stdout.write('KILLED=term\\nREASON=\\nSTOP_DONE=yes\\n');",
    "else if (body.includes('CLEAN_DONE')) process.stdout.write('ERR=\\nCLEAN_DONE=yes\\n');",
    "else if (body.includes('tail -n ')) process.stdout.write('demo-log\\n');",
  ].join('\n'));

  const saved = Object.fromEntries(
    ['DSHC_LOCAL_SH_BIN', 'DSHC_SSH_BIN', 'DSHC_SCP_BIN', 'HOME']
      .map((key) => [key, process.env[key]]),
  );
  process.env.DSHC_LOCAL_SH_BIN = `${process.execPath} ${recorder} local ${marks.local}`;
  process.env.DSHC_SSH_BIN = `${process.execPath} ${recorder} ssh ${marks.ssh}`;
  process.env.DSHC_SCP_BIN = `${process.execPath} ${recorder} scp ${marks.scp}`;
  process.env.HOME = path.join(dir, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });

  t.after(() => {
    _setWait(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    marks,
    calls(kind) {
      const mark = marks[kind];
      if (!fs.existsSync(mark)) return [];
      return fs.readFileSync(mark, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    },
    clear(kind) {
      fs.rmSync(marks[kind], { force: true });
    },
  };
}

function commandOf(call) {
  const raw = call.args.at(-1);
  if (!raw.startsWith('sh -c ')) return raw;
  return unshq(raw.slice('sh -c '.length));
}

test('launcher：LAUNCH/POLL/VERIFY/STOP/LOG 按 local 选运输且模板逐字相同', async (t) => {
  const fixture = recorderFixture(t);
  _setWait(() => Promise.resolve());
  const fingerprint = 'dsh web --no-open --host 127.0.0.1 --port 19001';

  const localLaunch = await runLaunchSequence('not-a-magic-host', { port: 19001 }, { local: true });
  assert.equal(localLaunch.fingerprint, fingerprint);
  assert.equal((await stopRemote(
    'not-a-magic-host',
    { pid: localLaunch.pid, fingerprint },
    { local: true },
  )).killed, 'term');
  assert.equal(await tailRemoteLog(
    'not-a-magic-host',
    { logName: localLaunch.logName, lines: 7 },
    { local: true },
  ), 'demo-log\n');
  assert.equal(fixture.calls('ssh').length, 0, 'local=true 不得启动 ssh');

  const expected = [
    buildLaunchScript({
      logName: 'web-19001.log',
      port: 19001,
      env: {},
      extraArgs: [],
      patchRemoteNames: [],
      workdir: null,
    }),
    buildLaunchPollScript({ logName: 'web-19001.log', pid: 43210 }),
    buildVerifyScript({ pid: 43210, port: 19001 }),
    buildStopScript({ pid: 43210, fingerprint }),
    buildLogTailScript({ logName: 'web-19001.log', lines: 7 }),
  ];
  assert.deepEqual(fixture.calls('local').map(commandOf), expected);

  fixture.clear('local');
  const remoteLaunch = await runLaunchSequence('gpu-1', { port: 19001 }, { local: false });
  await stopRemote('gpu-1', { pid: remoteLaunch.pid, fingerprint }, { local: false });
  await tailRemoteLog('gpu-1', { logName: remoteLaunch.logName, lines: 7 }, { local: false });

  assert.equal(fixture.calls('local').length, 0, 'remote 分支不得启动本机 shell');
  assert.deepEqual(
    fixture.calls('ssh').map(commandOf),
    expected,
    '远端仍经 ssh 发送与本机分支完全相同的协议模板',
  );
});

test('patchsync：local 仅原子覆盖当前目标，移除配置后不清理目录', async (t) => {
  const fixture = recorderFixture(t);
  const patchesDir = path.join(process.env.HOME, '.dsh_center_remote', 'patches');
  const source = path.join(patchesDir, '-补丁 config.yml');
  fs.mkdirSync(patchesDir, { recursive: true });
  fs.writeFileSync(source, 'enabled: true\n');

  const local = await syncPatches('plain-name', [source], { files: {} }, { local: true });
  assert.equal(local.uploaded, 1);
  assert.equal(fixture.calls('local').length, 0, '本机同步不得调用 cleanup shell');
  assert.equal(fixture.calls('ssh').length, 0, '本机同步不得启动 ssh');
  assert.equal(fixture.calls('scp').length, 0, '本机上传不得启动 scp');
  assert.match(
    local.remoteNames[0],
    /^[0-9a-f]{12}-[A-Za-z0-9._-]+$/,
    '目标名仍由 digest + sanitize 生成',
  );
  assert.equal(local.remoteNames[0].includes('补丁 config'), false);
  assert.equal(fs.readFileSync(source, 'utf8'), 'enabled: true\n');
  const target = path.join(patchesDir, local.remoteNames[0]);
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    'enabled: true\n',
  );

  const removed = await syncPatches(
    'plain-name',
    [],
    local.patchSync,
    { local: true },
  );
  assert.deepEqual(removed.remoteNames, []);
  assert.equal(removed.uploaded, 0);
  assert.equal(fs.readFileSync(source, 'utf8'), 'enabled: true\n', '移除配置后用户源仍在');
  assert.equal(fs.readFileSync(target, 'utf8'), 'enabled: true\n', '本机不主动删除旧目标');
  assert.equal(fixture.calls('local').length, 0);
});

test('patchsync：local symlink 特殊源名读取真实内容且不进入 cleanup API', async (t) => {
  const fixture = recorderFixture(t);
  const patchesDir = path.join(process.env.HOME, '.dsh_center_remote', 'patches');
  const source = path.join(patchesDir, '真实 源.yml');
  const alias = path.join(fixture.dir, '-别名 patch.yml');
  fs.mkdirSync(patchesDir, { recursive: true });
  fs.writeFileSync(source, 'from symlink target\n');
  fs.symlinkSync(source, alias);

  const local = await syncPatches('plain-name', [alias], { files: {} }, { local: true });
  assert.equal(local.uploaded, 1);
  assert.equal(fixture.calls('local').length, 0, '特殊源名不得传入 cleanup shell');
  assert.equal(fixture.calls('ssh').length, 0);
  assert.equal(fixture.calls('scp').length, 0);
  assert.equal(fs.readFileSync(source, 'utf8'), 'from symlink target\n');
  assert.equal(fs.readFileSync(alias, 'utf8'), 'from symlink target\n');
  assert.equal(
    fs.readFileSync(path.join(patchesDir, local.remoteNames[0]), 'utf8'),
    'from symlink target\n',
  );
});

test('patchsync：local 先验避让与生成目标同名的 symlink 配置源', async (t) => {
  const fixture = recorderFixture(t);
  const patchesDir = path.join(process.env.HOME, '.dsh_center_remote', 'patches');
  const firstSource = path.join(fixture.dir, 'first.yml');
  const protectedSource = path.join(fixture.dir, 'protected.yml');
  fs.mkdirSync(patchesDir, { recursive: true });
  fs.writeFileSync(firstSource, 'first patch\n');
  fs.writeFileSync(protectedSource, 'protected patch\n');

  const collidingName = remoteName(await hashFile(firstSource), firstSource);
  const protectedAlias = path.join(patchesDir, collidingName);
  fs.symlinkSync(protectedSource, protectedAlias);

  const local = await syncPatches(
    'plain-name',
    [firstSource, protectedAlias],
    { files: {} },
    { local: true },
  );

  assert.notEqual(local.remoteNames[0], collidingName, '碰撞项必须稳定改用不碰源的目标名');
  assert.equal(fs.lstatSync(protectedAlias).isSymbolicLink(), true, '配置源 alias 不得被 rename 覆盖');
  assert.equal(fs.realpathSync(protectedAlias), fs.realpathSync(protectedSource));
  assert.equal(fs.readFileSync(protectedSource, 'utf8'), 'protected patch\n');
  assert.equal(fs.readFileSync(protectedAlias, 'utf8'), 'protected patch\n');
  assert.equal(
    fs.readFileSync(path.join(patchesDir, local.remoteNames[0]), 'utf8'),
    'first patch\n',
  );
  assert.equal(
    fs.readFileSync(path.join(patchesDir, local.remoteNames[1]), 'utf8'),
    'protected patch\n',
    '后一个 patch 必须复制预检时对应的原内容，不能受前一个 copy 顺序影响',
  );
  assert.deepEqual(
    local.remoteNames,
    [firstSource, protectedAlias].map((source) => local.patchSync.files[source].remoteName),
    'PATCH_ARGS 与持久记录都必须指向实际选定目标',
  );

  const afterRemoval = await syncPatches(
    'plain-name',
    [firstSource],
    local.patchSync,
    { local: true },
  );
  assert.equal(
    afterRemoval.remoteNames[0],
    local.remoteNames[0],
    '移除碰撞源后仍应稳定复用 A 的安全目标',
  );
  assert.equal(fs.lstatSync(protectedAlias).isSymbolicLink(), true, '第二轮不得覆盖已移除的源 alias');
  assert.equal(fs.realpathSync(protectedAlias), fs.realpathSync(protectedSource));
  assert.equal(fs.readFileSync(protectedSource, 'utf8'), 'protected patch\n');
  assert.equal(fs.readFileSync(protectedAlias, 'utf8'), 'protected patch\n');
  assert.equal(
    fs.readFileSync(path.join(patchesDir, afterRemoval.remoteNames[0]), 'utf8'),
    'first patch\n',
    '第二轮 PATCH_ARGS 目标必须仍是 A 内容',
  );

  const occupiedCandidate = path.join(patchesDir, afterRemoval.remoteNames[0]);
  fs.writeFileSync(occupiedCandidate, 'unknown occupant\n');
  const afterCandidateOccupied = await syncPatches(
    'plain-name',
    [firstSource],
    afterRemoval.patchSync,
    { local: true },
  );
  assert.notEqual(
    afterCandidateOccupied.remoteNames[0],
    afterRemoval.remoteNames[0],
    '稳定候选被未知内容占用时必须继续选择下一个安全名',
  );
  assert.equal(fs.readFileSync(occupiedCandidate, 'utf8'), 'unknown occupant\n', '未知既有候选不得覆盖');
  assert.equal(
    fs.readFileSync(path.join(patchesDir, afterCandidateOccupied.remoteNames[0]), 'utf8'),
    'first patch\n',
  );
  assert.equal(fs.readFileSync(protectedSource, 'utf8'), 'protected patch\n');
  assert.equal(fixture.calls('ssh').length, 0);
  assert.equal(fixture.calls('scp').length, 0);
});

test('patchsync：remote 保持 cleanup + scp，并清理已移除项', async (t) => {
  const fixture = recorderFixture(t);
  const patch = path.join(fixture.dir, '-远端 patch.yml');
  fs.writeFileSync(patch, 'remote: true\n');

  const remote = await syncPatches('gpu-1', [patch], { files: {} }, { local: false });
  assert.equal(remote.uploaded, 1);
  assert.equal(fixture.calls('local').length, 0);
  assert.equal(fixture.calls('scp').length, 1, '远端上传继续走 scp');

  const removed = await syncPatches('gpu-1', [], remote.patchSync, { local: false });
  assert.deepEqual(removed.remoteNames, []);
  assert.deepEqual(
    fixture.calls('ssh').map(commandOf),
    [
      buildPatchCleanupScript({ keepNames: remote.remoteNames }),
      buildPatchCleanupScript({ keepNames: [] }),
    ],
    '远端仍清理旧 hash 与已从配置移除的 patch',
  );
});
