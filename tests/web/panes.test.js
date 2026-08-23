/**
 * iframe keep-alive 与 reload 语义（10 §3.4 / UI-14、UI-15）。
 * 这些规则最容易被“顺手 reload 一下”破坏，所以逐条钉死。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIframePanes, loadingText, overlayFor, paneDecision,
} from '../../src/web/components/iframe-pane.js';
import { isHostActionAllowed } from '../../src/web/host-rules.js';
import { createStore } from '../../src/web/store.js';
import { installDom } from './dom-shim.js';

const snap = (patch = {}) => ({
  mappedUrl: 'http://127.0.0.1:17701/', localPort: 17_701, phase: 'running', sawCrash: false, ...patch,
});

const host = (name, patch = {}) => ({
  name,
  local: false,
  enabled: true,
  config: { enabled: true },
  phase: 'running',
  mappedUrl: 'http://127.0.0.1:17701/',
  tunnel: { localPort: 17_701, suspendedReason: null },
  ...patch,
});

function mountPanes(t, hosts) {
  const dom = installDom();
  const store = createStore({
    hosts: new Map(hosts.map((item) => [item.name, item])),
    hostsLoaded: true,
  });
  const panes = createIframePanes({ store, actions: { hostAction() {} } });
  dom.app.append(panes.root);
  t.after(() => {
    panes.destroy();
    dom.restore();
  });
  return { dom, store, panes };
}

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

test('遮罩文案与动作按共享矩阵裁剪', () => {
  assert.equal(overlayFor({ phase: 'running', mappedUrl: 'http://x/' }), null, 'running 无遮罩');

  for (const startedByUs of [true, false]) {
    const degradedHost = {
      phase: 'degraded',
      tunnel: { suspendedReason: null },
      web: { startedByUs },
    };
    const degraded = overlayFor(degradedHost);
    assert.match(degraded.title, /隧道断开/);
    assert.equal(isHostActionAllowed(degradedHost, 'reconnect'), true);
    assert.equal(degraded.action, 'reconnect', 'degraded 遮罩不按实例归属裁掉重连');
  }

  const managedCrashedHost = { phase: 'crashed', web: { startedByUs: true } };
  const managedCrashed = overlayFor(managedCrashedHost);
  assert.match(managedCrashed.title, /已退出/);
  assert.equal(isHostActionAllowed(managedCrashedHost, 'restart'), true);
  assert.equal(managedCrashed.action, 'restart');

  const manualCrashedHost = { phase: 'crashed', web: { startedByUs: false } };
  const manualCrashed = overlayFor(manualCrashedHost);
  assert.equal(isHostActionAllowed(manualCrashedHost, 'restart'), false);
  assert.equal(manualCrashed.action, null);
  assert.match(manualCrashed.body, /不是本工具.*手动处理/);

  const startingHost = { phase: 'starting', web: { startedByUs: true } };
  assert.equal(isHostActionAllowed(startingHost, 'stop'), false);
  assert.equal(overlayFor(startingHost).action, null, '启动中不给 stop 按钮');
  assert.equal(overlayFor({ phase: 'running', mappedUrl: null }).action, null);
  assert.match(overlayFor({ phase: 'ready' }).title, /可拉起/);
  assert.match(overlayFor(null).title, /已消失/);
});

test('ready + start pending 只投影为启动遮罩，不伪造 phase 或 iframe', (t) => {
  const ready = host('gpu-ready', { phase: 'ready', mappedUrl: null, tunnel: null });
  const { dom, store, panes } = mountPanes(t, [ready]);
  store.beginPending({ action: 'start', host: ready.name });

  panes.show(ready.name);

  assert.equal(store.getHost(ready.name).phase, 'ready', 'pending 只能影响视图，不能改 host 真相');
  assert.equal(dom.app.querySelector('.iframe-pane iframe'), null, '无 mappedUrl 时不得创建 iframe');
  const placeholder = dom.app.querySelector('.iframe-pane.is-placeholder');
  assert.equal(placeholder.hidden, false);
  assert.equal(placeholder.id, 'host-panel-gpu-ready');
  assert.match(placeholder.textContent, /正在启动/);
  assert.equal(placeholder.querySelector('.iframe-overlay').getAttribute('aria-busy'), 'true');
});

test('iframe 首载显示远端/本机文案，load 后隐藏，切标签不重置', (t) => {
  assert.equal(loadingText({ local: false }), '正在加载远端页面…');
  assert.equal(loadingText({ local: true }), '正在加载本机页面…');

  const local = host('workstation', {
    local: true,
    mappedUrl: 'http://127.0.0.1:19001/',
    tunnel: { localPort: 19_001, suspendedReason: null },
  });
  const { dom, panes } = mountPanes(t, [host('gpu-1'), local]);

  panes.show('gpu-1');
  const remoteFrame = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] iframe');
  const remoteLoading = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] .iframe-loading');
  assert.equal(remoteLoading.hidden, false);
  assert.equal(remoteLoading.textContent, '正在加载远端页面…');

  remoteFrame.dispatchEvent({ type: 'load' });
  assert.equal(remoteLoading.hidden, true);

  panes.show('workstation');
  const localLoading = dom.app.querySelector('.iframe-pane[data-host="workstation"] .iframe-loading');
  assert.equal(localLoading.textContent, '正在加载本机页面…');
  panes.show('gpu-1');
  assert.equal(dom.app.querySelector('.iframe-pane[data-host="gpu-1"] iframe'), remoteFrame);
  assert.equal(remoteLoading.hidden, true, '切回 keep-alive pane 不能重现首载态');
});

test('映射变化 recreate 后重新显示 loading', (t) => {
  const original = host('gpu-1');
  const { dom, store, panes } = mountPanes(t, [original]);
  panes.show('gpu-1');

  const before = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] iframe');
  before.dispatchEvent({ type: 'load' });
  store.upsertHost(host('gpu-1', {
    mappedUrl: 'http://127.0.0.1:17702/',
    tunnel: { localPort: 17_702, suspendedReason: null },
  }));

  const after = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] iframe');
  assert.notEqual(after, before);
  assert.equal(dom.app.querySelector('.iframe-pane[data-host="gpu-1"] .iframe-loading').hidden, false);
});

test('后端 phase 遮罩优先；degraded 恢复保持页面且不 reload', (t) => {
  const running = host('gpu-1');
  const { dom, store, panes } = mountPanes(t, [running]);
  panes.show('gpu-1');

  const frame = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] iframe');
  let reloads = 0;
  frame.contentWindow = { location: { reload: () => { reloads += 1; } } };
  frame.dispatchEvent({ type: 'load' });

  store.upsertHost(host('gpu-1', { phase: 'degraded' }));
  const loading = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] .iframe-loading');
  const overlay = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] .iframe-overlay');
  assert.equal(loading.hidden, true);
  assert.equal(overlay.hidden, false);
  assert.match(overlay.textContent, /隧道断开/);

  store.upsertHost(running);
  assert.equal(dom.app.querySelector('.iframe-pane[data-host="gpu-1"] iframe'), frame);
  assert.equal(reloads, 0, 'degraded 恢复必须交给页面自愈');
  assert.equal(overlay.hidden, true);
  assert.equal(loading.hidden, true);
});

test('crashed 遮罩不被 loading 遮住，恢复 reload 时重现 loading', (t) => {
  const running = host('gpu-1');
  const { dom, store, panes } = mountPanes(t, [running]);
  panes.show('gpu-1');

  const frame = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] iframe');
  let reloads = 0;
  frame.contentWindow = { location: { reload: () => { reloads += 1; } } };
  store.upsertHost(host('gpu-1', { phase: 'crashed' }));

  const loading = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] .iframe-loading');
  const overlay = dom.app.querySelector('.iframe-pane[data-host="gpu-1"] .iframe-overlay');
  assert.equal(loading.hidden, true);
  assert.equal(overlay.hidden, false);
  assert.match(overlay.textContent, /已退出/);

  store.upsertHost(running);
  assert.equal(reloads, 1);
  assert.equal(overlay.hidden, true);
  assert.equal(loading.hidden, false);
  frame.dispatchEvent({ type: 'load' });
  assert.equal(loading.hidden, true);
});
