/**
 * B2 薄壳页面契约：常驻主机标签、starting 占位，以及管理动作的位置。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  flush, hostView, mount, running,
} from './app-harness.js';

const tabHosts = (dom) => dom.app
  .querySelectorAll('.host-tabs .tab')
  .map((tab) => tab.dataset.host);

test('ready 标签初始与运行结束后都常驻', async (t) => {
  const { dom, es } = await mount(t, {
    hosts: [hostView('gpu-ready'), running('gpu-running')],
  });

  assert.deepEqual(tabHosts(dom), ['gpu-ready', 'gpu-running']);

  es().send('host-changed', {
    revision: 2,
    host: hostView('gpu-running', { phase: 'ready' }),
  });
  await flush();

  assert.deepEqual(
    tabHosts(dom),
    ['gpu-ready', 'gpu-running'],
    'running 回到 ready 不得把已启用主机移出标签栏',
  );
});

test('starting 深链直接打开占位遮罩', async (t) => {
  const host = hostView('gpu-starting', { phase: 'starting' });
  const { dom } = await mount(t, {
    hash: '#/host/gpu-starting',
    hosts: [host],
  });

  assert.equal(dom.window.location.hash, '#/host/gpu-starting');
  assert.deepEqual(tabHosts(dom), ['gpu-starting']);
  const tab = dom.app.querySelector('.host-tabs .tab[data-host="gpu-starting"]');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  assert.equal(dom.app.querySelector('.view-fallback').hidden, true);

  const placeholder = dom.app.querySelector('.iframe-pane.is-placeholder');
  assert.equal(placeholder.hidden, false);
  assert.equal(placeholder.querySelector('.iframe-overlay').hidden, false);
  assert.equal(placeholder.querySelector('iframe'), null, '映射地址下发前不得创建 iframe');
  assert.match(placeholder.textContent, /正在启动/);
});

test('探测与重载只位于 manage 页头，非管理页不暴露', async (t) => {
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });
  const appHeader = dom.app.querySelector('.app-header');
  const hub = dom.app.querySelector('.view-hub');
  const manage = dom.app.querySelector('.view-dashboard');
  const manageHeader = manage.querySelector('.manage-header');
  const probe = dom.app.querySelector('.probe-all');
  const reload = dom.app.querySelector('.reload-config');

  assert.equal(dom.app.querySelectorAll('.probe-all').length, 1);
  assert.equal(dom.app.querySelectorAll('.reload-config').length, 1);
  assert.equal(appHeader.querySelector('.probe-all'), null);
  assert.equal(appHeader.querySelector('.reload-config'), null);
  assert.equal(manageHeader.querySelector('.probe-all'), probe);
  assert.equal(manageHeader.querySelector('.reload-config'), reload);

  assert.deepEqual(
    [dom.window.location.hash, hub.hidden, manage.hidden],
    ['#/hub', false, true],
    'hub 上管理动作只能留在隐藏的 manage 页面内',
  );

  dom.window.location.hash = '#/host/gpu-1';
  assert.deepEqual(
    [hub.hidden, manage.hidden, appHeader.querySelector('.probe-all')],
    [true, true, null],
    '主机页也不得把管理动作抬到全局 header',
  );

  dom.window.location.hash = '#/manage';
  assert.deepEqual(
    [hub.hidden, manage.hidden, manageHeader.hidden],
    [true, false, false],
  );
  assert.equal(manageHeader.querySelector('.probe-all'), probe);
  assert.equal(manageHeader.querySelector('.reload-config'), reload);
});
