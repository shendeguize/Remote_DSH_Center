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
