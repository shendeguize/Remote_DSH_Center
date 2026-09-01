/**
 * 页面共享的主机分类与生命周期规则。
 *
 * 纯数据、纯函数：不依赖 DOM 或 Node，Hub、Tab 与动作入口都应消费这里的语义。
 */

export const PRIMARY_HOST_PHASES = Object.freeze([
  'ready',
  'starting',
  'running',
  'degraded',
  'crashed',
]);

export function isPrimaryHostPhase(phase) {
  return PRIMARY_HOST_PHASES.includes(phase);
}

export function isHostEnabled(host) {
  return (host?.config?.enabled ?? host?.enabled) === true;
}

export function isManagedHost(host) {
  return host?.web?.startedByUs === true;
}

export function isPrimaryHost(host) {
  return isHostEnabled(host) && !host?.orphaned && isPrimaryHostPhase(host?.phase);
}

/** @param {Iterable<object>} hosts */
export function primaryHosts(hosts) {
  return [...hosts]
    .filter(isPrimaryHost)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const ACTIONS = Object.freeze({
  probe: Object.freeze(['probe']),
  ready: Object.freeze(['start', 'probe']),
  starting: Object.freeze(['open', 'probe']),
  managedRunning: Object.freeze(['open', 'restart', 'stop', 'probe']),
  managedDegraded: Object.freeze(['open', 'reconnect', 'restart', 'stop', 'probe']),
  managedCrashed: Object.freeze(['open', 'restart', 'probe']),
  manualRunning: Object.freeze(['open', 'probe']),
  manualDegraded: Object.freeze(['open', 'reconnect', 'probe']),
  manualCrashed: Object.freeze(['start', 'probe']),
});

/**
 * 返回当前生命周期允许的不可变动作列表。
 *
 * 后端契约：stop 只接受 running/degraded 且必须 startedByUs；reconnect 接受
 * degraded/running 且不检查 startedByUs。页面只把 reconnect 暴露在 degraded；
 * running 的竞态请求由 actions.js 判为「已自行恢复」。
 */
export function allowedHostActions(host) {
  if (host?.orphaned === true && host.local !== true) return Object.freeze(['open'])
  switch (host?.phase) {
    case 'ready':
      return ACTIONS.ready;
    case 'starting':
      return ACTIONS.starting;
    case 'running':
      return isManagedHost(host) ? ACTIONS.managedRunning : ACTIONS.manualRunning;
    case 'degraded':
      return isManagedHost(host) ? ACTIONS.managedDegraded : ACTIONS.manualDegraded;
    case 'crashed':
      return isManagedHost(host) ? ACTIONS.managedCrashed : ACTIONS.manualCrashed;
    default:
      return ACTIONS.probe;
  }
}

export function isHostActionAllowed(host, action) {
  return allowedHostActions(host).includes(action);
}

/**
 * 每个 phase 的行内按钮排布——同一 phase 的两行必须给出同样多、同样顺序的按钮。
 *
 * 只按 allowedHostActions 增删按钮，会让两台都写着「运行中」的主机长出不同的操作列：
 * 领养来的实例悄悄少掉「重启」「关停」，用户只看到「为什么这两行不一样」，看不到
 * 「因为它不是本工具拉起的」。位置固定 + 禁用理由，与顶部标签菜单的口径一致。
 */
const ROW_LAYOUT = Object.freeze({
  ready: Object.freeze(['start', 'probe']),
  starting: Object.freeze(['open', 'probe']),
  running: Object.freeze(['open', 'restart', 'stop', 'probe']),
  degraded: Object.freeze(['open', 'reconnect', 'restart', 'stop', 'probe']),
  crashed: Object.freeze(['open', 'start', 'restart', 'probe']),
});

/** 禁用理由：写给「我明明看得见这个按钮，为什么按不动」的人。 */
export function hostActionBlockReason(host, action) {
  if (isHostActionAllowed(host, action)) return null;
  if (host?.orphaned === true && host.local !== true) return 'ssh config 已消失，远程动作已禁用';
  if ((action === 'stop' || action === 'restart') && host?.web && !isManagedHost(host)) {
    return '非本工具拉起，禁用关停/重启';
  }
  if (action === 'start' && host?.web) return '已登记运行中的实例，改用「重启」';
  if ((action === 'open' || action === 'restart') && !host?.web) return '没有已登记的实例，先「拉起」';
  return '当前状态不支持此操作';
}

/**
 * 行内动作槽位（位置固定，能力差异落在 enabled/reason 上）。
 * @returns {{action:string, enabled:boolean, reason:string|null}[]}
 */
export function hostActionSlots(host) {
  // orphaned 主机整台都已出局（主机列有标记，且归到「不可达」组），不必摆一排按不动的按钮
  const layout = host?.orphaned === true && host.local !== true
    ? allowedHostActions(host)
    : (ROW_LAYOUT[host?.phase] ?? ['probe']);
  return layout.map((action) => ({
    action,
    enabled: isHostActionAllowed(host, action),
    reason: hostActionBlockReason(host, action),
  }));
}
