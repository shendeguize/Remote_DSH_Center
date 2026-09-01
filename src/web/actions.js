/**
 * 动作层（10 §4.5 / UI-09）：请求 → pending → 202 结算 → 超时兜底 → 错误 toast。
 *
 * 铁律：这里绝不擅改 host.phase，phase 只由 SSE 推进。
 */

import { ApiError, api } from './api.js';
import { isHostEnabled, isManagedHost } from './host-rules.js';
import { ACTION_TIMEOUT_MS, pendingKey } from './store.js';
import { phaseMeta } from './utils.js';

const CALL = {
  start: api.startHost,
  adopt: api.adoptHost,
  stop: api.stopHost,
  restart: api.restartHost,
  reconnect: api.reconnectHost,
  probe: api.probeHost,
};

const NEEDS_CONFIRM = new Set(['stop', 'restart']);
export const CONFIG_SYNC_TARGET_LIMIT = 200;
export const HOST_WEB_RESTART_NOTICE = '需重启此主机的 dsh web（重启 manager 无效）';
const HOST_RESTART_PHASES = new Set(['running', 'degraded', 'starting']);
const ORPHANED_ACTION_MESSAGE = 'ssh config 已消失，远程动作已禁用';

function isOrphaned(host) {
  return Boolean(host && !host.local && host.orphaned);
}

function workdirChangePending(patch, hostBeforeSave, savedHost) {
  if (!Object.hasOwn(patch, 'workdir') || !HOST_RESTART_PHASES.has(savedHost?.phase)) {
    return false;
  }

  const savedWorkdir = savedHost.config?.workdir ?? null;
  if (savedHost.web) return (savedHost.web.workdir ?? null) !== savedWorkdir;

  return savedHost.phase === 'starting'
    && hostBeforeSave?.phase === 'starting'
    && (hostBeforeSave.config?.workdir ?? null) !== savedWorkdir;
}

export function createActions({ store, confirm, navigate }) {
  /** 统一错误呈现：ApiError 的 detail 落可展开区域（10 §3.9）。 */
  function reportError(err, fallback, { preferFallback = false } = {}) {
    let presentation;
    if (err instanceof ApiError) {
      const apiDetail = err.detail ? String(err.detail) : null;
      const detail = preferFallback
        ? [err.message && err.message !== fallback ? err.message : null, apiDetail].filter(Boolean).join('\n') || null
        : apiDetail;
      presentation = {
        level: 'error',
        summary: preferFallback ? fallback : (err.message || fallback),
        detail,
      };
    } else {
      presentation = {
        level: 'error',
        summary: `${fallback}：${err.message}`,
        detail: err.stack ?? null,
      };
    }
    const toast = store.addToast(presentation);
    return {
      ...presentation,
      id: toast.id,
      code: err instanceof ApiError ? err.code : null,
      status: err instanceof ApiError ? err.status : null,
    };
  }

  /**
   * 包住一次受保护操作：pending 生命周期 + 202 accepted + 超时只解 loading。
   * @param {{
   *   action:string, host?:string|null, run:()=>Promise<any>,
   *   settleOnResolve?:boolean, failureMessage?:string, requireWritable?:boolean,
   *   onError?:(toast:{
   *     id:number,level:string,summary:string,detail:string|null,
   *     code:string|null,status:number|null,
   *   })=>void,
   * }} opts
   */
  async function guarded({
    action,
    host = null,
    run,
    settleOnResolve = false,
    failureMessage,
    onError,
    requireWritable = true,
  }) {
    if (requireWritable && !store.canWrite()) {
      const presentation = {
        level: 'warn',
        summary: '与 manager 失联，写操作已暂停',
        detail: null,
      };
      const toast = store.addToast(presentation);
      onError?.({
        ...presentation,
        id: toast.id,
        code: null,
        status: null,
      });
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
      const errorToast = reportError(
        err,
        failureMessage ?? `${host ?? 'manager'} ${action} 失败`,
        { preferFallback: failureMessage !== undefined },
      );
      onError?.(errorToast);
      return null;
    }
  }

  async function hostAction(action, name) {
    const host = store.getHost(name);
    if (!host) {
      store.addToast({ level: 'warn', summary: `主机 ${name} 不存在或尚未同步` });
      return null;
    }
    if (isOrphaned(host) && action !== 'open') {
      store.addToast({ level: 'warn', summary: `${name}：${ORPHANED_ACTION_MESSAGE}` });
      return null;
    }
    // 点击前重新读 store：自动恢复可能已经跑在手动重连之前（10 §7 第 12 条）
    if (action === 'reconnect' && host.phase === 'running') {
      store.addToast({ level: 'info', summary: `${name} 隧道已自行恢复，无需重连` });
      return null;
    }
    if (NEEDS_CONFIRM.has(action) && !isManagedHost(host)) {
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

    if (action === 'start') {
      return guarded({
        action,
        host: name,
        run: () => CALL.start(name),
        onError: async (toast) => {
          if (toast.code !== 'ADOPTION_AVAILABLE') return;
          store.dismissToast(toast.id);
          const choice = await confirm({
            title: `主机 ${name} 已有手动 dsh web`,
            lines: [
              '只读领养只登记现有进程并建立映射，不会停止或重启它。',
              '强拉会启动第二个实例；取消则保持当前状态。',
            ],
            confirmLabel: '只读领养',
            secondaryLabel: '强拉第二份',
            cancelLabel: '取消',
            danger: false,
          });
          if (choice === true) {
            await guarded({ action: 'adopt', host: name, run: () => CALL.adopt(name) });
          } else if (choice === 'secondary') {
            await guarded({ action: 'start', host: name, run: () => CALL.start(name, { forceNew: true }) });
          }
        },
      });
    }
    return guarded({ action, host: name, run: () => CALL[action](name) });
  }

  async function probeAll({ failureMessage } = {}) {
    return guarded({ action: 'probe-all', failureMessage, run: () => api.probeAll() });
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
    const hostBeforeSave = store.getHost(name);
    let hostMergeGuard = null;
    const res = await guarded({
      action: 'config:save',
      host: name,
      settleOnResolve: true,
      run: () => {
        hostMergeGuard = store.captureHostMergeGuard();
        return api.saveHostConfig(name, patch);
      },
    });
    if (res?.host && hostMergeGuard !== null) {
      store.mergeActionHosts([res.host], hostMergeGuard);
    }
    if (res?.host && store.getHost(name)) {
      const restartNotice = workdirChangePending(patch, hostBeforeSave, res.host)
        ? `；${HOST_WEB_RESTART_NOTICE}`
        : '';
      store.addToast({ level: 'success', summary: `${name} 配置已保存${restartNotice}` });
    }
    return res;
  }

  async function syncConfig({
    source, targets, dryRun, previewToken, onError,
  }) {
    if (targets.length > CONFIG_SYNC_TARGET_LIMIT) {
      store.addToast({
        level: 'warn',
        summary: `一次最多同步 ${CONFIG_SYNC_TARGET_LIMIT} 台目标主机`,
        detail: '请减少目标后重试；配置同步按整单原子执行，不会自动拆分。',
      });
      return null;
    }
    const sourceHost = store.getHost(source);
    const orphanedTarget = [sourceHost, ...targets.map((name) => store.getHost(name))]
      .find(isOrphaned);
    if (orphanedTarget) {
      store.addToast({
        level: 'warn',
        summary: `${orphanedTarget.name}：${ORPHANED_ACTION_MESSAGE}`,
      });
      return null;
    }
    let hostMergeGuard = null;
    const res = await guarded({
      action: 'config:sync',
      settleOnResolve: true,
      onError,
      run: () => {
        hostMergeGuard = store.captureHostMergeGuard();
        return api.syncHostConfig({
          source, targets, dryRun, previewToken,
        });
      },
    });
    if (!res || dryRun) return res;

    if (Array.isArray(res.hosts) && hostMergeGuard !== null) {
      store.mergeActionHosts(res.hosts, hostMergeGuard);
    }
    const count = Array.isArray(res.applied) ? res.applied.length : 0;
    const restartTargets = (res.targets ?? [])
      .filter((target) => target.changed && HOST_RESTART_PHASES.has(store.getHost(target.name)?.phase))
      .map((target) => target.name);
    const restartSummary = restartTargets.length > 0
      ? '；运行中目标需重启 dsh web（重启 manager 无效）'
      : '';
    store.addToast({
      level: 'success',
      summary: count > 0 ? `已同步 ${count} 台主机配置${restartSummary}` : '目标配置已一致',
      detail: restartTargets.length > 0
        ? restartTargets.map((name) => `${name}：${HOST_WEB_RESTART_NOTICE}`).join('\n')
        : null,
    });
    return res;
  }

  async function loadDshSettings(name, { onError } = {}) {
    const host = store.getHost(name);
    if (isOrphaned(host)) {
      store.addToast({ level: 'warn', summary: `${name}：${ORPHANED_ACTION_MESSAGE}` });
      return null;
    }
    return guarded({
      action: 'settings:load',
      host: name,
      settleOnResolve: true,
      onError,
      requireWritable: false,
      run: () => api.getDshSettings(name),
    });
  }

  async function saveDshSettings(name, payload, { onError } = {}) {
    const host = store.getHost(name);
    if (isOrphaned(host)) {
      store.addToast({ level: 'warn', summary: `${name}：${ORPHANED_ACTION_MESSAGE}` });
      return null;
    }
    return guarded({
      action: 'settings:save',
      host: name,
      settleOnResolve: true,
      onError,
      run: () => api.saveDshSettings(name, payload),
    });
  }

  async function registerDshWorkspace(name, { onError } = {}) {
    const host = store.getHost(name);
    if (isOrphaned(host)) {
      store.addToast({ level: 'warn', summary: `${name}：${ORPHANED_ACTION_MESSAGE}` });
      return null;
    }
    const res = await guarded({
      action: 'workspace:register',
      host: name,
      settleOnResolve: true,
      onError,
      run: () => api.registerDshWorkspace(name),
    });
    if (res) {
      store.addToast({
        level: 'success',
        summary: res.created
          ? `${name} 已登记启动目录为 dsh Workspace`
          : `${name} 的启动目录已是 dsh Workspace`,
      });
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
      if (res.manager) store.setManagerConfig(res.manager);
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

  async function clearOrphaned() {
    const count = store.listHosts().filter(isOrphaned).length;
    if (count === 0) return null;
    const ok = await confirm({
      title: `清空 ${count} 台 orphaned 主机？`,
      lines: [
        '只会删除 config 中当前 SSH 配置已消失的主机条目，并清理 manager 运行记录。',
        '不会停止或删除远端 dsh web 进程；恢复 SSH 配置后可重新纳管。',
      ],
      confirmLabel: '清空 orphaned',
    });
    if (!ok) return null;
    const res = await guarded({
      action: 'orphaned:clear',
      settleOnResolve: true,
      run: () => api.clearOrphaned(),
    });
    if (!res || !Array.isArray(res.removed)) return res;
    const removed = store.removeHosts(res.removed);
    store.addToast({
      level: 'success',
      summary: removed.length > 0
        ? `已清空 ${removed.length} 台 orphaned 主机`
        : '没有需要清空的 orphaned 主机',
    });
    return res;
  }

  async function restartManager() {
    const ok = await confirm({
      title: '重启 manager？',
      lines: [
        '存活的受管实例会按原 PID 与命令指纹复核接管，只重建隧道或直连登记：远端重建隧道、本机重新登记直连；不会重启这些 dsh web。',
        '只有恢复时探测为 ready 且已启用 autoStart 的主机才会拉起 dsh web；已打开的页面标签会短暂失联。',
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
    if (host.phase === 'ready' && isHostEnabled(host)) void hostAction('start', name);
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
    syncConfig,
    loadDshSettings,
    saveDshSettings,
    registerDshWorkspace,
    saveDefaults,
    reload,
    clearOrphaned,
    restartManager,
    openHost,
    openHostDrawer,
    viewHostInManage,
    loadHostLog,
    reportError,
  };
}
