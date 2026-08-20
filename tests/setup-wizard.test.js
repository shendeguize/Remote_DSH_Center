/**
 * 首启引导的双侧共用内核（ENG-17）与 CLI 向导本体（ENG-18）。
 *
 * 这里断言的是「同源同题同判定」：页面向导与 dshc init 走同一份 SETUP_STEPS 与
 * buildConfigFromAnswers，产出的 config 必须能过后端 configSchema——否则向导
 * 写出的东西 manager 自己不认。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SETUP_STEPS,
  buildConfigFromAnswers,
  canAutoStart,
  defaultAnswers,
  getByPath,
  parseIntStrict,
  parseRange,
  previewJson,
  setByPath,
  vPort,
  vRange,
  validateAnswers,
} from '../src/web/setup-schema.js';
import { runSetupWizard } from '../src/cli.js';
import { FACTORY_DEFAULTS, newFactoryConfig } from '../src/defaults.js';
import { configSchema, validate } from '../src/lib/validate.js';

/** 后端 configSchema 的判定，测试里只关心「有没有错、错在哪」。 */
const configErrors = (config) => validate(configSchema, config).errors;

test('四步定义覆盖 01 §2.5：本机服务 / 远端约定 / 主机 / 确认', () => {
  assert.deepEqual(SETUP_STEPS.map((s) => s.id), ['manager', 'remote', 'hosts', 'confirm']);
  assert.equal(SETUP_STEPS[2].kind, 'host-select');
  assert.equal(SETUP_STEPS[3].kind, 'preview');

  const keys = SETUP_STEPS.flatMap((s) => (s.fields ?? []).map((f) => f.key));
  assert.deepEqual(keys, ['manager.port', 'defaults.localPortRange', 'defaults.remoteWebPort']);
});

test('端口与区间解析：多种分隔符都收，非法输入给人话', () => {
  assert.deepEqual(parseIntStrict(' 7788 '), { ok: true, value: 7788 });
  assert.equal(parseIntStrict('77x').ok, false);
  assert.equal(parseIntStrict('').ok, false);

  assert.equal(vPort(0), '端口须为 1–65535 的整数');
  assert.equal(vPort(65_536), '端口须为 1–65535 的整数');
  assert.equal(vPort(7788), null);

  for (const raw of ['17701-17799', '17701 17799', '17701,17799', '17701~17799']) {
    assert.deepEqual(parseRange(raw), { ok: true, value: [17_701, 17_799] }, raw);
  }
  assert.equal(parseRange('17701').ok, false, '只给一个端口不算区间');
  assert.equal(vRange([17_799, 17_701]), '区间终点必须 ≥ 起点');
  assert.equal(vRange([17_701, 17_799]), null);
});

test('defaultAnswers 预填现值；validateAnswers 逐字段定位错误', () => {
  const current = newFactoryConfig();
  const answers = defaultAnswers(current);
  assert.equal(getByPath(answers, 'manager.port'), current.manager.port);
  assert.deepEqual(getByPath(answers, 'defaults.localPortRange'), current.defaults.localPortRange);
  assert.deepEqual(validateAnswers(answers), {}, '出厂默认必须自洽');

  setByPath(answers, 'manager.port', 0);
  setByPath(answers, 'defaults.localPortRange', [200, 100]);
  const errors = validateAnswers(answers);
  assert.deepEqual(Object.keys(errors).sort(), ['defaults.localPortRange', 'manager.port']);
});

test('canAutoStart：只有 ready 能开启链接', () => {
  assert.equal(canAutoStart({ phase: 'ready' }), true);
  for (const phase of ['no_dsh', 'unreachable', 'unknown', 'running']) {
    assert.equal(canAutoStart({ phase }), false, phase);
  }
  assert.equal(canAutoStart(undefined), false, '探测未完成不能自启');
});

test('buildConfigFromAnswers 产出的 config 通过后端 configSchema', () => {
  const answers = defaultAnswers(newFactoryConfig());
  const config = buildConfigFromAnswers(
    answers,
    ['gpu-1', 'gpu-2', 'gpu-3'],
    { 'gpu-1': { phase: 'ready' }, 'gpu-2': { phase: 'no_dsh' } },
    FACTORY_DEFAULTS,
    {
      selection: {
        'gpu-1': { enabled: true, autoStart: true },
        'gpu-2': { enabled: true, autoStart: true },
        'gpu-3': { enabled: false, autoStart: true },
      },
    },
  );

  assert.deepEqual(configErrors(config), [], '向导产物必须直接可落盘');
  assert.equal(config.setupCompleted, true);
  assert.equal(config.hosts['gpu-1'].autoStart, true);
  assert.equal(config.hosts['gpu-2'].autoStart, false, 'no_dsh 不许自启');
  assert.equal(config.hosts['gpu-3'].enabled, false);
  assert.equal(config.hosts['gpu-3'].autoStart, false, '未纳管必然不自启');
  assert.deepEqual(config.hosts['gpu-1'].inject, { env: {}, extraArgs: [], patches: [] });
});

test('previewJson 是 2 空格缩进、可回灌的完整 JSON', () => {
  const config = buildConfigFromAnswers(defaultAnswers(newFactoryConfig()), [], {}, FACTORY_DEFAULTS);
  const text = previewJson(config);
  assert.match(text, /^\{\n  "configVersion"/);
  assert.equal(text.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(text), config);
});

// ── dshc init 的四步问答（ENG-18） ─────────────────────────────────────────

/** 脚本化终端：按序回答，多问一句就报错——防止向导偷偷多问。 */
function scriptedAsk(answers) {
  const queue = [...answers];
  const asked = [];
  return {
    asked,
    ask: async (prompt) => {
      asked.push(prompt);
      if (queue.length === 0) throw new Error(`向导问了预期之外的问题：${prompt}`);
      return queue.shift();
    },
    get left() { return queue.length; },
  };
}

const silent = () => {};

test('一路回车 = 出厂默认 + 全部纳管 + ready 自启', async () => {
  const script = scriptedAsk(['', '', '', '', '', '']);
  const res = await runSetupWizard({
    ask: script.ask,
    print: silent,
    current: newFactoryConfig(),
    sshHosts: ['a-ready', 'b-nodsh'],
    probeHost: async (name) => ({ phase: name === 'a-ready' ? 'ready' : 'no_dsh' }),
  });

  assert.ok(res, '回车确认应视为写入');
  assert.equal(res.config.manager.port, FACTORY_DEFAULTS.manager.port);
  assert.deepEqual(res.config.defaults.localPortRange, FACTORY_DEFAULTS.defaults.localPortRange);
  assert.equal(res.config.hosts['a-ready'].enabled, true);
  assert.equal(res.config.hosts['a-ready'].autoStart, true, 'ready 首次默认开启链接');
  assert.equal(res.config.hosts['b-nodsh'].autoStart, false);
  assert.deepEqual(configErrors(res.config), []);
  assert.equal(script.left, 0, '不该有多余提问');
});

test('非法端口就地重问，不污染答案', async () => {
  const script = scriptedAsk(['abc', '70000', '9001', '', '', '', '', '']);
  const res = await runSetupWizard({
    ask: script.ask,
    print: silent,
    current: newFactoryConfig(),
    sshHosts: [],
  });

  assert.equal(res.config.manager.port, 9001);
  assert.equal(script.asked.filter((p) => p.startsWith('manager 端口')).length, 3, '两次非法各重问一次');
});

test('--force 预填现有值：回车即保持不变', async () => {
  const existing = {
    ...newFactoryConfig(),
    setupCompleted: true,
    manager: { port: 6001 },
    defaults: { remoteWebPort: 9100, localPortRange: [30_000, 30_010] },
  };
  const script = scriptedAsk(['', '', '', '']);
  const res = await runSetupWizard({
    ask: script.ask, print: silent, current: existing, sshHosts: [],
  });

  assert.equal(res.config.manager.port, 6001);
  assert.equal(res.config.defaults.remoteWebPort, 9100);
  assert.deepEqual(res.config.defaults.localPortRange, [30_000, 30_010]);
  assert.match(script.asked[0], /\[6001\]/, '提示里要带现值');
});

test('取消纳管的主机被排除自启候选；ready 也能手动关掉自启', async () => {
  // 问答序：port / range / remotePort / 不纳管 / 不自启 / 确认
  const script = scriptedAsk(['', '', '', '2', '1', '']);
  const res = await runSetupWizard({
    ask: script.ask,
    print: silent,
    current: newFactoryConfig(),
    sshHosts: ['keep', 'drop', 'keep2'],
    probeHost: async () => ({ phase: 'ready' }),
  });

  assert.equal(res.config.hosts.drop.enabled, false);
  assert.equal(res.config.hosts.keep.autoStart, false, '序号 1 被取消自启');
  assert.equal(res.config.hosts.keep2.autoStart, true);
});

test('探测超时的主机仍可纳管，但自启一律关闭', async () => {
  const script = scriptedAsk(['', '', '', '', '']);
  const lines = [];
  const res = await runSetupWizard({
    ask: script.ask,
    print: (l) => lines.push(l ?? ''),
    current: newFactoryConfig(),
    sshHosts: ['slow'],
    // 永不返回：向导必须靠 deadline 自己走下去
    probeHost: () => new Promise(() => {}),
    probeDeadlineMs: 50,
  });

  assert.equal(res.config.hosts.slow.enabled, true);
  assert.equal(res.config.hosts.slow.autoStart, false);
  assert.ok(lines.some((l) => /仍有 1 台探测未完成/.test(l)), '必须显式告知未完成');
});

test('探测抛错记为 unreachable，不中断向导', async () => {
  const script = scriptedAsk(['', '', '', '', '']);
  const res = await runSetupWizard({
    ask: script.ask,
    print: silent,
    current: newFactoryConfig(),
    sshHosts: ['broken'],
    probeHost: async () => { throw new Error('ssh: Host key verification failed'); },
  });

  assert.equal(res.probeResults.broken.phase, 'unreachable');
  assert.equal(res.config.hosts.broken.autoStart, false);
});

test('确认步骤答 n 返回 null（不落盘）', async () => {
  const script = scriptedAsk(['', '', '', 'n']);
  const res = await runSetupWizard({
    ask: script.ask, print: silent, current: newFactoryConfig(), sshHosts: [],
  });
  assert.equal(res, null);
});
