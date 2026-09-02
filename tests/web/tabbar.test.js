/** 标签可见性与右键菜单裁剪（10 §3.1 / UI-10、UI-11）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clampMenuPosition, hostFallbackPanelId, menuItems, nextTabIndex, overflowHosts, visibleTabs,
} from '../../src/web/components/tabbar.js';
import { hostPanelId } from '../../src/web/components/iframe-pane.js';
import { isHostActionAllowed } from '../../src/web/host-rules.js';

const host = (name, phase, patch = {}) => ({
  name, phase, enabled: true, local: false, mappedUrl: null, web: { pid: 1, startedByUs: true }, ...patch,
});
const PHASES = ['running', 'degraded', 'crashed', 'ready', 'starting', 'no_dsh', 'unreachable', 'unknown'];
const MENU_HOST_ACTIONS = ['restart', 'stop', 'reconnect'];

test('主标签：enabled 的 ready/starting/running/degraded/crashed 全部常驻', () => {
  const tabs = visibleTabs([
    host('e', 'crashed'),
    host('d', 'degraded'),
    host('c', 'running'),
    host('b', 'starting'),
    host('a', 'ready'),
  ]);
  assert.deepEqual(tabs.map((h) => h.name), ['a', 'b', 'c', 'd', 'e']);
});

test('主标签之外统一收纳：unreachable/no_dsh/unknown/disabled 都可找到', () => {
  const hosts = [
    host('ready', 'ready'),
    host('offline', 'unreachable'),
    host('missing', 'no_dsh'),
    host('waiting', 'unknown'),
    host('disabled-running', 'running', { enabled: false }),
  ];
  assert.deepEqual(visibleTabs(hosts).map((h) => h.name), ['ready']);
  assert.deepEqual(
    overflowHosts(hosts).map((h) => h.name),
    ['disabled-running', 'missing', 'offline', 'waiting'],
  );
});

test('主标签按 hostOrder 重排：未排序主机按名排末尾，收纳桶集合不变', () => {
  const hosts = [
    host('gpu-c', 'running'),
    host('gpu-a', 'running'),
    host('gpu-b', 'running'),
    host('offline', 'unreachable'),
    host('disabled-running', 'running', { enabled: false }),
  ];
  assert.deepEqual(
    visibleTabs(hosts, ['gpu-b', 'gpu-c']).map((h) => h.name),
    ['gpu-b', 'gpu-c', 'gpu-a'],
  );
  // spill 桶（不可用/禁用）不受顺序影响，集合与字母序都不变
  assert.deepEqual(
    overflowHosts(hosts, ['gpu-b', 'gpu-c']).map((h) => h.name),
    ['disabled-running', 'offline'],
  );
});

test('ready fallback panel id 对任意主机名稳定编码，且不占用 iframe panel id', () => {
  const name = 'gpu a/1';
  assert.equal(hostFallbackPanelId(name), 'host-fallback-panel-gpu%20a%2F1');
  assert.notEqual(hostFallbackPanelId(name), hostPanelId(name));
});

test('菜单写动作在八态与受管/手动实例上逐项复用共享矩阵', () => {
  for (const phase of PHASES) {
    for (const startedByUs of [true, false]) {
      const current = host(`${phase}-${startedByUs}`, phase, { web: { pid: 9, startedByUs } });
      const byAction = new Map(menuItems(current).map((item) => [item.action, item]));
      for (const action of MENU_HOST_ACTIONS) {
        assert.equal(
          byAction.get(action)?.enabled,
          isHostActionAllowed(current, action),
          `${phase}/${startedByUs ? '受管' : '手动'} 的 ${action} 必须与共享矩阵一致`,
        );
      }
    }
  }
});

test('菜单允许手动 degraded 重连，且不向 starting 暴露 stop', () => {
  const manualDegraded = Object.fromEntries(
    menuItems(host('manual-degraded', 'degraded', {
      web: { pid: 9, startedByUs: false },
    })).map((item) => [item.action, item.enabled]),
  );
  assert.equal(manualDegraded.reconnect, true);
  assert.equal(manualDegraded.restart, false);
  assert.equal(manualDegraded.stop, false);

  for (const startedByUs of [true, false]) {
    const starting = Object.fromEntries(
      menuItems(host(`starting-${startedByUs}`, 'starting', {
        web: { pid: 9, startedByUs },
      })).map((item) => [item.action, item.enabled]),
    );
    assert.equal(starting.stop, false);
  }
});

test('菜单辅助动作只按映射地址裁剪', () => {
  const mapped = Object.fromEntries(menuItems(host('mapped', 'running', {
    mappedUrl: 'http://127.0.0.1:1/',
  })).map((item) => [item.action, item.enabled]));
  const unmapped = Object.fromEntries(menuItems(host('unmapped', 'degraded')).map((item) => [item.action, item.enabled]));

  for (const action of ['copy-address', 'open-new-window']) {
    assert.equal(mapped[action], true, `${action} 有映射地址时可用`);
    assert.equal(unmapped[action], false, `${action} 无映射地址时禁用`);
  }
  assert.equal(mapped['view-manage'], true);
  assert.equal(unmapped['view-manage'], true);
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

test('窄屏壳层只让主机标签独立横滚，固定入口不收缩', () => {
  const css = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'style.css'),
    'utf8',
  );
  assert.match(css, /\.app-shell\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/s, '整条壳不能横滚');
  assert.match(css, /\.brand\s*\{[^}]*flex(?:-shrink)?:\s*(?:none|0)/s, '品牌不能被长标签挤掉');
  assert.match(css, /\.host-tabs\s*\{[^}]*flex:\s*1[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/s,
    '只有主机标签区应吃剩余宽度并独立横滚');
  assert.match(css, /\.tabbar-actions\s*\{[^}]*flex:\s*none/s, 'overflow、管理与连接灯必须留在视口内');
  assert.match(css, /\.tab-label\s*\{[^}]*max-width:[^;}]+;[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s,
    '长主机名必须截断，不能把管理入口推出 390px 视口');
  assert.doesNotMatch(css, /\.tabbar\s*\{[^}]*overflow-x:\s*auto/s, '横滚放在 host-tabs，不能滚走管理入口');
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
