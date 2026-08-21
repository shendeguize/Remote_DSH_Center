import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bus,
  emitHostChanged,
  logEvent,
  recentLogs,
  emitConfigChanged,
  emitOperationDone,
  LOG_BUFFER_CAPACITY,
  LOG_DETAIL_MAX_CHARS,
  LOG_LINE_MAX_CHARS,
  _resetForTest,
} from '../../src/lib/bus.js';

test.beforeEach(() => _resetForTest());
test.after(() => _resetForTest());

const silence = (t) => {
  const spy = t.mock.method(console, 'log', () => {});
  const spyW = t.mock.method(console, 'warn', () => {});
  const spyE = t.mock.method(console, 'error', () => {});
  return { spy, spyW, spyE };
};

test('同一微任务内同名 host-changed 只发一次', async () => {
  const seen = [];
  bus.on('host-changed', (h) => seen.push(h));

  emitHostChanged('a');
  emitHostChanged('a');
  emitHostChanged('b');
  emitHostChanged('a');
  assert.deepEqual(seen, [], '批量在微任务末尾 flush');

  await Promise.resolve();
  assert.deepEqual(seen, ['a', 'b']);
});

test('跨微任务批次各自 flush', async () => {
  const seen = [];
  bus.on('host-changed', (h) => seen.push(h));
  emitHostChanged('a');
  await Promise.resolve();
  emitHostChanged('a');
  await Promise.resolve();
  assert.deepEqual(seen, ['a', 'a']);
});

test('logEvent 规整为单行摘要并附时间戳/级别', (t) => {
  silence(t);
  const e = logEvent('gpu-1', 'warn', 'reconnect\n  attempt 3');
  assert.equal(e.msg, 'reconnect attempt 3', '多行摘要压成单行');
  assert.equal(e.host, 'gpu-1');
  assert.equal(e.level, 'warn');
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(e.detail, null);
});

test('logEvent 长文本只进 detail（11 §7.2 原则）', (t) => {
  silence(t);
  const e = logEvent('gpu-1', 'error', '拉起失败', 'line1\nline2\nline3');
  assert.equal(e.msg, '拉起失败');
  assert.equal(e.detail, 'line1\nline2\nline3');
});

test('环形缓冲容量 200，溢出淘汰最旧', (t) => {
  silence(t);
  for (let i = 0; i < LOG_BUFFER_CAPACITY + 25; i += 1) logEvent(null, 'info', `m${i}`);
  const all = recentLogs(1000);
  assert.equal(all.length, LOG_BUFFER_CAPACITY);
  assert.equal(all[0].msg, 'm25');
  assert.equal(all.at(-1).msg, `m${LOG_BUFFER_CAPACITY + 24}`);
});

test('recentLogs 默认 50 条、按时间升序、返回副本', (t) => {
  silence(t);
  for (let i = 0; i < 60; i += 1) logEvent(null, 'info', `m${i}`);
  const recent = recentLogs();
  assert.equal(recent.length, 50);
  assert.equal(recent[0].msg, 'm10');
  recent[0].msg = 'mutated';
  assert.equal(recentLogs()[0].msg, 'm10', '外部改动不应影响缓冲');
});

test('logEvent 同步发 log-line 事件', (t) => {
  silence(t);
  const seen = [];
  bus.on('log-line', (e) => seen.push(e));
  logEvent('gpu-1', 'info', 'started');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].msg, 'started');
});

test('config-changed 与 operation-done 直通', () => {
  const changed = [];
  const ops = [];
  bus.on('config-changed', (c) => changed.push(c));
  bus.on('operation-done', (o) => ops.push(o));

  emitConfigChanged(['defaults.remoteWebPort']);
  emitOperationDone({ operationId: 'x', host: 'gpu-1', action: 'start', status: 'ok' });

  assert.deepEqual(changed, [['defaults.remoteWebPort']]);
  assert.equal(ops[0].operationId, 'x');
});

test('日志级别决定 console 通道（进 manager.log）', (t) => {
  const { spy, spyW, spyE } = silence(t);
  logEvent(null, 'info', 'i');
  logEvent(null, 'warn', 'w');
  logEvent('h', 'error', 'e');
  assert.equal(spy.mock.callCount(), 1);
  assert.equal(spyW.mock.callCount(), 1);
  assert.equal(spyE.mock.callCount(), 1);
  assert.match(spyE.mock.calls[0].arguments[0], /ERROR \[h\] e/);
});

test('单条巨行按字节截断，msg 与 detail 都不许原样留着', (t) => {
  t.mock.method(console, 'log', () => {});
  // 远端打一条 8MB 的行（base64 blob、一整坨 JSON、带 traceback 的堆栈都长这样）。
  // 环形缓冲只按条数限长（200 条），不看字节数——200 × 8MB 在账面上完全合规。
  const huge = 'y'.repeat(8 * 1024 * 1024);
  const entry = logEvent('gpu-1', 'info', huge, huge);

  assert.ok(entry.msg.length <= LOG_LINE_MAX_CHARS + 64, `msg 没截断（${entry.msg.length} 字符）`);
  assert.match(entry.msg, /截断/, '截断处要留个说明，否则读的人不知道后面还有');
  assert.match(entry.msg, /8[.,\d]*\s*MB|8388608/, '说明里要交代原本多长');
  assert.ok(entry.detail.length <= LOG_DETAIL_MAX_CHARS + 64, `detail 没截断（${entry.detail.length} 字符）`);
  assert.equal(entry.msg.startsWith('yyy'), true, '截断要保留开头，不能整条丢掉');
});

test('正常长度的行一个字都不动', (t) => {
  t.mock.method(console, 'log', () => {});
  const msg = '已启动 pid=12345 远端端口=8899 本机端口=17701';
  const detail = 'ssh: 一段几百字的 stderr\n第二行\n第三行';
  const entry = logEvent('gpu-1', 'info', msg, detail);
  assert.equal(entry.msg, msg);
  assert.equal(entry.detail, detail);
});

test('20 条巨行不许把内存顶上去（截断的真实效果）', (t) => {
  t.mock.method(console, 'log', () => {});
  const before = process.memoryUsage().heapUsed;
  const huge = 'y'.repeat(8 * 1024 * 1024);
  for (let i = 0; i < 20; i += 1) logEvent('gpu-1', 'info', huge, huge);
  const grew = (process.memoryUsage().heapUsed - before) / 1e6;
  // 截断前实测：20 条 8MB（共 160MB）让堆从 9MB 涨到 176MB
  assert.ok(grew < 20, `缓冲里留下了 ${Math.round(grew)}MB，说明巨行原样存着`);
});
