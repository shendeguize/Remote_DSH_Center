/**
 * 唯一 EventSource 客户端（10 §6 / UI-05、UI-06）。
 *
 * 后端首帧就是 snapshot（13 §3.2），所以不需要 300ms 静默窗口去抖：
 * 收到 snapshot 即视为全量同步完成，resyncing 清零。
 * 不自建重连循环——浏览器原生重连已足够；只在 pageshow / bfcache 恢复时重建。
 */

const FRAME_TYPES = ['snapshot', 'host-changed', 'log-line', 'operation-done', 'config-changed'];

export function createSseClient({ store, url = '/api/events', onSnapshot = null, factory = null }) {
  const make = factory ?? ((u) => new EventSource(u));
  let es = null;
  let closed = false;

  const parse = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      store.addToast({ level: 'warn', summary: 'SSE 帧解析失败（已忽略该帧）', detail: String(raw).slice(0, 400) });
      return null;
    }
  };

  const handlers = {
    snapshot(frame) {
      store.applySnapshot(frame);
      onSnapshot?.(frame);
    },
    'host-changed': (frame) => store.applyHostChanged(frame),
    'log-line': (frame) => store.appendEvent(frame),
    'operation-done': (frame) => {
      const settled = store.settleByOperation(frame.operationId);
      if (frame.status === 'failed') {
        store.addToast({
          level: 'error',
          summary: `${frame.host ?? 'manager'} ${frame.action} 失败：${frame.error ?? '未知原因'}`,
          detail: frame.detail ?? null,
        });
      } else if (settled) {
        store.addToast({ level: 'success', summary: `${frame.host ?? 'manager'} ${frame.action} 完成` });
      }
    },
    'config-changed': (frame) => store.applyConfigChanged(frame),
  };

  function connect() {
    if (closed || es) return;
    store.setConnection({ sse: store.state.connection.everOpened ? 'reconnecting' : 'connecting' });
    es = make(url);

    es.addEventListener('open', () => {
      // 断线恢复也走 snapshot：横幅在 snapshot 到达后才撤，避免露出旧数据
      store.setConnection({ sse: 'open', resyncing: store.state.connection.everOpened });
    });

    es.addEventListener('error', () => {
      // readyState CLOSED 时浏览器已放弃；否则它会自己退避重连
      const dead = es?.readyState === 2;
      store.setConnection({ sse: dead ? 'offline' : 'reconnecting' });
      if (dead) {
        es?.close();
        es = null;
      }
    });

    for (const type of FRAME_TYPES) {
      es.addEventListener(type, (ev) => {
        const frame = parse(ev.data);
        if (!frame) return;
        store.setConnection({ lastEventAt: Date.now() });
        handlers[type](frame);
      });
    }
  }

  function close() {
    closed = true;
    es?.close();
    es = null;
    store.setConnection({ sse: 'offline' });
  }

  /** bfcache 返回时 EventSource 可能已死：只在确实断了才重建，避免多连接。 */
  function revive() {
    closed = false;
    if (es && es.readyState !== 2) return;
    es?.close();
    es = null;
    connect();
  }

  function attachLifecycle(win = window) {
    const onHide = () => {
      es?.close();
      es = null;
      store.setConnection({ sse: 'offline' });
    };
    win.addEventListener('pagehide', onHide);
    win.addEventListener('pageshow', revive);
    return () => {
      win.removeEventListener('pagehide', onHide);
      win.removeEventListener('pageshow', revive);
    };
  }

  return { connect, close, revive, attachLifecycle, get raw() { return es; } };
}

/** 横幅文案（纯函数，便于单测覆盖 10 §3.11 的四种情形）。 */
export function bannerText(connection, { managerRestarting = false } = {}) {
  if (managerRestarting) return 'manager 正在重启，稍后自动重连…';
  const { sse, everOpened, resyncing } = connection;
  if (sse === 'open') return resyncing ? '已重新连上 manager，正在同步状态…' : null;
  if (!everOpened) return sse === 'offline' ? '无法连接 manager，请确认服务已启动' : '正在连接 manager…';
  if (sse === 'offline') return '与 manager 失联且已停止重连；请检查 manager 进程后刷新页面';
  return '与 manager 失联，正在重连；写操作已暂停。';
}
