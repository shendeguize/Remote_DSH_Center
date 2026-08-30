/**
 * 主机表格（10 §3.2 / UI-12、UI-13）。
 *
 * 单台 SSE 更新只重绘对应 <tr>，不整表重排；缺字段一律显示「—」，
 * 不从主机名或默认值推断。
 */

import {
  ACTION_LABEL, DASH, button, clear, el, fmtAgo, isManaged, phaseBadge, rowActions, text,
} from '../utils.js';
import {
  hostDshSummary, hostMappingSummary, hostPhaseHint, hostPhaseMeta,
} from '../host-presentation.js';
import { isHostEnabled } from '../host-rules.js';
import { field, input } from '../form.js';

const COLUMNS = ['主机', '状态', 'dsh', '本机映射', 'PID', '自启', '操作'];
export const HOST_GROUPS = Object.freeze([
  Object.freeze({
    id: 'started',
    label: '已启动',
    phases: Object.freeze(['running', 'starting', 'reconnect', 'abnormal', 'degraded', 'crashed']),
  }),
  Object.freeze({ id: 'ready', label: '可拉起', phases: Object.freeze(['ready']) }),
  Object.freeze({
    id: 'missing-config',
    label: '缺失配置',
    phases: Object.freeze(['no_dsh', 'missing-config']),
  }),
  Object.freeze({ id: 'unreachable', label: '不可达', phases: Object.freeze(['unreachable', 'unknown']) }),
  Object.freeze({ id: 'unmanaged', label: '未纳管', phases: Object.freeze([]) }),
]);

export function hostGroupId(host) {
  if (!isHostEnabled(host)) return 'unmanaged';
  if (host?.orphaned === true) return 'unreachable';
  return HOST_GROUPS.find((group) => group.phases.includes(host?.phase))?.id ?? 'unreachable';
}

export function groupHostViews(hosts) {
  const grouped = Object.fromEntries(HOST_GROUPS.map(({ id }) => [id, []]));
  for (const host of hosts ?? []) grouped[hostGroupId(host)].push(host);
  return grouped;
}

function sortValue(host, key) {
  if (key === 'status') return hostPhaseMeta(host).label;
  if (key === 'dsh') return host.probe?.dshPath ?? host.probe?.version ?? '';
  if (key === 'pid') return host.web?.pid ?? Number.POSITIVE_INFINITY;
  return host.name ?? '';
}

export function sortHostViews(hosts, key = 'name', direction = 'asc') {
  const factor = direction === 'desc' ? -1 : 1;
  return [...hosts].sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    const result = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right));
    return factor * (result || String(a.name).localeCompare(String(b.name)));
  });
}

const COLLAPSE_STORAGE_KEY = 'dshc.host-table.collapsed-groups';

function loadCollapsedGroups() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(COLLAPSE_STORAGE_KEY) ?? '{}');
    return new Set(HOST_GROUPS.map(({ id }) => id).filter((id) => parsed?.[id] === true));
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups(collapsed) {
  try {
    globalThis.localStorage?.setItem(
      COLLAPSE_STORAGE_KEY,
      JSON.stringify(Object.fromEntries([...collapsed].map((id) => [id, true]))),
    );
  } catch {
    // localStorage 不可用时折叠仍在当前页面内有效
  }
}

export function createHostTable({ store, actions }) {
  const tbody = el('tbody');
  const empty = el('p.empty-hint', { text: '尚无主机：确认 ~/.ssh/config 中有可用 Host 条目，然后重新探测。' });
  const countLabel = el('span.card-sub.host-count');
  const localName = field('本机名称（可选）', input('text', '', {
    placeholder: '留空使用系统主机名',
    autocomplete: 'off',
    'aria-label': '本机名称（可选）',
  }));
  const addLocalButton = button('添加本机', {
    onClick: () => actions.addLocalHost(localName.input.value),
  });
  addLocalButton.dataset.act = 'add-local';
  addLocalButton.setAttribute('aria-label', '添加本机');
  const clearOrphanedButton = button('清空 orphaned', {
    variant: 'danger',
    onClick: () => actions.clearOrphaned(),
  });
  clearOrphanedButton.classList.add('clear-orphaned');
  clearOrphanedButton.dataset.act = 'clear-orphaned';
  clearOrphanedButton.setAttribute('aria-label', '清空 orphaned 主机');

  const root = el('section.card.host-table-card', {}, [
    el('header.card-header', {}, [
      el('h2', { text: '主机' }),
      el('div.row-actions', {}, [countLabel, clearOrphanedButton, localName.root, addLocalButton]),
    ]),
    el('div.table-scroll', {}, [
      el('table.host-table', {}, [
        el('thead'),
        tbody,
      ]),
    ]),
    empty,
  ]);

  /** @type {Map<string, HTMLTableRowElement>} */
  const rows = new Map();
  let sortKey = 'name';
  let sortDirection = 'asc';
  const collapsedGroups = loadCollapsedGroups();
  const thead = root.querySelector('thead');

  function renderHead() {
    clear(thead);
    thead.append(el('tr', {}, COLUMNS.map((column) => {
      const key = { 主机: 'name', 状态: 'status', dsh: 'dsh', PID: 'pid' }[column];
      if (!key) return el('th', { text: column });
      const active = key === sortKey;
      const control = button(column, {
        onClick: (event) => {
          event.stopPropagation();
          if (sortKey === key) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
          else {
            sortKey = key;
            sortDirection = 'asc';
          }
          keepFocus(renderAll);
        },
      });
      control.classList.add('host-sort-button');
      control.setAttribute('aria-sort', active ? sortDirection : 'none');
      control.setAttribute('aria-label', `按${column}${active ? (sortDirection === 'asc' ? '升序' : '降序') : '排序'}`);
      return el('th', {}, [control]);
    })));
  }

  function renderGroupRow(group, count) {
    const isCollapsed = collapsedGroups.has(group.id);
    const toggle = button(`${group.label} (${count})`, {
      compact: false,
      onClick: () => {
        if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id);
        else collapsedGroups.add(group.id);
        saveCollapsedGroups(collapsedGroups);
        renderAll();
      },
    });
    toggle.classList.add('host-group-toggle');
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
    toggle.setAttribute('aria-controls', `host-group-${group.id}`);
    toggle.dataset.group = group.id;
    return el('tr.host-group-row', {
      id: `host-group-${group.id}`,
      dataset: { group: group.id, collapsed: String(isCollapsed) },
    }, [
      el('td', { colSpan: COLUMNS.length }, [toggle]),
    ]);
  }

  function syncHeader() {
    const hosts = store.listHosts();
    const loaded = store.state.hostsLoaded;
    const hasLocal = hosts.some((host) => host.local === true);
    const showAddLocal = loaded && !hasLocal;
    const addLocalDisabled = !showAddLocal || !store.canWrite() || store.isPending('local:create');
    countLabel.textContent = hosts.length > 0 ? `${hosts.length} 台` : '';
    const orphanedCount = hosts.filter((host) => !host.local && host.orphaned).length;
    clearOrphanedButton.disabled = orphanedCount === 0
      || !store.canWrite()
      || store.isPending('orphaned:clear');
    clearOrphanedButton.title = orphanedCount === 0
      ? '没有需要清空的 orphaned 主机'
      : (!store.canWrite() ? '与 manager 失联，写操作已暂停' : '删除配置中的 orphaned 条目并清理运行记录');
    localName.root.hidden = !showAddLocal;
    localName.input.disabled = addLocalDisabled;
    addLocalButton.hidden = !showAddLocal;
    addLocalButton.disabled = addLocalDisabled;
    addLocalButton.title = !store.canWrite() ? '与 manager 失联，写操作已暂停' : '';
  }

  function renderAll() {
    clear(tbody);
    rows.clear();
    const hosts = store.listHosts();
    renderHead();
    const grouped = groupHostViews(hosts);
    for (const group of HOST_GROUPS) {
      tbody.append(renderGroupRow(group, grouped[group.id].length));
      if (collapsedGroups.has(group.id)) continue;
      for (const host of sortHostViews(grouped[group.id], sortKey, sortDirection)) {
      const tr = renderRow(host);
      rows.set(host.name, tr);
      tbody.append(tr);
      }
    }
    empty.hidden = hosts.length > 0;
    syncHeader();
  }

  function renderRow(host) {
    const tr = el('tr', {
      dataset: { host: host.name, group: hostGroupId(host) },
      tabindex: '0',
      on: {
        click: () => actions.openHostDrawer(host.name),
        keydown: (e) => {
          // 只认落在行本身的按键。行内控件的 Enter/Space 是它们自己的：这个
          // preventDefault 会连带取消按钮的原生激活，于是键盘用户按「探测」
          // 只会开抽屉、请求一个都发不出去——鼠标点却一切正常（那条路上控件
          // 各自 stopPropagation，压根到不了这里）。
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            actions.openHostDrawer(host.name);
          }
        },
      },
    });

    const ssh = host.sshInfo;
    tr.append(el('td.host-cell', {}, [
      el('strong', { text: host.name }),
      host.local ? el('span.tag.tag-lock', { text: '本机' }) : null,
      ssh
        ? el('small', { text: `${text(ssh.user)}@${text(ssh.hostName)}:${text(ssh.port)}` })
        : (host.local ? null : el('small', { text: 'ssh config 中已消失' })),
      !host.local && host.orphaned
        ? el('span.tag.tag-warn', { text: 'orphaned', title: 'config 里还有，ssh config 里已不见' })
        : null,
    ]));

    const hint = hostPhaseHint(host);
    tr.append(el('td', {}, [
      phaseBadge(hostPhaseMeta(host)),
      hint ? el('small.phase-hint', { text: hint }) : null,
    ]));

    const dsh = hostDshSummary(host);
    tr.append(el('td.dsh-cell', {}, [
      el('span', { text: dsh.line1 }),
      dsh.line2 ? el('small', { text: dsh.line2, title: dsh.line2 }) : null,
      host.probe?.at ? el('small.probe-at', { text: `探测 ${fmtAgo(host.probe.at)}` }) : null,
    ]));

    const mapping = hostMappingSummary(host);
    tr.append(el('td.mapping-cell', {}, [
      mapping.url
        ? el('a.mono-link', {
          href: mapping.url,
          target: '_blank',
          rel: 'noreferrer',
          text: mapping.line1,
          on: { click: (e) => e.stopPropagation() },
        })
        : el('span', { text: mapping.line1 }),
      mapping.line2 ? el('small', { text: mapping.line2 }) : null,
    ]));

    tr.append(el('td.pid-cell', {}, [
      el('span', { text: host.web ? String(host.web.pid) : DASH }),
      host.web && !isManaged(host) ? el('span.tag.tag-lock', { text: '🔒 手动', title: '非本工具拉起，禁用关停/重启' }) : null,
      host.manualInstances.length > 0
        ? el('small', { text: `另有 ${host.manualInstances.length} 个手动实例`, title: host.manualInstances.map((i) => `${i.pid} ${i.args}`).join('\n') })
        : null,
    ]));

    tr.append(el('td.autostart-cell', {}, [renderAutoStart(host)]));
    tr.append(el('td.row-actions', {}, renderActions(host)));
    return tr;
  }

  /** 即改即存；服务端确认前保持 pending，失败由 actions 层回滚并 toast。 */
  function renderAutoStart(host) {
    const busy = store.isPending('config:save', host.name);
    const input = el('input', {
      type: 'checkbox',
      checked: host.config.autoStart,
      disabled: busy || !store.canWrite(),
      'aria-label': `${host.name} 开机自启`,
      dataset: { act: 'autostart' },
      on: {
        click: (e) => e.stopPropagation(),
        change: (e) => actions.setAutoStart(host.name, e.target.checked),
      },
    });
    return el('label.switch', { on: { click: (e) => e.stopPropagation() } }, [input, el('span.switch-track')]);
  }

  function renderActions(host) {
    const busy = store.hostBusy(host.name);
    const writable = store.canWrite();
    return rowActions(host).map((action) => {
      if (action === 'open') {
        return markAct('open', button(ACTION_LABEL.open, {
          variant: 'primary',
          disabled: !writable || (!host.local && host.orphaned),
          title: !writable
            ? '与 manager 失联，写操作已暂停'
            : ((!host.local && host.orphaned) ? 'ssh config 已消失，远程主机不可打开' : null),
          // 「打开」通常是读操作；orphaned 没有可验证的远端身份，不能打开旧映射。
          onClick: (e) => {
            e.stopPropagation();
            actions.openHost(host.name);
          },
        }));
      }
      return markAct(action, button(ACTION_LABEL[action], {
        variant: action === 'stop' ? 'danger' : 'default',
        disabled: busy || !writable || (!host.local && host.orphaned),
        title: !writable
          ? '与 manager 失联，写操作已暂停'
          : ((!host.local && host.orphaned) ? 'ssh config 已消失，远程动作已禁用' : null),
        onClick: (e) => {
          e.stopPropagation();
          actions.hostAction(action, host.name);
        },
      }));
    });
  }

  function markAct(act, node) {
    node.dataset.act = act;
    return node;
  }

  /**
   * 重渲染前后把焦点留住（issue #32）。
   *
   * 这张表在任何写操作（`pending:changed`）和任何主机变更（`hosts:changed`）时都会
   * 整片/整行重建，旧节点带着焦点被移除，浏览器只能把焦点交回 body。键盘用户按下
   * 「拉起」的那一刻就失去了位置：启动要走 5 拍，每拍都重建，他既跟不到变化也回不去。
   *
   * 认「同一个控件」靠两个稳定标记：行的 `data-host` + 控件的 `data-act`
   * （自启开关用 `data-act="autostart"`）。控件因状态变化消失了（关停成功后
   * 「关停」换成「拉起」）就退到那一行——行本身 tabindex=0，是天然落点。
   */
  function keepFocus(render) {
    const active = document.activeElement;
    const inTable = active instanceof HTMLElement && root.contains(active) && active !== root;
    const mark = inTable
      ? { host: active.closest('tr')?.dataset.host ?? null, act: active.dataset.act ?? null }
      : null;

    render();
    if (!mark?.host || document.activeElement === active) return;
    const tr = rows.get(mark.host);
    if (!tr) return;
    // 同名控件还在也未必接得住焦点：忙碌态下它是 disabled，focus() 会静默失效
    // （真机上「拉起」按下的那一拍正是如此，焦点于是照样掉回 body）。
    const same = mark.act ? tr.querySelector(`[data-act="${mark.act}"]`) : null;
    const target = same && !same.disabled ? same : tr;
    target.focus();
  }

  /**
   * 手指底下不换节点（issue #61）。
   *
   * 鼠标与 Space 的原生激活都在「抬起」那一刻，且要求按下与抬起落在同一个 DOM 节点上。
   * 这张表在每条 `host-changed` 上重建对应行，一次重建插进按下与抬起之间，这次操作就
   * 无声无息地没了——用户只知道「按了没反应」。焦点保护（#32）保不住这个：焦点是重建后
   * 补回去的，对激活已经太晚；macOS 上点按钮更是压根不给焦点。
   *
   * 所以按压期间把重绘攒起来，松手再刷。攒的窗口是亚秒级，比丢掉一次点击划算得多。
   */
  let holding = false;
  let queued = null; // null=没攒 | 'all'=整表 | Set<主机名>
  /** @param {string|null} name 只影响一台就给名字，整表重绘给 null */
  function gated(name, render) {
    if (!holding) {
      render();
      return;
    }
    if (queued === 'all') return;
    if (name === null) { queued = 'all'; return; }
    queued ??= new Set();
    queued.add(name);
  }
  let flushTimer = null;
  /**
   * 松手不能当场刷：click 是浏览器在 pointerup / keyup **之后**才派发的，
   * 当场重建会把节点从 click 的派发路径上抽走——刷新自己反倒把这一次点击掐了
   * （真页面上实测到过：闸门拦住了重建，请求却还是没发出）。所以让到下一拍。
   */
  function release() {
    if (!holding || flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      holding = false;
      const pending = queued;
      queued = null;
      if (pending === 'all') keepFocus(renderAll);
      else if (pending) keepFocus(renderAll);
    }, 0);
  }

  const onPressStart = (e) => {
    // 只认落在表内控件上的按压；行本身与空白处重建了也无所谓
    const node = e.target;
    if (!(node instanceof HTMLElement) || !root.contains(node)) return;
    if (e.type === 'keydown' && e.key !== ' ' && e.key !== 'Enter') return;
    holding = true;
  };
  root.addEventListener('pointerdown', onPressStart);
  root.addEventListener('keydown', onPressStart);
  // 抬起可能落在表外（按住拖出去再松手），所以听在 document 上；
  // 窗口整个失焦时 pointerup/keyup 永远不会来，靠 window 的 blur 兜住（blur 不冒泡）
  const RELEASE_EVENTS = ['pointerup', 'pointercancel', 'keyup'];
  for (const type of RELEASE_EVENTS) document.addEventListener(type, release);
  window.addEventListener('blur', release);

  const offs = [
    store.on('hosts:reset', () => gated(null, () => keepFocus(renderAll))),
    store.on('hosts:changed', () => gated(null, () => keepFocus(renderAll))),
    store.on('pending:changed', () => gated(null, () => keepFocus(renderAll))),
    store.on('connection:changed', () => gated(null, () => keepFocus(renderAll))),
  ];
  renderAll();

  return {
    root,
    destroy() {
      for (const off of offs) off();
      for (const type of RELEASE_EVENTS) document.removeEventListener(type, release);
      window.removeEventListener('blur', release);
      if (flushTimer !== null) clearTimeout(flushTimer);
    },
  };
}
