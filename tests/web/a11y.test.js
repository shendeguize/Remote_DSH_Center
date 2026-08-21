/**
 * 无障碍与键盘收口（UI-27）。
 *
 * 断言的是「不用鼠标也能把活干完」以及「焦点不会掉进隐藏区域」——
 * 前者靠模拟 keydown 走完一条链，后者靠 hidden 语义。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PHASE_META } from '../../src/web/utils.js';
import { flush, hostView, mount, running } from './app-harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const key = (node, k, extra = {}) => node.dispatchEvent({ type: 'keydown', key: k, ...extra });

test('状态语义不只靠颜色：每个 phase 都有文案与形状标识', () => {
  for (const [phase, meta] of Object.entries(PHASE_META)) {
    assert.ok(meta.label && meta.label.trim().length > 0, `${phase} 缺中文文案`);
    assert.ok(meta.dot, `${phase} 缺形状标识（色盲用户只看得到这个）`);
  }
});

test('样式里 [hidden] 一律 display:none：否则焦点会掉进隐藏抽屉/iframe', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'web', 'style.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/, '作者样式里的 display:flex 会盖掉 UA 的 [hidden]');
  assert.match(css, /:focus-visible\s*\{[^}]*outline/, '自定义控件要有可见焦点圈');
  assert.match(css, /prefers-reduced-motion/, '要尊重「减少动态效果」');
});

test('键盘链路：表格行回车进主机 → Esc 关抽屉 → 焦点回到触发处', async (t) => {
  const { dom } = await mount(t, { hosts: [running('gpu-1'), hostView('gpu-2')] });

  const row = dom.app.querySelector('.host-table tbody tr');
  assert.equal(row.getAttribute('tabindex'), '0', '行必须可聚焦');
  row.focus();
  key(row, 'Enter');
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  assert.equal(drawer.hidden, false, '回车应打开抽屉');
  assert.equal(dom.document.activeElement.className.includes('drawer-close'), true, '焦点进抽屉');

  key(drawer, 'Escape');
  await flush();
  assert.equal(drawer.hidden, true, 'Esc 关抽屉');
  assert.equal(dom.document.activeElement, row, '焦点回到触发它的行');
});

/**
 * 回归（issue #28）：抽屉的 Esc 原来只绑在抽屉元素上，焦点一 Tab 出去就收不到——
 * 真 Chrome 里 25 次 Tab 有 17 次落在抽屉外，于是纯键盘用户关不掉它。
 */
test('焦点在抽屉外时 Esc 也能关抽屉', async (t) => {
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });
  const row = dom.app.querySelector('.host-table tbody tr');
  row.focus();
  key(row, 'Enter');
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  assert.equal(drawer.hidden, false);

  dom.document.body.focus();
  key(dom.document, 'Escape');
  await flush();
  assert.equal(drawer.hidden, true, '焦点在抽屉外按 Esc 关不掉');
});

/**
 * 回归（issue #28）：遮罩吞鼠标事件，键盘却能一路 Tab 到被它压住的按钮上，
 * 焦点环画在灰蒙蒙的遮罩底下。有遮罩就按模态办：后景 inert，aria-modal 说真话。
 */
test('抽屉开着时后景 inert，关掉后恢复可交互', async (t) => {
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });
  const drawer = dom.app.querySelector('.host-drawer');
  assert.equal(drawer.getAttribute('aria-modal'), 'true', '有遮罩就是模态，别说反话');

  const background = ['.app-header', '.tabbar', '.view-dashboard'].map((s) => {
    const node = dom.app.querySelector(s);
    assert.ok(node, `找不到 ${s}，判据在空转`);
    return node;
  });
  assert.deepEqual(background.map((n) => Boolean(n.inert)), [false, false, false]);

  const row = dom.app.querySelector('.host-table tbody tr');
  row.focus();
  key(row, 'Enter');
  await flush();
  assert.deepEqual(background.map((n) => Boolean(n.inert)), [true, true, true], '后景该 inert');

  key(dom.document, 'Escape');
  await flush();
  assert.deepEqual(background.map((n) => Boolean(n.inert)), [false, false, false], '关了就得放开');
});

test('标签页菜单可纯键盘打开、上下移动、Esc 收回', async (t) => {
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });
  const tab = dom.app.querySelector('.tabbar .host-tabs .tab');
  assert.equal(tab.getAttribute('aria-haspopup'), 'menu', '有弹出菜单就要声明');

  const menu = dom.app.querySelector('.context-menu');
  assert.equal(menu.hidden, true);

  tab.focus();
  key(tab, 'F10', { shiftKey: true }); // 无 ContextMenu 键的键盘走这条
  assert.equal(menu.hidden, false, 'Shift+F10 应开菜单');
  assert.equal(menu.getAttribute('role'), 'menu');

  const items = menu.querySelectorAll('button:not(:disabled)');
  assert.ok(items.length >= 2, '运行中的主机至少有重启/关停');
  assert.equal(dom.document.activeElement, items[0], '开菜单即落焦到首项');

  key(menu, 'ArrowDown');
  assert.equal(dom.document.activeElement, items[1]);
  key(menu, 'ArrowUp');
  assert.equal(dom.document.activeElement, items[0]);
  key(menu, 'End');
  assert.equal(dom.document.activeElement, items.at(-1), 'End 跳到末项');
  key(menu, 'ArrowDown');
  assert.equal(dom.document.activeElement, items[0], '末项再往下回到首项');

  key(dom.document, 'Escape');
  assert.equal(menu.hidden, true, 'Esc 收回菜单');
  assert.equal(dom.document.activeElement, tab, '焦点回到标签');
});

test('ArrowDown 也能开菜单（与常见工具栏习惯一致）', async (t) => {
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });
  const tab = dom.app.querySelector('.tabbar .host-tabs .tab');
  key(tab, 'ArrowDown');
  assert.equal(dom.app.querySelector('.context-menu').hidden, false);
});

test('隐藏的 iframe pane 不再是可见区域：切回管理台后全部 hidden', async (t) => {
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });

  dom.window.location.hash = '#/host/gpu-1';
  await flush();
  // 注意别选到占位遮罩（它也带 .iframe-pane），按 data-host 定位真正的 pane
  const pane = dom.app.querySelector('.iframe-pane[data-host="gpu-1"]');
  assert.equal(pane.hidden, false);
  assert.equal(pane.getAttribute('aria-hidden'), 'false');

  dom.window.location.hash = '#/';
  await flush();
  assert.equal(pane.hidden, true, '离开后必须隐藏，否则 Tab 会进入不可见 iframe');
  assert.equal(pane.getAttribute('aria-hidden'), 'true');
  assert.equal(dom.app.querySelector('.iframe-stack').hidden, true);
});

test('确认框：打开落焦取消键，Esc 等价取消', async (t) => {
  const { dom, calls } = await mount(t, { hosts: [running('gpu-1')] });

  const restart = dom.app.querySelectorAll('.manager-card .btn').find((b) => b.textContent.includes('重启'));
  restart.click();
  await flush();

  const dialog = dom.app.querySelector('.confirm-dialog');
  assert.equal(dom.document.activeElement.textContent, '取消', '危险操作默认焦点落在取消上');

  dialog.dispatchEvent({ type: 'cancel' });
  await flush();
  assert.equal(calls.some((c) => c.path === '/api/manager/restart'), false, 'Esc 取消不该发请求');
});
