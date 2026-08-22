/**
 * 动作层（10 §4.5 / UI-09）：请求 → pending → 202 结算 → 超时兜底 → 错误 toast。
 *
 * 铁律：这里绝不擅改 host.phase，phase 只由 SSE 推进。
 */

import { ApiError, api } from './api.js';
import { ACTION_TIMEOUT_MS, pendingKey } from './store.js';
import { isManaged, phaseMeta } from './utils.js';

const CALL = {
  start: api.startHost,
  stop: api.stopHost,
  restart: api.restartHost,
  reconnect: api.reconnectHost,
  probe: api.probeHost,
};

const NEEDS_CONFIRM = new Set(['stop', 'restart']);

export function createActions({ store, confirm, navigate }) {
  /** 统一错误呈现：ApiError 的 detail 落可展开区域（10 §3.9）。 */
  function reportError(err, fallback) {
    if (err instanceof ApiError) {
      store.addToast({ level: 'error', summary: err.message || fallback, detail: err.detail ? String(err.detail) : null });
      return;
    }
    store.addToast({ level: 'error', summary: `${fallback}：${err.message}`, detail: err.stack ?? null });
  }

  /**
   * 包住一次写操作：pending 生命周期 + 202 accepted + 超时只解 loading。
   * @param {{action:string, host?:string|null, run:()=>Promise<any>, settleOnResolve?:boolean}} opts
   */
  async function guarded({ action, host = null, run, settleOnResolve = false }) {
    if (!store.canWrite()) {
      store.addToast({ level: 'warn', summary: '与 manager 失联，写操作已暂停' });
      return null;
    }
    if (store.isPending(action, host)) return null;

    const key = pendingKey(action, host);
    store.beginPending({ action, host });
    try {
      const res = await run();
      if (settleOnResolve) {
        store.settlePending(key);
        return res;
      }
      store.acceptPending(key, res?.operationId ?? null, (entry) => {
        store.addToast({
          level: 'warn',
          summary: `${entry.host ?? 'manager'} ${entry.action} 结果未确认（${ACTION_TIMEOUT_MS[entry.action] / 1000}s 未回执）`,
          detail: '请以当前状态为准，或重新探测。manager 侧可能仍在执行。',
        });
      });
      return res;
    } catch (err) {
      store.settlePending(key);
      reportError(err, `${host ?? 'manager'} ${action} 失败`);
      return null;
    }
  }

  async function hostAction(action, name) {
    const host = store.getHost(name);
    if (!host) {
      store.addToast({ level: 'warn', summary: `主机 ${name} 不存在或尚未同步` });
      return null;
    }
    // 点击前重新读 store：自动恢复可能已经跑在手动重连之前（10 §7 第 12 条）
    if (action === 'reconnect' && host.phase === 'running') {
      store.addToast({ level: 'info', summary: `${name} 隧道已自行恢复，无需重连` });
      return null;
    }
    if (NEEDS_CONFIRM.has(action) && !isManaged(host)) {
      store.addToast({ level: 'warn', summary: `${name} 上的 dsh web 不是本工具拉起的，禁止 ${action}` });
      return null;
    }
    if (NEEDS_CONFIRM.has(action)) {
      const ok = await confirm({
        title: action === 'stop' ? `关停 ${name} 的 dsh web？` : `重启 ${name} 的 dsh web？`,
        lines: [
          `进程 PID ${host.web?.pid ?? '—'}，当前状态「${phaseMeta(host.phase).label}」。`,
          '仅关停由本工具拉起且指纹校验通过的进程；页面内未保存的会话会中断。',
        ],
        confirmLabel: action === 'stop' ? '关停' : '重启',
      });
      if (!ok) return null;
    }

    return guarded({ action, host: name, run: () => CALL[action](name) });
  }

  async function probeAll() {
    return guarded({ action: 'probe-all', run: () => api.probeAll() });
  }

  /** 创建响应先落服务端 HostView，再复用既有 probe pending；phase 仍只由响应/SSE 决定。 */
  async function addLocalHost(name) {
    const requestedName = typeof name === 'string' ? name.trim() : '';
    const created = await guarded({
      action: 'local:create',
      settleOnResolve: true,
      run: () => api.createLocalHost(requestedName || undefined),
    });
    if (!created?.host) return created;

    const hostName = created.host.name;
    store.upsertHost(created.host);
    store.addToast({ level: 'success', summary: `已添加本机 ${hostName}，正在探测`, timeoutMs: 4_000 });
    await guarded({
      action: 'probe',
      host: hostName,
      run: () => api.probeHost(hostName),
    });
    return created;
  }

  /** toggle 走 config:save 通道；失败时用响应/回滚保持与服务端一致（10 §7 第 4 条）。 */
  async function setAutoStart(name, value) {
    const host = store.getHost(name);
    if (!host) return null;
    const res = await guarded({
      action: 'config:save',
      host: name,
      settleOnResolve: true,
      run: () => api.saveHostConfig(name, { autoStart: value }),
    });
    if (res?.host) store.upsertHost(res.host);
    else store.emit('hosts:changed', name); // 失败：用本地已有视图复位复选框
    return res;
  }

  async function saveHostConfig(name, patch) {
    const res = await guarded({
      action: 'config:save',
      host: name,
      settleOnResolve: true,
      run: () => api.saveHostConfig(name, patch),
    });
    if (res?.host) {
      store.upsertHost(res.host);
      store.addToast({ level: 'success', summary: `${name} 配置已保存` });
    }
    return res;
  }

  async function saveDefaults(patch) {
    const res = await guarded({
      action: 'defaults:save',
      settleOnResolve: true,
      run: () => api.saveDefaults(patch),
    });
    if (res) {
      store.setDefaults(res.defaults);
      if (res.manager && store.state.manager.info) {
        store.setManagerInfo({ ...store.state.manager.info, ...res.manager });
      }
      store.addToast({
        level: 'success',
        summary: res.restartRequired ? '已保存；manager 端口需重启后生效' : '全局默认已保存',
      });
    }
    return res;
  }

  async function reload() {
    const res = await guarded({ action: 'config:reload', settleOnResolve: true, run: () => api.reload() });
    if (res) {
      store.addToast({
        level: 'success',
        summary: res.changed.length > 0 ? `已重载配置（${res.changed.length} 项变化）` : '配置无变化',
        detail: res.changed.length > 0 ? res.changed.join('\n') : null,
      });
    }
    return res;
  }

  async function restartManager() {
    const ok = await confirm({
      title: '重启 manager？',
      lines: [
        '所有隧道会先关闭再按 autoStart 重建；已打开的页面标签会短暂失联。',
        '前台模式不支持自我重启，manager 会直接拒绝。',
      ],
      confirmLabel: '重启',
    });
    if (!ok) return null;
    return guarded({ action: 'manager:restart', run: () => api.restartManager() });
  }

  function openHost(name) {
    const host = store.getHost(name);
    if (!host) {
      store.addToast({ level: 'warn', summary: `主机 ${name} 不存在或尚未同步` });
      return;
    }
    // ready 标签就是「一步拉起」入口：先提交启动，再立即切路由；phase 仍只等
    // 响应/SSE 推进，绝不在动作层乐观改成 running。
    const enabled = host.config?.enabled ?? host.enabled;
    if (host.phase === 'ready' && enabled !== false) void hostAction('start', name);
    navigate(`#/host/${encodeURIComponent(name)}`);
  }

  function openHostDrawer(name) {
    store.setDrawer({ open: true, host: name, dirty: false });
  }

  function viewHostInManage(name) {
    if (!store.getHost(name)) {
      store.addToast({ level: 'warn', summary: `主机 ${name} 不存在或尚未同步` });
      return;
    }
    navigate('#/manage');
    openHostDrawer(name);
  }

  async function loadHostLog(name, lines = 200) {
    try {
      return await api.hostLog(name, lines);
    } catch (err) {
      reportError(err, `${name} 日志拉取失败`);
      return null;
    }
  }

  return {
    navigate,
    hostAction,
    probeAll,
    addLocalHost,
    setAutoStart,
    saveHostConfig,
    saveDefaults,
    reload,
    restartManager,
    openHost,
    openHostDrawer,
    viewHostInManage,
    loadHostLog,
    reportError,
  };
}
