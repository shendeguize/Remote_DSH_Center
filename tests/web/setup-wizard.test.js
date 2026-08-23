/**
 * 页面向导的判定逻辑（UI-22…25 的纯函数部分）。
 * 这些规则是「谁能勾自启」「JSON 手改能不能提交」「要不要迁移端口」的唯一裁决处。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSetupWizard,
  MIGRATION_DELAYS,
  lineOfJsonError,
  migrationTarget,
  nextSelection,
  parsePreview,
  pendingHosts,
  probeProgress,
  stepErrors,
  syncSelectionWithHosts,
} from '../../src/web/components/setup-wizard.js';
import {
  BINDABLE_PORT_MIN,
  PORT_MAX,
  SETUP_STEPS,
  defaultAnswers,
  setByPath,
  vBindableRange,
} from '../../src/web/setup-schema.js';
import { createStore } from '../../src/web/store.js';
import { flush } from './app-harness.js';
import { installDom } from './dom-shim.js';

const current = { manager: { port: 7788 }, defaults: { remoteWebPort: 8899, localPortRange: [17_701, 17_799] } };
const host = (name, phase) => ({ name, phase });

function mountWizardWithFakes(t, hosts = [host('gpu-1', 'ready')]) {
  const dom = installDom();
  const store = createStore({
    manager: {
      info: { port: current.manager.port, setupCompleted: false },
      setupCompleted: false,
    },
    defaults: current.defaults,
  });
  const calls = {
    actionProbeAll: 0,
    apiProbeAll: 0,
    hosts: 0,
    navigate: [],
  };
  const actions = {
    async probeAll() { calls.actionProbeAll += 1; },
    navigate(to) { calls.navigate.push(to); },
    reportError(err, summary) {
      assert.fail(`${summary}: ${err.message}`);
    },
  };
  const api = {
    async hosts() {
      calls.hosts += 1;
      return { revision: 1, hosts };
    },
    async probeAll() {
      calls.apiProbeAll += 1;
    },
    async setup() {
      return {
        ok: true,
        port: current.manager.port,
        portChanged: false,
        restartRequired: false,
        restarting: false,
      };
    },
    async managerInfo() {
      return { port: current.manager.port, setupCompleted: true };
    },
  };
  const wizard = createSetupWizard({
    store,
    actions,
    confirm: async () => true,
    api,
    win: dom.window,
  });
  dom.app.append(wizard.root);
  wizard.open();
  t.after(() => {
    wizard.destroy();
    dom.restore();
  });
  return { wizard, calls };
}

test('第 3 步只经 actions.probeAll 一次，提交精确 navigate 到 #/hub', async (t) => {
  const { wizard, calls } = mountWizardWithFakes(t);
  const primary = (label) => {
    const control = wizard.root.querySelector('.wizard-foot .btn-primary');
    assert.equal(control.textContent, label);
    return control;
  };

  primary('下一步').click();
  primary('下一步').click();
  await flush();
  const steps = wizard.root.querySelectorAll('.stepper .step');
  assert.equal(steps[2].dataset.state, 'current');
  assert.equal(steps[2].getAttribute('aria-current'), 'step');
  assert.equal(calls.hosts, 1);
  assert.equal(calls.actionProbeAll, 1, '全量探测必须穿过 actions 的 pending/error 语义');
  assert.equal(calls.apiProbeAll, 0, 'setup 组件不能绕过 actions 直调 api.probeAll');

  const stepThreeControls = wizard.root.querySelectorAll('.wizard-foot .btn');
  assert.equal(stepThreeControls[0].textContent, '上一步');
  stepThreeControls[0].click();
  primary('下一步').click();
  await flush();
  assert.equal(calls.hosts, 1, '重进第 3 步不重复发现');
  assert.equal(calls.actionProbeAll, 1, '重进第 3 步不重复发起探测');
  assert.equal(calls.apiProbeAll, 0);

  primary('下一步').click();
  primary('完成并保存').click();
  await flush();
  assert.deepEqual(calls.navigate, ['#/hub']);
});

test('stepErrors 只判当前步的字段', () => {
  const answers = defaultAnswers(current);
  setByPath(answers, 'defaults.remoteWebPort', 0); // 第 2 步的错

  assert.deepEqual(stepErrors(answers, SETUP_STEPS[0]), {}, '第 1 步不该替第 2 步报错');
  assert.deepEqual(Object.keys(stepErrors(answers, SETUP_STEPS[1])), ['defaults.remoteWebPort']);

  setByPath(answers, 'defaults.localPortRange', [17_799, 17_701]);
  assert.match(stepErrors(answers, SETUP_STEPS[0])['defaults.localPortRange'], /终点/);
});

test('setup 本机端口区间与 JSON 预览统一使用可绑定范围', () => {
  assert.equal(BINDABLE_PORT_MIN, 1024);
  assert.equal(PORT_MAX, 65_535);
  assert.match(vBindableRange([1023, 17799]), /1024/);
  assert.equal(vBindableRange([1024, 65_535]), null);

  const answers = defaultAnswers(current);
  setByPath(answers, 'defaults.localPortRange', [1023, 17799]);
  assert.match(stepErrors(answers, SETUP_STEPS[0])['defaults.localPortRange'], /1024/);

  const preview = parsePreview(JSON.stringify({
    configVersion: 1,
    setupCompleted: true,
    manager: { port: 1 },
    defaults: { remoteWebPort: 1, localPortRange: [1023, 17799] },
    hosts: {},
  }));
  assert.equal(preview.ok, false);
  assert.match(preview.error, /defaults\.localPortRange.*1024/);
});

test('取消纳管连带取消开启链接', () => {
  let sel = { a: { enabled: true, autoStart: true } };
  sel = nextSelection(sel, 'a', { enabled: false }, host('a', 'ready'));
  assert.deepEqual(sel.a.enabled, false);
  assert.equal(sel.a.autoStart, false, '未纳管不可能自启');
});

test('非 ready 主机勾不上开启链接', () => {
  for (const phase of ['no_dsh', 'unreachable', 'unknown']) {
    const sel = nextSelection({}, 'a', { autoStart: true }, host('a', phase));
    assert.equal(sel.a.autoStart, false, phase);
  }
  assert.equal(nextSelection({}, 'a', { autoStart: true }, host('a', 'ready')).a.autoStart, true);
});

test('探测结果到达：首次 ready 默认开启，手动改过的不被覆盖', () => {
  let sel = syncSelectionWithHosts({}, [host('a', 'unknown'), host('b', 'unknown')]);
  assert.deepEqual(sel.a, { enabled: true, autoStart: false, touchedAutoStart: false }, '未探测默认纳管不自启');

  sel = syncSelectionWithHosts(sel, [host('a', 'ready'), host('b', 'ready')]);
  assert.equal(sel.a.autoStart, true, '首次变 ready 默认开启链接');

  // 用户手动关掉 a 的自启，随后又来一次探测结果
  sel = nextSelection(sel, 'a', { autoStart: false }, host('a', 'ready'));
  sel = syncSelectionWithHosts(sel, [host('a', 'ready'), host('b', 'ready')]);
  assert.equal(sel.a.autoStart, false, '手动决定优先于默认值');
  assert.equal(sel.b.autoStart, true);
});

test('主机掉出 ready 时强制收回自启', () => {
  let sel = syncSelectionWithHosts({}, [host('a', 'ready')]);
  assert.equal(sel.a.autoStart, true);
  sel = syncSelectionWithHosts(sel, [host('a', 'unreachable')]);
  assert.equal(sel.a.autoStart, false);
});

test('进度与未完成清单：只统计纳管中的主机', () => {
  const hosts = [host('a', 'ready'), host('b', 'no_dsh'), host('c', 'unknown'), host('d', 'unknown')];
  assert.deepEqual(probeProgress(hosts), { done: 2, total: 4 });

  const sel = { d: { enabled: false, autoStart: false } };
  assert.deepEqual(pendingHosts(hosts, sel), ['c'], '不纳管的主机不必等它探完');
  assert.deepEqual(probeProgress([]), { done: 0, total: 0 });
});

test('JSON 预览：合法内容原样通过', () => {
  const config = {
    configVersion: 1,
    setupCompleted: true,
    manager: { port: 6001 },
    defaults: { remoteWebPort: 9100, localPortRange: [20_000, 20_010] },
    hosts: { a: { enabled: true, autoStart: false } },
  };
  const res = parsePreview(JSON.stringify(config, null, 2));
  assert.equal(res.ok, true);
  assert.deepEqual(res.config, config, '手改内容必须原样提交，不许前端补字段');
});

test('JSON 预览：语法错误给行号，结构缺失逐条列出', () => {
  const bad = parsePreview('{\n  "configVersion": 1,\n  "manager": {,\n}');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /JSON 语法错误/);
  assert.equal(bad.line, 3, '错误定位到第 3 行');

  const missing = parsePreview(JSON.stringify({ manager: {}, defaults: {}, hosts: [] }));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /configVersion/);
  assert.match(missing.error, /manager\.port/);
  assert.match(missing.error, /localPortRange/);
  assert.match(missing.error, /hosts 必须是对象/);

  assert.equal(parsePreview('[]').error, '顶层必须是 JSON 对象');
  assert.equal(lineOfJsonError('{}', new Error('no position here')), null);
});

test('端口迁移：同端口不迁，改端口按用户提交值拼目标', () => {
  assert.equal(migrationTarget(7788, 'http://127.0.0.1:7788'), null);
  assert.equal(migrationTarget(6001, 'http://127.0.0.1:7788'), 'http://127.0.0.1:6001');
  assert.equal(migrationTarget(6001, 'http://localhost:7788'), 'http://localhost:6001');
  // 默认端口的 origin（无显式端口）也要判对，否则会白跳一次
  assert.equal(migrationTarget(80, 'http://example.test'), null);
  assert.equal(migrationTarget(8080, 'http://example.test'), 'http://example.test:8080');
});

test('迁移探测间隔递增且有上限', () => {
  const delays = [...MIGRATION_DELAYS];
  assert.ok(delays.length >= 5);
  for (let i = 1; i < delays.length; i += 1) assert.ok(delays[i] > delays[i - 1], '必须递增');
  assert.ok(delays.at(-1) <= 10_000, '单次等待别太久，否则重试手感差');
});
