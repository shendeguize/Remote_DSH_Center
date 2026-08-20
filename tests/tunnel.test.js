/**
 * tunnel 的纯函数面（11 §5.3 分类表、§5.4 退避序列）——喂样本即可断言，不起子进程。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TUNNEL_TIMING, backoffDelay, classifyExit, isForwardDeniedLine } from '../src/tunnel.js';

test('backoffDelay：1,2,4,8,16,30,30… 秒封顶 30s', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 10].map((n) => backoffDelay(n)),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000],
  );
});

test('分类优先级 1：主动杀一律 expected（close/closeAll/restartChild/stop）', () => {
  assert.equal(classifyExit({ killedByUs: true, stderrTail: 'Address already in use' }), 'expected');
  assert.equal(classifyExit({ killedByUs: true, forcedReason: 'forward-disabled' }), 'expected');
});

test('分类优先级 2：本机端口被占（真 ssh 两种文案）', () => {
  const samples = [
    'bind [127.0.0.1]:17701: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 17701',
    'bind: address already in use',
    'channel_setup_fwd_listener_tcpip: cannot listen to port: 17701',
  ];
  for (const stderrTail of samples) {
    assert.equal(classifyExit({ stderrTail }), 'local-port-busy', stderrTail);
  }
});

test('分类优先级 3：远端禁止转发', () => {
  const samples = [
    'channel 2: open failed: administratively prohibited: open failed',
    'Forwarding disabled by server',
    'forwarding request failed',
  ];
  for (const stderrTail of samples) {
    assert.equal(classifyExit({ stderrTail }), 'forward-disabled', stderrTail);
  }
});

test('分类优先级 4：其余归 network（进退避重连环）', () => {
  for (const stderrTail of [
    '',
    'Connection to 10.0.0.1 closed by remote host.',
    'client_loop: send disconnect: Broken pipe',
    'ssh: connect to host x port 22: Operation timed out',
    'Timeout, server 10.0.0.1 not responding.',
  ]) {
    assert.equal(classifyExit({ stderrTail }), 'network', stderrTail);
  }
  assert.equal(classifyExit(), 'network', '缺参数时按 network（宁可多试一拍）');
});

test('forcedReason 优先于 stderr 内容（运行中判定已下结论）', () => {
  assert.equal(classifyExit({ forcedReason: 'forward-disabled', stderrTail: 'Broken pipe' }), 'forward-disabled');
});

test('isForwardDeniedLine：只认转发被拒，不误伤普通报错', () => {
  assert.equal(isForwardDeniedLine('channel 3: open failed: administratively prohibited: open failed'), true);
  assert.equal(isForwardDeniedLine('debug1: Connection established.'), false);
  assert.equal(isForwardDeniedLine('bind [127.0.0.1]:17701: Address already in use'), false);
});

test('时间常量符合 §5.2/§5.3 约定', () => {
  assert.equal(TUNNEL_TIMING.readyTimeoutMs, 8_000);
  assert.equal(TUNNEL_TIMING.readyPollMs, 250);
  assert.equal(TUNNEL_TIMING.denyThreshold, 3);
  assert.equal(TUNNEL_TIMING.denyWindowMs, 60_000);
});
