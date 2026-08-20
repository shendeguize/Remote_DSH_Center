/** 标签可见性与右键菜单裁剪（10 §3.1 / UI-10、UI-11）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { menuItems, visibleTabs } from '../../src/web/components/tabbar.js';

const host = (name, phase, patch = {}) => ({
  name, phase, mappedUrl: null, web: { pid: 1, startedByUs: true }, ...patch,
});

test('running/degraded 自动出现，ready/no_dsh 不出现', () => {
  const tabs = visibleTabs([
    host('b', 'running'),
    host('a', 'degraded'),
    host('c', 'ready'),
    host('d', 'no_dsh'),
    host('e', 'unreachable'),
  ]);
  assert.deepEqual(tabs.map((h) => h.name), ['a', 'b']);
});

test('crashed / starting 只保留已打开或当前停留的主机', () => {
  const hosts = [host('x', 'crashed'), host('y', 'starting')];

  assert.deepEqual(visibleTabs(hosts).map((h) => h.name), [], '没打开过就不该冒出来');
  assert.deepEqual(visibleTabs(hosts, { opened: new Set(['x']) }).map((h) => h.name), ['x']);
  assert.deepEqual(visibleTabs(hosts, { currentHost: 'y' }).map((h) => h.name), ['y']);
});

test('关停回 ready 后标签消失', () => {
  const opened = new Set(['x']);
  assert.deepEqual(visibleTabs([host('x', 'ready')], { opened, currentHost: 'x' }).map((h) => h.name), []);
});

test('菜单项：受管 running 可重启/关停，重连禁用', () => {
  const items = menuItems(host('a', 'running', { mappedUrl: 'http://127.0.0.1:1/' }));
  const by = Object.fromEntries(items.map((i) => [i.action, i.enabled]));
  assert.deepEqual(by, { restart: true, stop: true, reconnect: false, 'copy-address': true });
  assert.equal(items.length, 4, '无效项禁用而非隐藏，位置要稳定');
});

test('菜单项：degraded 才能重连；无映射地址不能复制', () => {
  const by = Object.fromEntries(menuItems(host('a', 'degraded')).map((i) => [i.action, i.enabled]));
  assert.equal(by.reconnect, true);
  assert.equal(by['copy-address'], false);
});

test('菜单项：手动实例一律禁写（不误杀契约）', () => {
  const manual = host('a', 'running', { web: { pid: 9, startedByUs: false }, mappedUrl: 'http://127.0.0.1:1/' });
  const by = Object.fromEntries(menuItems(manual).map((i) => [i.action, i.enabled]));
  assert.deepEqual(by, { restart: false, stop: false, reconnect: false, 'copy-address': true });
});

test('菜单项：crashed 可重启但不能关停', () => {
  const by = Object.fromEntries(menuItems(host('a', 'crashed')).map((i) => [i.action, i.enabled]));
  assert.equal(by.restart, true);
  assert.equal(by.stop, false);
});
