/**
 * 事件总线 + 事件环形缓冲（11 §1.4）。
 * 事件名与 SSE type 一一对应；host-changed 只传主机名，序列化在发送时刻由 api 完成，
 * 保证客户端拿到的永远是最新视图（天然合并 debounce 窗口内的连续变化）。
 */

import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

const LOG_BUFFER_CAPACITY = 200;

/**
 * 单条日志的字数上限。环形缓冲只按条数限长，不看字节数——「200 条」这个额度对
 * 「每条 8MB」毫无约束：远端打几条巨行（base64 blob、一整坨 JSON、带 traceback 的堆栈）
 * 就能把常驻的 manager 顶上去，实测 20 条 8MB 让堆从 9MB 涨到 176MB。SSE 那边还要
 * 把每条原样推给每个页面、页面再塞进 DOM。
 *
 * msg 本来就只是单行摘要，detail 是排障现场——都不需要无限长。
 */
const LOG_LINE_MAX_CHARS = 2_000;
const LOG_DETAIL_MAX_CHARS = 16_384;

/** 给截断标记用的人话长度。 */
function humanLen(chars) {
  if (chars >= 1_048_576) return `${(chars / 1_048_576).toFixed(1)}MB`;
  if (chars >= 1_024) return `${(chars / 1_024).toFixed(1)}KB`;
  return `${chars} 字`;
}

/** 超长就切开头，并说清原本多长——读的人得知道后面还有东西。 */
function clip(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（已截断，原文 ${humanLen(s.length)}）`;
}

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
  // 先截断再折行：对一条 8MB 的串跑正则本身就是笔开销，而结果反正只留开头
  const entry = {
    host: host ?? null,
    level,
    msg: clip(msg, LOG_LINE_MAX_CHARS).replace(/\s*\n\s*/g, ' ').trim(),
    ts: new Date().toISOString(),
    detail: detail === null || detail === undefined ? null : clip(detail, LOG_DETAIL_MAX_CHARS),
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

export { LOG_BUFFER_CAPACITY, LOG_DETAIL_MAX_CHARS, LOG_LINE_MAX_CHARS };
