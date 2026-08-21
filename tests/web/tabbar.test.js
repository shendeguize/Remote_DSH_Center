/** 标签可见性与右键菜单裁剪（10 §3.1 / UI-10、UI-11）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clampMenuPosition, menuItems, nextTabIndex, visibleTabs } from '../../src/web/components/tabbar.js';

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

/**
 * 菜单是 position:fixed——越出视口那一截没有滚动可言，鼠标压根落不上去（issue #67）。
 * 尺寸取真机实测：菜单 180×128，视口 1440×900。
 */
test('菜单位置：够得下就照原点摆', () => {
  const at = clampMenuPosition({ x: 300, y: 60, menuW: 180, menuH: 128, viewW: 1440, viewH: 900 });
  assert.deepEqual(at, { left: 300, top: 60 });
});

test('菜单位置：右边/下边不够就朝反方向翻，不许越界', () => {
  const view = { menuW: 180, menuH: 128, viewW: 1440, viewH: 900 };
  const right = clampMenuPosition({ x: 1437, y: 60, ...view });
  assert.equal(right.left, 1437 - 180, '右边不够该朝左翻，让菜单右缘对齐光标');
  assert.ok(right.left + 180 <= 1440, `翻完还越界：right=${right.left + 180}`);

  const corner = clampMenuPosition({ x: 1437, y: 894, ...view });
  assert.ok(corner.left + 180 <= 1440 && corner.top + 128 <= 900, `右下角越界：${JSON.stringify(corner)}`);
});

test('菜单位置：视口比菜单还小就贴边，不许出现负坐标', () => {
  const at = clampMenuPosition({ x: 5, y: 5, menuW: 180, menuH: 128, viewW: 100, viewH: 80 });
  assert.ok(at.left >= 0 && at.top >= 0, `贴边不该贴到视口外：${JSON.stringify(at)}`);
});

/**
 * 亲手右键唤出的菜单，不许被一条自己会消失的通知压住（issue #68）。这条判在 CSS
 * 变量的序上——真浏览器里那半边由 `scripts/ui-smoke.mjs` 的 S6b 兜。
 */
test('层序：菜单在 toast 之上、对话框之下', () => {
  const css = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'style.css'),
    'utf8',
  );
  const z = (name) => {
    const m = css.match(new RegExp(`--z-${name}:\\s*(\\d+)`));
    assert.ok(m, `style.css 里找不到 --z-${name}`);
    return Number(m[1]);
  };
  assert.ok(z('menu') > z('toast'), `--z-menu(${z('menu')}) 要高于 --z-toast(${z('toast')})`);
  assert.ok(z('dialog') > z('menu'), `--z-dialog(${z('dialog')}) 要高于 --z-menu(${z('menu')})`);
  assert.ok(z('toast') > z('scrim'), `--z-toast(${z('toast')}) 要高于 --z-scrim(${z('scrim')})`);
  assert.match(css, /\.toast-region\s*\{[^}]*pointer-events:\s*none/, 'toast 容器不该吃指针事件（间隙也会吞点击）');
  assert.match(css, /\.toast\s*\{[^}]*pointer-events:\s*auto/, 'toast 本体要照常可点（有关闭键）');
});

/**
 * 方向键落点（issue #110）。`role="tablist"` 承诺了左右移动与 Home/End 跳首尾，
 * 真机上原来四个键一动不动。环绕与「焦点不在环上」的边界都在这里收口。
 */
test('方向键落点：左右环绕、Home/End 跳首尾、无关键返回 null', () => {
  assert.equal(nextTabIndex('ArrowRight', 0, 3), 1);
  assert.equal(nextTabIndex('ArrowRight', 2, 3), 0, '到尾环绕回头');
  assert.equal(nextTabIndex('ArrowLeft', 0, 3), 2, '在头上按左键环绕到尾');
  assert.equal(nextTabIndex('Home', 2, 3), 0);
  assert.equal(nextTabIndex('End', 0, 3), 2);
  assert.equal(nextTabIndex('ArrowDown', 0, 3), null, 'ArrowDown 是「开操作菜单」，不许被抢');
  assert.equal(nextTabIndex('Enter', 0, 3), null, '激活不走这里');
});

test('方向键落点：焦点不在环上时从头算，空标签栏一律不动', () => {
  assert.equal(nextTabIndex('ArrowRight', -1, 3), 1, '焦点在别处（如管理台）时右键进第二个之前先当在首位');
  assert.equal(nextTabIndex('ArrowLeft', -1, 3), 2);
  for (const k of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.equal(nextTabIndex(k, -1, 0), null, `一个标签都没有时 ${k} 不该算出下标`);
  }
});
