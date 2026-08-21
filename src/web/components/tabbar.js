/**
 * 顶部标签栏 + 右键/长按菜单（10 §3.1 / UI-10、UI-11）。
 *
 * 可见性与菜单裁剪都是纯函数（visibleTabs / menuItems），单测直接覆盖。
 */

import { ACTION_LABEL, clear, copyText, el, isManaged, phaseMeta } from '../utils.js';

const LONG_PRESS_MS = 550;

/**
 * 标签可见性（10 §3.1）：running/degraded 自动出现；crashed 只保留已打开的；
 * 关停回 ready 后移除。当前正停留的主机标签不能凭空消失（否则用户视图错位）。
 * @param {Iterable<object>} hosts
 * @param {{opened?:Set<string>, currentHost?:string|null}} [opts]
 */
export function visibleTabs(hosts, { opened = new Set(), currentHost = null } = {}) {
  const out = [];
  for (const host of hosts) {
    const auto = host.phase === 'running' || host.phase === 'degraded';
    const kept = (host.phase === 'crashed' || host.phase === 'starting') && (opened.has(host.name) || currentHost === host.name);
    if (auto || kept) out.push(host);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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

/** 菜单项按 phase / 归属裁剪（无效项禁用而非隐藏，位置稳定）。 */
export function menuItems(host) {
  const managed = isManaged(host);
  const running = host?.phase === 'running';
  const degraded = host?.phase === 'degraded';
  const crashed = host?.phase === 'crashed';
  return [
    { action: 'restart', label: ACTION_LABEL.restart, enabled: managed && (running || degraded || crashed) },
    { action: 'stop', label: ACTION_LABEL.stop, enabled: managed && (running || degraded) },
    { action: 'reconnect', label: ACTION_LABEL.reconnect, enabled: managed && degraded },
    { action: 'copy-address', label: '复制本机映射地址', enabled: Boolean(host?.mappedUrl) },
  ];
}

export function createTabbar({ store, actions, panes }) {
  const dashTab = el('button.tab.tab-dashboard', {
    type: 'button', role: 'tab', text: '⌂ 管理台', on: { click: () => actions.navigate('#/') },
  });
  const hostTabs = el('div.host-tabs', { role: 'tablist' });
  const probeAllBtn = el('button.icon-button.probe-all', {
    type: 'button', 'aria-label': '重新探测全部主机', text: '⟳', on: { click: () => actions.probeAll() },
  });
  const root = el('nav.tabbar', { 'aria-label': '工作区' }, [dashTab, hostTabs, probeAllBtn]);

  const menu = el('menu.context-menu', { hidden: true, role: 'menu', 'aria-label': '主机操作' });
  let menuHost = null;

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

  function openMenu(name, x, y) {
    const host = store.getHost(name);
    if (!host) return;
    menuHost = name;
    clear(menu);
    for (const item of menuItems(host)) {
      menu.append(el('li', { role: 'none' }, [
        el('button', {
          type: 'button',
          role: 'menuitem',
          text: item.label,
          disabled: !item.enabled || (item.action !== 'copy-address' && !store.canWrite()),
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

  /** 量出菜单实际尺寸后夹进视口；垫片环境没有布局（尺寸全 0），原样返回。 */
  function clampToViewport(x, y) {
    const rect = menu.getBoundingClientRect?.();
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
  };

  // 菜单内上下键移动焦点（UI-27：菜单必须能纯键盘操作）
  menu.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    // 必须摊成数组：真 DOM 给的是 NodeList，没有 indexOf——照着 NodeList 用
    // 会当场抛 TypeError，整个方向键在真浏览器里一个都不动（垫片给的是数组，
    // 所以单测一路绿；冒烟那条判据又因为开菜单时焦点已在首项而判不出来）。
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
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
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu({ restoreFocus: true });
  };
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);

  // ── 标签渲染 ─────────────────────────────────────────────────────────

  function tabNode(host) {
    const meta = phaseMeta(host.phase);
    let pressTimer = null;
    const clearPress = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
    };

    const node = el('button.tab', {
      type: 'button',
      role: 'tab',
      dataset: { host: host.name },
      title: `${host.name} — ${meta.label}`,
      'aria-selected': String(store.state.route.host === host.name),
      'aria-haspopup': 'menu',
      class: store.state.route.host === host.name ? 'is-active' : '',
      on: {
        click: () => actions.openHost(host.name),
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
          const { clientX, clientY } = e;
          pressTimer = setTimeout(() => openMenu(host.name, clientX, clientY), LONG_PRESS_MS);
        },
        pointerup: clearPress,
        pointercancel: clearPress,
        pointerleave: clearPress,
      },
    }, [
      el('span.status-dot', { dataset: { dot: meta.dot }, class: `dot-${meta.tone}` }),
      el('span.tab-label', { text: host.name }),
    ]);
    return node;
  }

  // 上次滚到哪个主机（null = 管理台）；用来只在切换时滚，不在每次重渲染时滚
  let lastScrolledTo;

  function render() {
    const route = store.state.route;
    const tabs = visibleTabs(store.listHosts(), {
      opened: new Set(panes?.openedHosts?.() ?? []),
      currentHost: route.kind === 'host' ? route.host : null,
    });

    clear(hostTabs);
    for (const host of tabs) hostTabs.append(tabNode(host));

    dashTab.classList.toggle('is-active', route.kind !== 'host');
    dashTab.setAttribute('aria-selected', String(route.kind !== 'host'));
    probeAllBtn.disabled = store.isPending('probe-all') || !store.canWrite();
    probeAllBtn.classList.toggle('is-busy', store.isPending('probe-all'));

    // 当前停留的主机标签消失（例如被摘出配置）→ 回管理台，避免停在空白页。
    // hostsLoaded 是必要门禁：首屏就带 host 路由（书签 / 刷新 / dshc open <host>）时
    // 主机集合还没到，那时的「查不到」是尚未同步，不是消失——改写地址会让深链永远
    // 落在管理台（issue #15）。等它到过一次再判，「不存在」的兜底文案由 app.js 给。
    if (route.kind === 'host' && store.state.hostsLoaded
      && !tabs.some((h) => h.name === route.host) && !store.getHost(route.host)) {
      actions.navigate('#/');
    }
    if (!menu.hidden && !tabs.some((h) => h.name === menuHost)) closeMenu();

    // 标签栏能横向滚（.tabbar overflow-x: auto），但从不自己跟到当前位置：主机多、
    // 名字长时，切到靠后那台之后激活标签停在可视区外，看起来像一个都没选中（issue #25）。
    // 只在激活项变化时滚——每次重渲染都滚会把用户自己拖的位置一直拽回去。
    const activeHost = route.kind === 'host' ? route.host : null;
    if (activeHost !== lastScrolledTo) {
      lastScrolledTo = activeHost;
      const node = activeHost ? hostTabs.querySelector('.tab.is-active') : dashTab;
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
    render,
    destroy() {
      for (const off of offs) off();
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    },
  };
}
