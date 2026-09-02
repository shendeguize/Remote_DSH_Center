/**
 * 注入面回放：config → 远端脚本（harness 支柱 D）。
 *
 * 语料库里的每条 launch-argv 语料都在这里跑一遍，双 oracle：
 *   业务码   该拒的必须以指定错误码拒（拦在拼装之前，远端一个字节都收不到）
 *   金丝雀   该收的必须只落在单引号词内，且不成为命令名（oracle.js）
 * 外加一层真 `sh -n`：注入常常表现为「脚本语法都坏了」，语法过不了同样判红。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  buildLaunchScript, buildLogTailScript, buildPatchCleanupScript, buildSettingsReadScript,
  buildSettingsWriteScript, buildStopScript, buildVerifyScript,
} from '../../src/lib/proto.js';
import { assertSafeHost } from '../../src/lib/shq.js';
import { canaryOf, loadCorpus } from './corpus.js';
import { canaryVerdict } from './oracle.js';

const run = promisify(execFile);
const LOG_NAME = 'web-8899.log';
/** 拉起协议要求已解析绝对路径；语料打的是注入点，路径本身固定。 */
const DSH_PATH = '/usr/bin/dsh';

/** 语料的注入点 → 真实构建调用。加注入点要同时在这里落地。 */
export function buildFor(entry) {
  const payload = entry.payload;
  switch (entry.entry) {
    case 'inject.env.value':
      return buildLaunchScript({ logName: LOG_NAME, port: 8899, dshPath: DSH_PATH, env: { CANARY: payload } });
    case 'inject.env.key':
      return buildLaunchScript({ logName: LOG_NAME, port: 8899, dshPath: DSH_PATH, env: { [payload]: 'v' } });
    case 'inject.extraArgs':
      return buildLaunchScript({ logName: LOG_NAME, port: 8899, dshPath: DSH_PATH, extraArgs: [payload] });
    case 'workdir':
      return buildLaunchScript({ logName: LOG_NAME, port: 8899, dshPath: DSH_PATH, workdir: payload });
    case 'patch.remoteName':
      return buildLaunchScript({ logName: LOG_NAME, port: 8899, dshPath: DSH_PATH, patchRemoteNames: [payload] });
    case 'logName':
      return buildLaunchScript({ logName: payload, port: 8899, dshPath: DSH_PATH });
    case 'port':
      return buildLaunchScript({ logName: LOG_NAME, port: payload, dshPath: DSH_PATH });
    case 'cleanup.keepNames':
      return buildPatchCleanupScript({ keepNames: [payload] });
    case 'stop.fingerprint':
      return buildStopScript({ pid: 4242, fingerprint: payload });
    case 'verify.pid':
      return buildVerifyScript({ pid: payload, port: 8899 });
    case 'logtail.lines':
      return buildLogTailScript({ logName: LOG_NAME, lines: payload });
    case 'settings.txn':
      return buildSettingsReadScript({ txn: payload });
    case 'settings.baseChecksum':
      return buildSettingsWriteScript({ txn: 'txn1', baseChecksum: payload });
    case 'ssh.host':
      // Host 名不进脚本正文，直接进 ssh 参数表；这里只验它过不了白名单
      return `ssh ${assertSafeHost(payload)} 'true'`;
    default:
      throw new Error(`语料 ${entry.id} 的注入点 ${entry.entry} 没有对应的构建调用`);
  }
}

const corpus = loadCorpus('launch-argv');

test('语料的注入点都有对应的构建调用（没有空转的语料）', () => {
  for (const entry of corpus) {
    try {
      buildFor(entry);
    } catch (error) {
      assert.ok(
        error?.name === 'DshError',
        `${entry.id}：${error.message}`,
      );
    }
  }
});

for (const entry of corpus) {
  test(`${entry.id} ${entry.entry}：${entry.expect.reject ? `拒于 ${entry.expect.reject}` : '金丝雀不逃逸'}`, async () => {
    if (entry.expect.reject) {
      assert.throws(
        () => buildFor(entry),
        (error) => {
          assert.equal(error.name, 'DshError', `${entry.id} 应抛 DshError，实得 ${error?.name}`);
          assert.equal(error.code, entry.expect.reject, `${entry.id} 错误码不符：${error.code}`);
          assert.ok(error.message.length > 0, '错误要有一句人话');
          return true;
        },
      );
      return;
    }

    const body = buildFor(entry);
    const canary = canaryOf(entry);
    assert.ok(canary, `${entry.id} 声明了 canary 判据却没有金丝雀串`);
    const verdict = canaryVerdict(body, canary);
    assert.ok(verdict.ok, `${entry.id} 金丝雀逃逸：${verdict.reason}\n正文：${body}`);

    // 真 sh 语法校验（-n 只解析不执行）：注入的另一种表现是把脚本弄坏
    if (entry.entry !== 'ssh.host') {
      await run('sh', ['-n', '-c', body]).catch((error) => {
        assert.fail(`${entry.id} 注入后脚本语法不合法：${error.stderr || error.message}\n${body}`);
      });
    }
  });
}
