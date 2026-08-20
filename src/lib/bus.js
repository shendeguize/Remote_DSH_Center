/**
 * 事件总线 + 事件环形缓冲（11 §1.4）。
 * 事件名与 SSE type 一一对应；host-changed 只传主机名，序列化在发送时刻由 api 完成，
 * 保证客户端拿到的永远是最新视图（天然合并 debounce 窗口内的连续变化）。
 */

import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

const LOG_BUFFER_CAPACITY = 200;

/** @type {{host:string|null, level:'info'|'warn'|'error', msg:string, ts:string, detail:string|null}[]} */
const logBuffer = [];

/** 同一微任务内同名 host-changed 去重（11 §1.4 第 1 点）。 */
let pendingHosts = null;

export function emitHostChanged(name) {
  if (pendingHosts === null) {
    pendingHosts = new Set();
    queueMicrotask(() => {
      const batch = pendingHosts;
      pendingHosts = null;
      for (const host of batch) bus.emit('host-changed', host);
    });
  }
  pendingHosts.add(name);
}

/**
 * 事件面板内容。msg 恒为单行摘要；长文本只进 detail（11 §7.2 原则）。
 * 同时 console 输出一份进 manager.log。
 */
export function logEvent(host, level, msg, detail = null) {
  const entry = {
    host: host ?? null,
    level,
    msg: String(msg).replace(/\s*\n\s*/g, ' ').trim(),
    ts: new Date().toISOString(),
    detail: detail ?? null,
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_CAPACITY) logBuffer.shift();

  const tag = entry.host ? `[${entry.host}]` : '[manager]';
  // 页面只吃单行 msg，但 manager.log 是事后排障的唯一现场——detail（ssh stderr 等）
  // 必须落盘，缩进续行以免和下一条日志混淆。
  const detailLines = entry.detail === null
    ? ''
    : `\n${String(entry.detail).replace(/\n+$/, '').split('\n').map((l) => `    | ${l}`).join('\n')}`;
  const line = `${entry.ts} ${level.toUpperCase()} ${tag} ${entry.msg}${detailLines}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  bus.emit('log-line', entry);
  return entry;
}

/** SSE snapshot 用：最近 n 条，按时间升序。 */
export function recentLogs(n = 50) {
  return logBuffer.slice(-n).map((e) => ({ ...e }));
}

export function emitConfigChanged(changed = []) {
  bus.emit('config-changed', changed);
}

/** 202 长动作结束（13 §3.4）。每个 operationId 有且仅有一条。 */
export function emitOperationDone(payload) {
  bus.emit('operation-done', payload);
}

/** 测试用：清空缓冲与待发批次。 */
export function _resetForTest() {
  logBuffer.length = 0;
  pendingHosts = null;
  bus.removeAllListeners();
}

export { LOG_BUFFER_CAPACITY };
