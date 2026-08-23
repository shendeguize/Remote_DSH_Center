/**
 * 顶部标签栏 + 右键/长按菜单（10 §3.1 / UI-10、UI-11）。
 *
 * 可见性与菜单裁剪都是纯函数（visibleTabs / menuItems），单测直接覆盖。
 */

import {
  ACTION_LABEL, clear, copyText, el, phaseMeta,
} from '../utils.js';
import {
  isHostActionAllowed, isHostEnabled, primaryHosts,
} from '../host-rules.js';
import { hostPhaseHint, hostStatusText } from '../host-presentation.js';
import { hostPanelId, hostTabId } from './iframe-pane.js';

const LONG_PRESS_MS = 550;

/** ready fallback 独占的稳定 panel ID，避免与 iframe/启动占位的 ID 同时存在。 */
export function hostFallbackPanelId(name) {
  return `host-fallback-panel-${encodeURIComponent(String(name))}`;
}

/**
 * 日常主机常驻区：只按「已启用 + 可用态」判断，不再要求先从管理台打开。
 * @param {Iterable<object>} hosts
 */
export function visibleTabs(hosts) {
  return primaryHosts(hosts);
}

/** 主标签之外的主机集中到 +N 菜单，保证不可用/禁用主机仍然找得到。 */
export function overflowHosts(hosts) {
  const all = [...hosts];
  const primary = new Set(visibleTabs(all).map((host) => host.name));
  return all.filter((host) => !primary.has(host.name)).sort((a, b) => a.name.localeCompare(b.name));
}

/** 贴边时留的这点余量，纯为让人看出「菜单到边了」而不是被裁掉半截。 */
const MENU_EDGE_GAP = 4;

/**
 * 把菜单坐标夹进视口（issue #67）。菜单是 `position: fixed`，越出去的那一截没有
 * 滚动可言——鼠标压根落不上去。所以右边不够就朝左翻、下边不够就朝上翻；翻过去还是
 * 装不下（视口比菜单还小）就贴边。
 *
 * 纯函数：真实尺寸由调用方量好传进来，单测直接覆盖各个方位。
 * @param {{x:number, y:number, menuW:number, menuH:number, viewW:number, viewH:number}} at
 * @returns {{left:number, top:number}}
 */
export function clampMenuPosition({ x, y, menuW, menuH, viewW, viewH }) {
  const fit = (pos, size, view) => {
    if (pos + size <= view) return Math.max(MENU_EDGE_GAP, pos);
    // 朝反方向翻：菜单的那一边贴着光标，这是各家原生菜单的做法
    const flipped = pos - size;
    if (flipped >= 0) return flipped;
    return Math.max(MENU_EDGE_GAP, view - size - MENU_EDGE_GAP); // 视口比菜单还小 → 贴边
  };
  return { left: fit(x, menuW, viewW), top: fit(y, menuH, viewH) };
}

/**
 * 方向键在标签环里落到哪一格（issue #110）。`role="tablist"` 对辅助技术就是一句
 * 承诺：左右移动、Home/End 跳首尾、到头环绕。纯函数，边界（空标签栏、焦点不在环上）
 * 一并在这里收口。
 * @param {string} key 按下的键
 * @param {number} current 当前焦点所在下标，不在环上传 -1
 * @param {number} count 标签总数
 * @returns {number|null} 目标下标；null = 这个键与标签环无关
 */
export function nextTabIndex(key, current, count) {
  if (count <= 0) return null;
  const from = current >= 0 ? current : 0;
  switch (key) {
    case 'ArrowRight': return (from + 1) % count;
    case 'ArrowLeft': return (from - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/** 菜单项按 phase / 归属裁剪（无效项禁用而非隐藏，位置稳定）。 */
export function menuItems(host) {
  return [
    { action: 'restart', label: ACTION_LABEL.restart, enabled: isHostActionAllowed(host, 'restart'), needsWrite: true },
    { action: 'stop', label: ACTION_LABEL.stop, enabled: isHostActionAllowed(host, 'stop'), needsWrite: true },
    { action: 'reconnect', label: ACTION_LABEL.reconnect, enabled: isHostActionAllowed(host, 'reconnect'), needsWrite: true },
    { action: 'copy-address', label: '复制本机映射地址', enabled: Boolean(host?.mappedUrl), needsWrite: false },
    { action: 'view-manage', label: '在管理台查看', enabled: Boolean(host), needsWrite: false },
    { action: 'open-new-window', label: '在新窗口打开', enabled: Boolean(host?.mappedUrl), needsWrite: false },
  ];
}

export function createTabbar({
  store, actions, panes = null, trailing = null,
}) {
  const hostTabs = el('div.host-tabs', { role: 'tablist' });
  const overflowBtn = el('button.icon-button.tab-overflow', {
    type: 'button',
    text: '+0 ▾',
    hidden: true,
    'aria-label': '查看不可用或已禁用的主机',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    on: {
      click: () => toggleOverflowMenu(),
      keydown: (e) => {
        if (e.key !== 'ArrowDown') return;
        e.preventDefault();
        openOverflowMenu();
      },
    },
  });
  const manageBtn = el('button.tab.tab-manage', {
    type: 'button', text: '⌂ 管理', on: { click: () => actions.navigate('#/manage') },
  });
  const right = el('div.tabbar-actions', {}, [overflowBtn, manageBtn, trailing]);
  const root = el('nav.tabbar', { 'aria-label': '工作区' }, [hostTabs, right]);

  const menu = el('menu.context-menu', { hidden: true, role: 'menu', 'aria-label': '主机操作' });
  const overflowMenu = el('menu.context-menu.overflow-menu', {
    hidden: true, role: 'menu', 'aria-label': '其他主机',
  });
  let menuHost = null;
  let pressCycle = null;

  // ── 菜单 ─────────────────────────────────────────────────────────────

  /**
   * 收菜单。`restoreFocus` 时把焦点还给它是从哪个标签开出来的——菜单里的按钮
   * 一旦随菜单隐藏，焦点就掉回 body，选完一项的人于是被丢到文档顶端。
   */
  function closeMenu({ restoreFocus = false } = {}) {
    const from = menuHost;
    menu.hidden = true;
    menuHost = null;
    if (restoreFocus && from) root.querySelector(`[data-host="${CSS.escape(from)}"]`)?.focus();
  }

  function closeOverflowMenu({ restoreFocus = false } = {}) {
    overflowMenu.hidden = true;
    overflowBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !overflowBtn.hidden) overflowBtn.focus();
  }

  function openMappedUrl(name) {
    const url = store.getHost(name)?.mappedUrl;
    if (!url) return;
    let popup = null;
    try {
      popup = typeof window.open === 'function' ? window.open(url, '_blank') : null;
      if (popup) popup.opener = null;
    } catch {
      popup = null;
    }
    if (!popup) {
      store.addToast({ level: 'warn', summary: '新窗口被浏览器拦截，请允许弹出窗口后重试' });
    }
  }

  function openMenu(name, x, y) {
    const host = store.getHost(name);
    if (!host) return;
    closeOverflowMenu();
    menuHost = name;
    clear(menu);
    for (const item of menuItems(host)) {
      menu.append(el('li', { role: 'none' }, [
        el('button', {
          type: 'button',
          role: 'menuitem',
          text: item.label,
          disabled: !item.enabled || (item.needsWrite && !store.canWrite()),
          on: {
            click: async () => {
              closeMenu({ restoreFocus: true });
              if (item.action === 'copy-address') {
                const url = store.getHost(name)?.mappedUrl;
                if (!url) return;
                const ok = await copyText(url);
                store.addToast({ level: ok ? 'success' : 'warn', summary: ok ? `已复制 ${url}` : '复制失败，请手动选择地址' });
                return;
              }
              if (item.action === 'view-manage') {
                actions.viewHostInManage(name);
                return;
              }
              if (item.action === 'open-new-window') {
                openMappedUrl(name);
                return;
              }
              actions.hostAction(item.action, name);
            },
          },
        }),
      ]));
    }
    // 先摆到目标点再量：菜单宽高取决于这次的项数与文案，隐藏状态下量不出来。
    // 两次赋值在同一帧内，看不出跳动。
    menu.hidden = false;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    const at = clampToViewport(x, y);
    menu.style.left = `${at.left}px`;
    menu.style.top = `${at.top}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
  }

  function fillOverflowMenu(hosts) {
    clear(overflowMenu);
    for (const host of hosts) {
      const hint = hostPhaseHint(host);
      const status = hostStatusText(host, { disabled: !isHostEnabled(host) });
      overflowMenu.append(el('li', { role: 'none' }, [
        el('span', { text: `${host.name} — ${status}${hint ? ` · ${hint}` : ''}` }),
        el('button', {
          type: 'button',
          role: 'menuitem',
          text: `探测 ${host.name}`,
          dataset: { host: host.name, action: 'probe' },
          disabled: !store.canWrite() || store.isPending('probe', host.name),
          on: {
            click: () => {
              closeOverflowMenu({ restoreFocus: true });
              actions.hostAction('probe', host.name);
            },
          },
        }),
        el('button', {
          type: 'button',
          role: 'menuitem',
          text: `在管理台查看 ${host.name}`,
          dataset: { host: host.name, action: 'view-manage' },
          on: {
            click: () => {
              closeOverflowMenu({ restoreFocus: true });
              actions.viewHostInManage(host.name);
            },
          },
        }),
      ]));
    }
  }

  function positionOverflowMenu() {
    const at = anchorOf(overflowBtn);
    overflowMenu.style.left = `${at.x}px`;
    overflowMenu.style.top = `${at.y}px`;
    const clamped = clampToViewport(at.x, at.y, overflowMenu);
    overflowMenu.style.left = `${clamped.left}px`;
    overflowMenu.style.top = `${clamped.top}px`;
  }

  function overflowFocusKey(node) {
    if (!node || !overflowMenu.contains(node)) return null;
    const { host, action } = node.dataset ?? {};
    return host && action ? { host, action } : null;
  }

  function restoreOverflowFocus(key) {
    if (!key) return;
    const buttons = [...overflowMenu.querySelectorAll('button')];
    const exact = buttons.find((node) => (
      node.dataset.host === key.host && node.dataset.action === key.action
    ));
    if (exact && !exact.disabled) {
      exact.focus();
      return;
    }
    const sameHost = buttons.find((node) => node.dataset.host === key.host && !node.disabled);
    if (sameHost) {
      sameHost.focus();
      return;
    }
    if (!overflowBtn.hidden) overflowBtn.focus();
  }

  function openOverflowMenu() {
    const hosts = overflowHosts(store.listHosts());
    if (hosts.length === 0) return;
    closeMenu();
    fillOverflowMenu(hosts);
    overflowMenu.hidden = false;
    overflowBtn.setAttribute('aria-expanded', 'true');
    positionOverflowMenu();
    overflowMenu.querySelector('button:not(:disabled)')?.focus();
  }

  function toggleOverflowMenu() {
    if (overflowMenu.hidden) openOverflowMenu();
    else closeOverflowMenu({ restoreFocus: true });
  }

  /** 量出菜单实际尺寸后夹进视口；垫片环境没有布局（尺寸全 0），原样返回。 */
  function clampToViewport(x, y, target = menu) {
    const rect = target.getBoundingClientRect?.();
    const viewW = window.innerWidth ?? 0;
    const viewH = window.innerHeight ?? 0;
    if (!rect?.width || !viewW || !viewH) return { left: x, top: y };
    return clampMenuPosition({
      x, y, menuW: rect.width, menuH: rect.height, viewW, viewH,
    });
  }

  /** 键盘开菜单时把它挂在标签下沿；垫片环境没有布局，退回原点即可。 */
  function anchorOf(node) {
    const rect = node.getBoundingClientRect?.();
    return rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 };
  }

  const onDocPointerDown = (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
    if (!overflowMenu.hidden && !overflowMenu.contains(e.target) && e.target !== overflowBtn) closeOverflowMenu();
  };

  // 菜单内上下键移动焦点（UI-27：菜单必须能纯键盘操作）
  function attachMenuKeyboard(target) {
    target.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      // 必须摊成数组：真 DOM 给的是 NodeList，没有 indexOf——照着 NodeList 用
      // 会当场抛 TypeError，整个方向键在真浏览器里一个都不动（垫片给的是数组，
      // 所以单测一路绿；冒烟那条判据又因为开菜单时焦点已在首项而判不出来）。
      const items = [...target.querySelectorAll('button:not(:disabled)')];
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement);
      const next = {
        ArrowDown: at + 1 >= items.length ? 0 : at + 1,
        ArrowUp: at <= 0 ? items.length - 1 : at - 1,
        Home: 0,
        End: items.length - 1,
      }[e.key];
      items[next].focus();
    });
  }
  attachMenuKeyboard(menu);
  attachMenuKeyboard(overflowMenu);
  /**
   * 标签环里的方向键（issue #110）。走**手动激活**：方向键只移焦点，Enter/Space 才切
   * 页——切到没打开过的主机会新建 iframe 去拉远端页面，一路划过去不该顺手拉起十个。
   * ArrowDown 已被「开操作菜单」占着，这里不碰。
   */
  hostTabs.addEventListener('keydown', (e) => {
    const tabs = [...hostTabs.querySelectorAll('.tab')];
    const next = nextTabIndex(e.key, tabs.indexOf(document.activeElement), tabs.length);
    if (next === null) return;
    e.preventDefault();
    focusTab(tabs[next]);
  });

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu({ restoreFocus: true });
    else if (e.key === 'Escape' && !overflowMenu.hidden) closeOverflowMenu({ restoreFocus: true });
  };
  const closeMenus = () => {
    closeMenu();
    closeOverflowMenu();
  };
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', closeMenus);
  window.addEventListener('scroll', closeMenus, true);

  // ── 标签渲染 ─────────────────────────────────────────────────────────

  /**
   * 焦点跟着 tabindex 一起走（roving tabindex）：tablist 按 ARIA 只该占**一个** Tab
   * 落点，否则 24 台就得按 24 次 Tab 才走得过标签栏。落点跟着焦点挪，人 Tab 出去再
   * 回来还在原地。
   */
  function focusTab(node) {
    if (!node) return;
    for (const tab of hostTabs.querySelectorAll('.tab')) tab.setAttribute('tabindex', tab === node ? '0' : '-1');
    node.focus();
  }

  function samePointerCycle(event, cycle) {
    return event.pointerId == null || cycle.pointerId == null || event.pointerId === cycle.pointerId;
  }

  function clearPressCycle(cycle = pressCycle) {
    if (!cycle || pressCycle !== cycle) return;
    if (cycle.timer) clearTimeout(cycle.timer);
    if (cycle.expiry) clearTimeout(cycle.expiry);
    pressCycle = null;
  }

  function beginPress(host, event) {
    clearPressCycle();
    const cycle = {
      host: host.name,
      pointerId: event.pointerId,
      openedMenu: false,
      timer: null,
      expiry: null,
    };
    cycle.timer = setTimeout(() => {
      if (pressCycle !== cycle) return;
      cycle.timer = null;
      cycle.openedMenu = true;
      openMenu(host.name, event.clientX, event.clientY);
    }, LONG_PRESS_MS);
    pressCycle = cycle;
  }

  function finishPress(event) {
    const cycle = pressCycle;
    if (!cycle || !samePointerCycle(event, cycle)) return;
    if (cycle.timer) clearTimeout(cycle.timer);
    cycle.timer = null;
    if (!cycle.openedMenu) {
      clearPressCycle(cycle);
      return;
    }
    // touch 生成的 click 紧跟 pointerup；只把这个周期留到该 click，下一轮任务自动作废。
    cycle.expiry = setTimeout(() => clearPressCycle(cycle), 0);
  }

  function cancelPress(event) {
    const cycle = pressCycle;
    if (cycle && samePointerCycle(event, cycle)) clearPressCycle(cycle);
  }

  function consumeLongPressClick(host, event) {
    const cycle = pressCycle;
    if (!cycle || !cycle.openedMenu || cycle.host !== host || !samePointerCycle(event, cycle)) return false;
    clearPressCycle(cycle);
    return true;
  }

  function tabNode(host) {
    const meta = phaseMeta(host.phase);
    const selected = store.state.route.host === host.name;
    const usesFallback = selected && host.phase === 'ready' && !store.isPending('start', host.name);

    const node = el('button.tab', {
      id: hostTabId(host.name),
      type: 'button',
      role: 'tab',
      dataset: { host: host.name },
      title: `${host.name} — ${meta.label}${host.local === true ? ' — 本机' : ''}`,
      'aria-selected': String(selected),
      'aria-controls': usesFallback ? hostFallbackPanelId(host.name) : hostPanelId(host.name),
      'aria-haspopup': 'menu',
      class: selected ? 'is-active' : '',
      on: {
        click: (event) => {
          if (consumeLongPressClick(host.name, event)) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          const transferFocus = event.detail === 0 && (host.phase === 'ready' || host.phase === 'starting');
          actions.openHost(host.name);
          if (transferFocus) panes?.focusStatusWhenAvailable?.(host.name);
        },
        contextmenu: (e) => {
          e.preventDefault();
          openMenu(host.name, e.clientX, e.clientY);
        },
        // 鼠标右键/长按之外的第三条路：纯键盘也要开得出菜单
        keydown: (e) => {
          const wantsMenu = e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') || e.key === 'ArrowDown';
          if (!wantsMenu) return;
          e.preventDefault();
          const at = anchorOf(node);
          openMenu(host.name, at.x, at.y);
        },
        pointerdown: (e) => {
          if (e.pointerType === 'mouse') return; // 鼠标走 contextmenu
          beginPress(host, e);
        },
        pointerup: finishPress,
        pointercancel: cancelPress,
        pointerleave: cancelPress,
      },
    }, [
      el('span.status-dot', { dataset: { dot: meta.dot }, class: `dot-${meta.tone}` }),
      el('span.tab-label', { text: host.name }),
      host.local === true ? el('span.tag.tag-lock', { text: '本机' }) : null,
    ]);
    return node;
  }

  // 上次滚到哪个路由目标；用来只在切换时滚，不在每次重渲染时滚
  let lastScrolledTo;

  function render() {
    const route = store.state.route;
    const hosts = store.listHosts();
    const tabs = visibleTabs(hosts);
    const overflow = overflowHosts(hosts);

    // 标签整片重建，旧节点带着焦点被移除，浏览器只能把焦点交回 body——方向键走到
    // 一半来一帧 SSE 就丢位置。认「同一个标签」靠 data-host（issue #110）。
    const held = document.activeElement;
    const heldHost = held && hostTabs.contains?.(held) ? held.dataset?.host ?? null : null;
    const heldOverflow = overflowFocusKey(held);
    const heldOverflowButton = held === overflowBtn;
    const overflowWasOpen = !overflowMenu.hidden;

    clear(hostTabs);
    for (const host of tabs) hostTabs.append(tabNode(host));

    // roving tabindex：Tab 进标签栏落在当前选中的那个上，没选中就落第一个
    const nodes = [...hostTabs.querySelectorAll('.tab')];
    const stop = nodes.find((n) => n.dataset.host === route.host) ?? nodes[0];
    for (const n of nodes) n.setAttribute('tabindex', n === stop ? '0' : '-1');
    if (heldHost) focusTab(nodes.find((n) => n.dataset.host === heldHost) ?? stop);

    overflowBtn.hidden = overflow.length === 0;
    overflowBtn.textContent = `+${overflow.length} ▾`;
    overflowBtn.setAttribute('aria-label', `${overflow.length} 台不可用或已禁用的主机`);
    if (overflowWasOpen && overflow.length > 0) {
      fillOverflowMenu(overflow);
      positionOverflowMenu();
      restoreOverflowFocus(heldOverflow);
    } else if (overflow.length === 0) {
      closeOverflowMenu();
      if (heldOverflow || heldOverflowButton) {
        const promoted = nodes.find((node) => node.dataset.host === heldOverflow?.host) ?? stop;
        if (promoted) focusTab(promoted);
        else manageBtn.focus();
      }
    }

    const managing = route.kind === 'manage';
    manageBtn.classList.toggle('is-active', managing);
    manageBtn.setAttribute('aria-pressed', String(managing));
    if (managing) manageBtn.setAttribute('aria-current', 'page');
    else manageBtn.removeAttribute('aria-current');

    // 当前停留的主机从状态里消失（例如被摘出配置）→ 回起始页，避免停在空白页。
    // hostsLoaded 是必要门禁：首屏就带 host 路由（书签 / 刷新 / dshc open <host>）时
    // 主机集合还没到，那时的「查不到」是尚未同步，不是消失——改写地址会让深链永远
    // 落在管理台（issue #15）。等它到过一次再判，「不存在」的兜底文案由 app.js 给。
    if (route.kind === 'host' && store.state.hostsLoaded
      && !tabs.some((h) => h.name === route.host) && !store.getHost(route.host)) {
      actions.navigate('#/');
    }
    if (!menu.hidden && !tabs.some((h) => h.name === menuHost)) closeMenu();

    // 主机标签区能横向滚（.host-tabs overflow-x: auto），但从不自己跟到当前位置：主机多、
    // 名字长时，切到靠后那台之后激活标签停在可视区外，看起来像一个都没选中（issue #25）。
    // 只在激活项变化时滚——每次重渲染都滚会把用户自己拖的位置一直拽回去。
    const activeTarget = route.kind === 'host' ? route.host : (managing ? '@manage' : null);
    if (activeTarget !== lastScrolledTo) {
      lastScrolledTo = activeTarget;
      const node = activeTarget === '@manage' ? manageBtn : hostTabs.querySelector('.tab.is-active');
      node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }

  const offs = [
    store.on('hosts:changed', render),
    store.on('hosts:reset', render),
    store.on('route:changed', render),
    store.on('pending:changed', render),
    store.on('connection:changed', render),
  ];
  render();

  return {
    root,
    menu,
    overflowMenu,
    render,
    destroy() {
      clearPressCycle();
      for (const off of offs) off();
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', closeMenus);
      window.removeEventListener('scroll', closeMenus, true);
    },
  };
}
