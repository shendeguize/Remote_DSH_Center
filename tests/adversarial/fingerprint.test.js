/**
 * 不误杀面回放（harness 支柱 D）。
 *
 * 这一面守的是项目底线之一：关停前逐字比对 `ps -o args=`，对不上就拒杀。
 * 语料库里每条 fingerprint 语料都是一种「ps 输出被改成了别的样子」，逐条要求：
 * 拒杀（KILL_REFUSED）+ 远端进程照活 + state.web 不清 + phase 仍 running。
 * 末尾一条 identity 语料是反面算例：指纹没动就必须真能停掉，否则整面判据恒真。
 *
 * 一次 boot 跑完全部语料：每条之间把指纹改回原样，形态是「改指纹 → 拒杀 → 复原」。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import { bootServer, waitPhase } from '../integration/helpers.js';
import { canaryOf, loadCorpus } from './corpus.js';

/** 语料的 op → 新的 ps args。加 op 要同时在这里落地。 */
export function mutateFingerprint(original, payload) {
  const { op, value } = payload;
  switch (op) {
    case 'identity': return original;
    case 'append': return `${original}${value}`;
    case 'prepend': return `${value}${original}`;
    case 'replace': return value;
    case 'strip': return original.replace(value, '');
    case 'wrap': return `${value}${original}${value}`;
    default: throw new Error(`未知的指纹变异算子：${op}`);
  }
}

test('指纹变异算子表覆盖全部语料（没有空转的语料）', () => {
  const base = 'dsh web --no-open --host 127.0.0.1 --port 8899';
  for (const entry of loadCorpus('fingerprint')) {
    const mutated = mutateFingerprint(base, entry.payload);
    assert.equal(typeof mutated, 'string', `${entry.id} 变异结果不是字符串`);
    if (entry.expect.kill === 'refused') {
      assert.notEqual(mutated, base, `${entry.id} 变异后与原指纹相同，拒杀判据会空转`);
    } else {
      assert.equal(mutated, base, `${entry.id} 声明放行，指纹却被改了`);
    }
  }
});

test('全部 fingerprint 语料：改一个字节就拒杀，不改则能停', async (t) => {
  const ctx = await bootServer(t);
  const events = await ctx.sse();

  await ctx.api('POST', '/api/hosts/gpu-1/start');
  const running = await waitPhase(ctx, 'gpu-1', 'running');
  const [live] = ctx.harness.liveProcesses('gpu-1');
  const original = live.args;
  assert.ok(original.includes('dsh web'), `原始指纹形状不对：${original}`);

  const corpus = loadCorpus('fingerprint');
  const refused = corpus.filter((e) => e.expect.kill === 'refused');
  const allowed = corpus.filter((e) => e.expect.kill === 'allowed');
  assert.ok(refused.length >= 8 && allowed.length >= 1, '语料要同时有拒杀与放行两侧');

  for (const entry of refused) {
    const mutated = mutateFingerprint(original, entry.payload);
    ctx.harness.reusePid('gpu-1', mutated);

    // eslint-disable-next-line no-await-in-loop -- 逐条语料串行：共用同一台主机与同一个 pid
    const stopped = await ctx.api('POST', '/api/hosts/gpu-1/stop');
    assert.equal(stopped.status, 202, `${entry.id} 受理失败：${stopped.text}`);
    // eslint-disable-next-line no-await-in-loop -- 同上
    const done = await events.wait((f) => f.type === 'operation-done'
      && f.data.operationId === stopped.json.operationId);
    assert.equal(done.data.status, 'failed', `${entry.id} 指纹被改成 ${JSON.stringify(mutated)} 却放行了`);
    assert.equal(done.data.code, 'KILL_REFUSED', `${entry.id} 错误码不符：${done.data.code}`);

    assert.equal(ctx.harness.liveProcesses('gpu-1').length, 1, `${entry.id} 远端进程被杀了`);
    // eslint-disable-next-line no-await-in-loop -- 同上
    const after = (await ctx.get('/api/hosts')).json.hosts.find((h) => h.name === 'gpu-1');
    assert.equal(after.phase, 'running', `${entry.id} phase 被改成了 ${after.phase}`);
    assert.equal(after.web.pid, running.web.pid, `${entry.id} state.web 被清了，人工裁决没了依据`);

    const canary = canaryOf(entry);
    if (entry.expect.noSideEffect && canary) {
      assert.equal(
        fs.existsSync(`/tmp/${canary}`),
        false,
        `${entry.id} ps 输出里的命令替换被执行了（比较位缺双引号保护）`,
      );
    }
    ctx.harness.reusePid('gpu-1', original); // 复原，下一条语料从同一起点出发
  }

  for (const entry of allowed) {
    // eslint-disable-next-line no-await-in-loop -- 收尾的放行算例
    const stopped = await ctx.api('POST', '/api/hosts/gpu-1/stop');
    assert.equal(stopped.status, 202, `${entry.id}：${stopped.text}`);
    // eslint-disable-next-line no-await-in-loop -- 同上
    const done = await events.wait((f) => f.type === 'operation-done'
      && f.data.operationId === stopped.json.operationId);
    assert.equal(done.data.status, 'ok', `${entry.id} 指纹没动却停不掉：${JSON.stringify(done.data)}`);
    // eslint-disable-next-line no-await-in-loop -- 同上
    assert.equal((await waitPhase(ctx, 'gpu-1', 'ready')).phase, 'ready');
    assert.deepEqual(ctx.harness.liveProcesses('gpu-1'), [], `${entry.id} 停掉了却还有存活进程`);
  }
});
