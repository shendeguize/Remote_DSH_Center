/**
 * iframe keep-alive 与 reload 语义（10 §3.4 / UI-14、UI-15）。
 * 这些规则最容易被“顺手 reload 一下”破坏，所以逐条钉死。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { overlayFor, paneDecision } from '../../src/web/components/iframe-pane.js';

const snap = (patch = {}) => ({
  mappedUrl: 'http://127.0.0.1:17701/', localPort: 17_701, phase: 'running', sawCrash: false, ...patch,
});

test('首次拿到映射地址才创建 pane', () => {
  assert.equal(paneDecision(null, { mappedUrl: null, localPort: null, phase: 'starting' }).kind, 'none');
  assert.equal(paneDecision(null, snap()).kind, 'create');
});

test('running → degraded → running 不 reload（交给 dsh web 自愈）', () => {
  const before = snap();
  const degraded = paneDecision(before, snap({ phase: 'degraded' }));
  assert.equal(degraded.kind, 'none');

  const back = paneDecision(snap({ phase: 'degraded' }), snap({ phase: 'running' }));
  assert.equal(back.kind, 'none', 'degraded 往返不该重载页面');
});

test('crashed 恢复只 reload 一次', () => {
  // 见过 crashed 的 pane 回到 running → reload
  const first = paneDecision(snap({ phase: 'crashed', sawCrash: true }), snap({ phase: 'running' }));
  assert.equal(first.kind, 'reload');
  assert.equal(first.reason, 'crash-recovered');

  // reload 完 sawCrash 被清掉，后续 running 帧不再重载
  const second = paneDecision(snap({ sawCrash: false }), snap({ phase: 'running' }));
  assert.equal(second.kind, 'none');
});

test('localPort 变化必须整只重建（旧文档绑在旧 origin）', () => {
  const d = paneDecision(snap(), snap({ localPort: 17_702, mappedUrl: 'http://127.0.0.1:17702/' }));
  assert.equal(d.kind, 'recreate');
  assert.equal(d.reason, 'local-port-changed');
});

test('关停到 ready 销毁 pane；从未创建则什么都不做', () => {
  assert.equal(paneDecision(snap(), { mappedUrl: null, localPort: null, phase: 'ready' }).kind, 'destroy');
  assert.equal(paneDecision(null, { mappedUrl: null, localPort: null, phase: 'ready' }).kind, 'none');
});

test('crashed 期间隧道地址消失也要留住已加载的文档', () => {
  const d = paneDecision(snap(), snap({ phase: 'crashed', mappedUrl: null }));
  assert.equal(d.kind, 'none');
  assert.equal(d.reason, 'no-url-keep');
});

test('遮罩文案与动作按 phase 裁剪', () => {
  assert.equal(overlayFor({ phase: 'running', mappedUrl: 'http://x/' }), null, 'running 无遮罩');

  const degraded = overlayFor({ phase: 'degraded', tunnel: { suspendedReason: null } });
  assert.match(degraded.title, /隧道断开/);
  assert.equal(degraded.action, 'reconnect');

  const crashed = overlayFor({ phase: 'crashed' });
  assert.match(crashed.title, /已退出/);
  assert.equal(crashed.action, 'restart');

  assert.equal(overlayFor({ phase: 'starting' }).action, null, '启动中不给按钮');
  assert.equal(overlayFor({ phase: 'running', mappedUrl: null }).action, null);
  assert.match(overlayFor({ phase: 'ready' }).title, /可拉起/);
  assert.match(overlayFor(null).title, /已消失/);
});
