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
import { DEFAULTS, MANAGER_INFO, flush, hostView, mount, running } from './app-harness.js';

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
 * 回归（issue #71）：有改动时 Esc 要弹「放弃未保存的修改？」，而那个框是原生
 * `<dialog>`——`showModal()` 就在这一记 Esc 的处理器里调，浏览器随后处理同一记
 * Esc 的默认动作（CloseWatcher），一眼看到刚开的模态框就把它关了。真机上的体感是
 * 「按 Esc 毫无反应」，只能改用鼠标。所以要开框的那一记必须把默认动作摘掉；反过来，
 * 框已经开着时这里一律不插手，否则等于把 Esc 焊死、框再也收不回。
 */
test('有改动时的 Esc：摘掉原生默认动作，框开着时不再插手', async (t) => {
  const { dom } = await mount(t);
  dom.app.querySelector('.host-table tbody tr').click();
  await flush();

  const drawer = dom.app.querySelector('.host-drawer');
  drawer.querySelectorAll('textarea')[0].value = 'A=1';
  drawer.querySelector('.drawer-form').dispatchEvent({ type: 'input' });
  await flush();

  let prevented = 0;
  key(dom.document, 'Escape', { preventDefault: () => { prevented += 1; } });
  await flush();
  assert.equal(dom.app.querySelector('.confirm-dialog').open, true, '有改动该先弹确认框');
  assert.equal(drawer.hidden, false, '还没确认就关抽屉等于悄悄丢草稿');
  assert.equal(prevented, 1, '这一记 Esc 的原生默认动作会把刚开的框顺手关掉，必须摘掉');

  // 框开着时再按 Esc：交给框自己的原生 cancel，这边不许再 preventDefault
  key(dom.document, 'Escape', { preventDefault: () => { prevented += 1; } });
  await flush();
  assert.equal(prevented, 1, '框已经开着还 preventDefault，等于把 Esc 焊死');
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

/**
 * 回归（issue #32）：主机表在任何状态更新时整片重建（`pending:changed → renderAll`，
 * `hosts:changed → renderOne` 整行 replaceWith），焦点跟着被扔回文档顶端。
 * 真机实测：按 Enter 拉起之后焦点就一直是 body，整个启动过程键盘用户找不回自己的位置；
 * 连「更新的是另一台」都会把当前这台的焦点掀掉。
 */
test('状态更新不许把表内焦点甩掉：同一控件还在就留在它上面', async (t) => {
  const { dom, es } = await mount(t, { hosts: [running('gpu-1'), hostView('gpu-2')] });
  es().open();
  es().send('snapshot', {
    revision: 1, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [running('gpu-1'), hostView('gpu-2')], logs: [],
  });
  await flush();

  const rowOf = (name) => dom.app.querySelectorAll('.host-table tbody tr').find((r) => r.dataset.host === name);
  const btnOf = (name, label) => rowOf(name).querySelectorAll('button').find((b) => b.textContent === label);

  // 焦点在 gpu-2 的行上，更新的是 gpu-1——凭什么动我
  rowOf('gpu-2').focus();
  es().send('host-changed', { revision: 2, host: running('gpu-1') });
  await flush();
  assert.equal(dom.document.activeElement?.dataset?.host, 'gpu-2', '更新别人却把我的焦点掀了');

  // 焦点在自己行内的按钮上，自己被更新：同名控件还在，就该还在它上面
  btnOf('gpu-2', '探测').focus();
  es().send('host-changed', { revision: 3, host: hostView('gpu-2') });
  await flush();
  assert.equal(dom.document.activeElement?.textContent, '探测', '同一个按钮还在，焦点却跑了');
  assert.equal(dom.document.activeElement?.closest('tr')?.dataset?.host, 'gpu-2');
});

/**
 * 回归（issue #32）：确认关停之后那一行的按钮组会换成「拉起/探测」，
 * 原来的触发键被移除——焦点于是掉到 body。控件没了也得有个落点。
 */
test('触发控件在更新后消失时，焦点退到它所在的那一行', async (t) => {
  const { dom, es } = await mount(t, { hosts: [running('gpu-1')] });
  es().open();
  es().send('snapshot', {
    revision: 1, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [running('gpu-1')], logs: [],
  });
  await flush();

  const row = () => dom.app.querySelector('.host-table tbody tr');
  const stop = row().querySelectorAll('button').find((b) => b.textContent === '关停');
  assert.ok(stop, '运行中的主机该有关停键');
  stop.focus();

  es().send('host-changed', { revision: 2, host: hostView('gpu-1') }); // 停了：关停键消失
  await flush();
  assert.equal(row().querySelectorAll('button').some((b) => b.textContent === '关停'), false, '前提：关停键确实没了');
  assert.equal(dom.document.activeElement, row(), '控件没了就该退到那一行，别把人扔回文档顶端');
});

/**
 * 回归（issue #32）：同名控件还在也未必接得住焦点——忙碌态下它是 disabled，
 * `focus()` 静默失效。真机上按「拉起」的那一拍正是这样，焦点照样掉回 body。
 */
test('同名控件还在但已禁用时，焦点退到那一行而不是白焦一场', async (t) => {
  const { dom, es } = await mount(t, { hosts: [hostView('gpu-1')] });
  es().open();
  es().send('snapshot', {
    revision: 1, manager: MANAGER_INFO, defaults: DEFAULTS, hosts: [hostView('gpu-1')], logs: [],
  });
  await flush();

  const row = () => dom.app.querySelector('.host-table tbody tr');
  const probe = row().querySelectorAll('button').find((b) => b.textContent === '探测');
  probe.focus();

  // 与 manager 失联 → 写操作禁用（探测键还在，但 disabled）
  for (const fn of es().listeners.get('error')) fn({});
  await flush();
  const still = row().querySelectorAll('button').find((b) => b.textContent === '探测');
  assert.ok(still, '前提：探测键还在');
  assert.equal(still.disabled, true, '前提：它该是禁用的');
  assert.equal(dom.document.activeElement, row(), '禁用键接不住焦点，就该退到那一行');
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

test('菜单里选完一项，焦点回到开它的那个标签', async (t) => {
  const { dom } = await mount(t, { hosts: [running('gpu-1')] });
  const tab = dom.app.querySelector('.tabbar .host-tabs .tab');
  const menu = dom.app.querySelector('.context-menu');

  tab.focus();
  key(tab, 'F10', { shiftKey: true });
  const copy = menu.querySelectorAll('button').find((b) => /复制/.test(b.textContent));
  assert.ok(copy, '前提：运行中的主机有「复制地址」');
  copy.focus();
  copy.click();
  await flush();

  assert.equal(menu.hidden, true, '选完就该收');
  // 菜单一藏，那个按钮带着焦点消失，不接管就掉回 body
  assert.equal(dom.document.activeElement, tab);
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
