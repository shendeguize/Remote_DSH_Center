/** 展示层纯函数单测（10 §1.2 / §3.2）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DASH, coalesce, copyText, dshSummary, fmtAgo, fmtClock, fmtDuration, isManaged, mappingSummary, phaseHint,
  phaseMeta, phaseBadge, rowActions, text,
} from '../../src/web/utils.js';
import { allowedHostActions } from '../../src/web/host-rules.js';
import { installDom } from './dom-shim.js';

const PHASES = ['running', 'degraded', 'crashed', 'ready', 'starting', 'no_dsh', 'unreachable', 'unknown'];

test('八态都有中文文案与非纯色标识（无障碍要求）', () => {
  for (const phase of PHASES) {
    const meta = phaseMeta(phase);
    assert.ok(meta.label && meta.label !== phase, `${phase} 需要中文文案`);
    assert.ok(meta.tone && meta.dot, `${phase} 需要 tone/dot`);
  }
  // 后端将来新增 phase 时按原样显示，而不是变成看不懂的「—」
  assert.deepEqual(phaseMeta('weird'), { label: 'weird', tone: 'neutral', dot: 'none' });
  assert.equal(phaseMeta(undefined).label, '—');
});

test('phaseBadge 兼容 phase 字符串与展示 meta', (t) => {
  const dom = installDom();
  t.after(dom.restore);

  const fromPhase = phaseBadge('running');
  assert.equal(fromPhase.dataset.tone, 'running');
  assert.equal(fromPhase.querySelector('.status-dot').dataset.dot, 'solid');
  assert.equal(fromPhase.textContent, '运行中');

  const fromMeta = phaseBadge({ label: '本机不可用', tone: 'neutral', dot: 'none' });
  assert.equal(fromMeta.dataset.tone, 'neutral');
  assert.equal(fromMeta.querySelector('.status-dot').dataset.dot, 'none');
  assert.equal(fromMeta.textContent, '本机不可用');
});

test('phaseHint 呈现缺失原因与挂起原因', () => {
  assert.equal(phaseHint({ phase: 'no_dsh', probe: { noDshReason: 'missing-bin' } }), '远端未安装 dsh');
  assert.equal(
    phaseHint({
      phase: 'no_dsh',
      probe: { noDshReason: 'missing-bin', sniff: { paths: ['/root/.canon/node/bin/dsh'] } },
    }),
    '已检测到 dsh（不在非交互 PATH）',
  );
  assert.equal(phaseHint({ phase: 'no_dsh', probe: { noDshReason: 'no-web-profile' } }), 'dsh 缺 web profile');
  assert.equal(phaseHint({ phase: 'unreachable', probe: { errorSummary: 'Host key verification failed' } }), 'Host key verification failed');
  assert.equal(phaseHint({ phase: 'degraded', tunnel: { suspendedReason: 'forward-disabled' } }), '远端禁止端口转发，已暂停重连');
  assert.equal(phaseHint({ phase: 'degraded', tunnel: { suspendedReason: null, reconnectAttempt: 3 } }), '重连尝试 3');
  assert.equal(phaseHint({ phase: 'running' }), '');
  assert.equal(phaseHint(null), '');
});

test('缺字段一律「—」，不从主机名推断', () => {
  assert.equal(text(null), DASH);
  assert.equal(text(''), DASH);
  assert.equal(text(0), '0');

  const bare = dshSummary({ probe: null });
  assert.equal(bare.line1, DASH);
  assert.equal(bare.line2, '');

  const noVersion = dshSummary({ probe: { dshPath: '/usr/bin/dsh', version: null } });
  assert.equal(noVersion.line1, DASH);
  assert.equal(noVersion.line2, '/usr/bin/dsh');
});

test('映射列只信后端下发的 mappedUrl，不猜端口', () => {
  const running = mappingSummary({
    mappedUrl: 'http://127.0.0.1:17701/',
    tunnel: { localPort: 17701 },
    web: { port: 8899 },
    config: { localPort: 17701 },
  });
  assert.equal(running.url, 'http://127.0.0.1:17701/');
  assert.match(running.line1, /17701/);
  assert.match(running.line2, /8899/);

  const reserved = mappingSummary({ mappedUrl: null, config: { localPort: 17702 } });
  assert.equal(reserved.url, null, '无 mappedUrl 时绝不造 URL');
  assert.match(reserved.line1, /未连接/);

  const never = mappingSummary({ mappedUrl: null, config: { localPort: null } });
  assert.equal(never.line1, DASH);
});

test('手动实例禁 stop/restart（不误杀契约）', () => {
  const manual = { phase: 'running', web: { pid: 111, startedByUs: false } };
  const managed = { phase: 'running', web: { pid: 222, startedByUs: true } };

  assert.equal(isManaged(manual), false);
  assert.equal(isManaged(managed), true);

  assert.deepEqual(rowActions(manual), ['open', 'probe']);
  assert.deepEqual(rowActions(managed), ['open', 'restart', 'stop', 'probe']);
});

test('rowActions 在八态与受管/手动实例上逐项复用共享矩阵', () => {
  const ownerships = [
    ['受管', true],
    ['手动', false],
  ];
  for (const phase of PHASES) {
    for (const [ownership, startedByUs] of ownerships) {
      const host = { phase, web: { startedByUs } };
      assert.deepEqual(
        rowActions(host),
        [...allowedHostActions(host)],
        `${phase}/${ownership} 的行内动作必须与共享矩阵一致`,
      );
    }
  }

  const startingManaged = { phase: 'starting', web: { startedByUs: true } };
  const startingManual = { phase: 'starting', web: { startedByUs: false } };
  assert.deepEqual(rowActions(startingManaged), ['open', 'probe'], '后端不接受 starting stop，行内不得暴露');
  assert.deepEqual(rowActions(startingManual), rowActions(startingManaged), 'starting 不按实例归属分叉');

  const managedDegraded = rowActions({ phase: 'degraded', web: { startedByUs: true } });
  assert.equal(managedDegraded.includes('restart'), true, '受管 degraded 可主动重启');
  const manualDegraded = rowActions({ phase: 'degraded', web: { startedByUs: false } });
  assert.deepEqual(
    manualDegraded,
    ['open', 'reconnect', 'probe'],
    '手动 degraded 可重连，但不能关停或重启进程',
  );

  const crashed = rowActions({ phase: 'crashed', web: { startedByUs: true } });
  assert.equal(crashed.includes('restart'), true, '受管 crashed 应重启');
  assert.equal(crashed.includes('start'), false, '受管 crashed 不应走新拉起');
});

test('时间格式化', () => {
  assert.equal(fmtDuration(5_000), '5秒');
  assert.equal(fmtDuration(65_000), '1分 5秒');
  assert.equal(fmtDuration(3_700_000), '1小时 1分');
  assert.equal(fmtDuration(90_000_000), '1天 1小时');
  assert.equal(fmtDuration(-1), DASH);
  assert.equal(fmtDuration(Number.NaN), DASH);

  assert.equal(fmtClock(null), DASH);
  assert.equal(fmtClock('not-a-date'), DASH);
  assert.match(fmtClock('2026-01-01T10:20:30.000Z'), /\d{1,2}:\d{2}:\d{2}/);

  const now = Date.parse('2026-01-01T00:01:00.000Z');
  assert.equal(fmtAgo('2026-01-01T00:00:00.000Z', now), '1分 0秒前');
  assert.equal(fmtAgo(null), DASH);
});

test('coalesce：同一拍内多次触发只画一次，下一拍还能再画（issue #106）', () => {
  let ran = 0;
  const queue = [];
  const soon = coalesce(() => { ran += 1; }, (cb) => queue.push(cb));

  for (let i = 0; i < 500; i += 1) soon();
  assert.equal(queue.length, 1, '500 次触发只该排一个帧回调');
  assert.equal(ran, 0, '排上了但还没到帧边界');

  queue.shift()();
  assert.equal(ran, 1);

  soon();
  assert.equal(queue.length, 1, '上一拍画完了，新的触发要能再排上（否则从此不再刷新）');
  queue.shift()();
  assert.equal(ran, 2);
});

test('coalesce：没有 rAF 的环境退化成定时器，不至于永不重绘', async () => {
  const saved = globalThis.requestAnimationFrame;
  delete globalThis.requestAnimationFrame;
  try {
    let ran = 0;
    const soon = coalesce(() => { ran += 1; });
    soon();
    soon();
    await new Promise((r) => { setTimeout(r, 60); });
    assert.equal(ran, 1);
  } finally {
    if (saved === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = saved;
  }
});

test('copyText 优先使用 clipboard，成功时不创建临时节点', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const copied = [];
  let fallbackCalls = 0;
  navigator.clipboard.writeText = async (value) => copied.push(value);
  document.execCommand = () => {
    fallbackCalls += 1;
    return true;
  };

  const before = document.body.children.length;
  assert.equal(await copyText('gpu-1 output'), true);
  assert.deepEqual(copied, ['gpu-1 output']);
  assert.equal(fallbackCalls, 0);
  assert.equal(document.body.children.length, before);
  assert.equal(document.body.querySelector('textarea'), null);
});

test('copyText 在 clipboard 抛错或缺失时回退，并始终移除 textarea', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const originalCreateElement = document.createElement.bind(document);
  let selected = 0;
  document.createElement = (tag) => {
    const node = originalCreateElement(tag);
    if (tag === 'textarea') {
      node.select = () => {
        selected += 1;
      };
    }
    return node;
  };

  const cases = [
    {
      label: 'clipboard 拒绝',
      installClipboard() {
        navigator.clipboard = { writeText: async () => { throw new Error('permission denied'); } };
      },
    },
    {
      label: 'clipboard API 缺失',
      installClipboard() {
        delete navigator.clipboard;
      },
    },
  ];

  for (const current of cases) {
    current.installClipboard();
    const before = document.body.children.length;
    let copiedByFallback = null;
    document.execCommand = (command) => {
      const textarea = document.body.querySelector('textarea');
      assert.equal(command, 'copy', current.label);
      assert.ok(textarea, `${current.label} 时复制节点必须已挂进 DOM`);
      assert.equal(textarea.getAttribute('readonly'), '');
      assert.equal(textarea.style.position, 'fixed');
      assert.equal(textarea.style.opacity, '0');
      copiedByFallback = textarea.value;
      return true;
    };

    assert.equal(await copyText(`fallback: ${current.label}`), true, current.label);
    assert.equal(copiedByFallback, `fallback: ${current.label}`);
    assert.equal(document.body.children.length, before, `${current.label} 后不得残留节点`);
    assert.equal(document.body.querySelector('textarea'), null, `${current.label} 后 textarea 必须移除`);
  }
  assert.equal(selected, cases.length, '每次 fallback 都必须选中临时 textarea');
});
