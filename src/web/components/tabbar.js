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

  function closeMenu() {
    menu.hidden = true;
    menuHost = null;
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
              closeMenu();
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
    menu.hidden = false;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
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
    const items = menu.querySelectorAll('button:not(:disabled)');
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
    if (e.key === 'Escape' && !menu.hidden) {
      const from = menuHost; // closeMenu 会清掉它，先留一份用于还焦
      closeMenu();
      if (from) root.querySelector(`[data-host="${CSS.escape(from)}"]`)?.focus();
    }
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

    // 当前停留的主机标签消失（例如被关停）→ 回管理台，避免停在空白页
    if (route.kind === 'host' && !tabs.some((h) => h.name === route.host) && !store.getHost(route.host)) {
      actions.navigate('#/');
    }
    if (!menu.hidden && !tabs.some((h) => h.name === menuHost)) closeMenu();
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
