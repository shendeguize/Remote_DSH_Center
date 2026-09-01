#!/usr/bin/env node
/**
 * 真浏览器冒烟（UI-28 的无头可判定部分）。
 *
 * `tests/web/*` 与 `tests/integration/ui-live.test.js` 都跑在 DOM 垫片上，判不了三件事：
 * 真样式表（布局是否横向溢出、减少动效是否真的关掉动画）、真焦点环（Tab/Enter/Esc 的落点）、
 * 真 iframe（跨 origin 会不会被拦）。这里用 Chrome 无头 + CDP 把这些点自动化，
 * 只把「好不好看」留给人眼（清单见 verification/web_ui_checklist.md）。
 *
 *   node scripts/ui-smoke.mjs                 # 全部检查，截图落 .local/tmp/ui-smoke/
 *   node scripts/ui-smoke.mjs --headful       # 想亲眼看的时候
 *   node scripts/ui-smoke.mjs --out /tmp/shots
 *
 * 远端仍是假装置（tests/harness），所以这脚本不碰任何真机，可随时跑。
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { armExitGuard } from './lib/exit-guard.mjs';

import { createHarness, newHostState } from '../tests/harness/index.js';
import { CONFIG_VERSION } from '../src/defaults.js';
import { primaryHosts } from '../src/web/host-rules.js';
import {
  captureScreenshot, findChrome, launchChrome as launchChromeShared, pageSession, sleep,
} from './lib/browser.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// check.mjs 与 tests/tooling.test.js 一直从这里取，保持入口不变
export { findChrome };

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const OUT_DIR = path.resolve(opt('out', path.join(REPO, '.local', 'tmp', 'ui-smoke')));

// ── 结果台账 ─────────────────────────────────────────────────────────────

const results = [];

/**
 * 每个场景开跑前统一清场。
 *
 * 场景之间共用一个页面，任何一条判据中途失败都可能把弹窗、脏草稿、inert 的后景
 * 留在原地，后面的场景于是一片红——追起来像连环 bug，其实只有第一条是真的。
 * 这里只收拾「模态类残留」，不动路由与主机状态：后面的场景确实依赖前面拉起的主机。
 */
let activeCdp = null; // 供 cleanSlate 用；场景函数自己闭包里也有同一个 cdp

async function cleanSlate() {
  const cdp = activeCdp;
  if (!cdp) return;
  try {
    await cdp.eval(`
      // 顺序要紧：确认框是真模态（showModal），它开着的时候外面全是 inert，
      // 对抽屉按钮 click() 根本不生效——先收框，再收抽屉。
      const dlg = document.querySelector('.confirm-dialog');
      if (dlg?.open) [...dlg.querySelectorAll('button')].find((b) => /放弃|取消/.test(b.textContent))?.click();
      const sync = document.querySelector('.config-sync-dialog');
      if (sync?.open) [...sync.querySelectorAll('button')].find((b) => /取消|关闭/.test(b.textContent) && !b.disabled)?.click();
      const d = document.querySelector('.host-drawer');
      if (d && !d.hidden) {
        const cancel = [...d.querySelectorAll('.btn')].find((b) => /放弃修改/.test(b.textContent));
        if (cancel && !cancel.disabled) cancel.click();   // 先把草稿还原，否则关闭又要弹确认
        d.querySelector('.drawer-close')?.click();
      }
      const menu = document.querySelector('.context-menu');
      if (menu && !menu.hidden) menu.hidden = true;
      return true;
    `);
  } catch {
    // 清场本身失败不该顶替真正的失败原因——让场景自己去红
  }
}

/** `--only S12,S4g`：只跑点名的场景（调一条判据时用；全关跑的是全量）。 */
const ONLY = String(opt('only', '')).split(',').map((s) => s.trim()).filter(Boolean);

async function check(id, title, fn) {
  if (ONLY.length > 0 && !ONLY.includes(id)) return;
  const started = Date.now();
  await cleanSlate();
  try {
    const note = await fn();
    results.push({ id, title, ok: true, note: note ?? '' });
    console.log(`  ✔ ${id} ${title}${note ? ` — ${note}` : ''}  (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ id, title, ok: false, note: err.message });
    console.log(`  ✘ ${id} ${title} — ${err.message}`);
  }
}

/** 取自真机配置的命名风格与长度（最长的一台就是这个样子）。 */
const LONG_HOST = 'GPU_Node_jiangyue_mig40-sim_daily-pfs';

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

export function evaluateS12({
  BURST, mut, rows, frames, worstMs,
}) {
  if (mut <= 0) {
    return {
      ok: false,
      note: `页面一次都没重绘（面板 ${rows} 行，收到 ${frames} 帧 log-line）——事件没到，这条判据在空转`,
    };
  }
  if (rows !== 50) return { ok: false, note: `事件行应被环形缓冲顶到 50，实测 ${rows}` };
  if (mut >= 2_000) {
    return {
      ok: false,
      note: `${BURST} 条事件引起 ${mut} 次 DOM 变更——重绘没有合帧（合上应是百位数）`,
    };
  }
  return {
    ok: true,
    note: `${BURST} 条 → ${mut} 次 DOM 变更，最长任务 ${worstMs}ms（仅诊断 / diagnostic）`,
  };
}

/**
 * 只采集某个 DOM 子树本身可观察到的字符串。
 *
 * textContent 看不到动态表单值，也不会穿过 shadow boundary；outerHTML 又看不到通过
 * property 改过但没同步回 attribute 的 value。这里逐层进入可访问的 open shadowRoot，
 * 并故意不读页面全局、网络响应或业务 JS 对象。closed shadow root 按浏览器标准不会从
 * `element.shadowRoot` 暴露，属于自动化无法观察的浏览器边界。
 */
export function snapshotDomObservables(root) {
  if (!root) return { text: '', attributes: [], values: [] };
  const texts = [];
  const attributes = [];
  const values = [];
  const formTags = new Set(['input', 'textarea', 'select']);

  const visit = (scope) => {
    texts.push(String(scope.textContent ?? ''));
    const elements = [
      ...(scope.tagName ? [scope] : []),
      ...(scope.querySelectorAll?.('*') ?? []),
    ];
    for (const element of elements) {
      const tag = String(element.tagName ?? '').toLowerCase();
      for (const attribute of element.attributes ?? []) {
        attributes.push({
          tag,
          name: String(attribute.name ?? ''),
          value: String(attribute.value ?? ''),
        });
      }
      if (formTags.has(tag)) {
        values.push({
          tag,
          type: String(element.type ?? ''),
          value: String(element.value ?? ''),
        });
      }
      // 浏览器只会为 open mode 返回 ShadowRoot；closed mode 在这里是 null，无法越界读取。
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };

  visit(root);
  return { text: texts.join('\n'), attributes, values };
}

/** 回报 secret 出现在 DOM 哪一类可观察面；不扫描快照上的任何额外诊断字段。 */
export function findSecretInDomSnapshot(snapshot, secret) {
  const needle = String(secret ?? '');
  if (!needle) return [];
  const leaks = [];
  if (String(snapshot?.text ?? '').includes(needle)) leaks.push('text');
  for (const attribute of snapshot?.attributes ?? []) {
    if (String(attribute.value ?? '').includes(needle)) {
      leaks.push(`${attribute.tag || 'element'}[${attribute.name || 'attribute'}]`);
    }
  }
  for (const control of snapshot?.values ?? []) {
    if (String(control.value ?? '').includes(needle)) {
      const type = control.type ? `[type=${control.type}]` : '';
      leaks.push(`${control.tag || 'control'}${type}.value`);
    }
  }
  return leaks;
}

async function fixtureTabNames(rig) {
  const res = await rig.api('GET', '/api/hosts');
  return primaryHosts(res.json?.hosts ?? []).map((host) => host.name);
}

// ── 本机 manager（远端换假装置） ─────────────────────────────────────────

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort(base) {
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- 顺序探测
    if (await portFree(base + i)) return base + i;
  }
  throw new Error(`${base} 起的端口段没有空闲`);
}

async function bootManager(hostNames) {
  const hosts = Object.fromEntries(hostNames.map((n) => [n, newHostState()]));
  const harness = createHarness({ hosts });
  const restoreEnv = harness.activate();

  const cfgHosts = {};
  for (const name of hostNames) {
    cfgHosts[name] = {
      enabled: true,
      autoStart: false,
      localPort: null,
      // eslint-disable-next-line no-await-in-loop -- 主机数为个位数
      remoteWebPort: await pickPort(41_000),
      inject: { env: {}, extraArgs: [], patches: [] },
    };
  }
  const localBase = await pickPort(21_000);
  fs.writeFileSync(path.join(harness.homeDir, 'config.json'), `${JSON.stringify({
    configVersion: CONFIG_VERSION,
    setupCompleted: true,
    manager: { port: 7788 },
    defaults: { remoteWebPort: 8899, localPortRange: [localBase, localBase + 40] },
    hosts: cfgHosts,
  }, null, 2)}\n`);

  const server = await import('../src/server.js');
  const booted = await server.main({ portOverride: 0 });
  const base = `http://127.0.0.1:${booted.port}`;

  return {
    base,
    harness,
    api: (method, p, body) => request(base, method, p, body),
    async shutdown() {
      await server._shutdownForTest();
    },
    /** 原端口把 manager 拉回来——断线恢复那半边只有这样才验得到。 */
    async reboot() {
      await server.main({ portOverride: booted.port });
    },
    cleanup() {
      harness.cleanup();
      restoreEnv();
    },
  };
}

function request(base, method, p, body) {
  const url = new URL(p, base);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: payload ? { 'content-type': 'application/json' } : {},
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitHost(rig, name, phases, { timeoutMs = 30_000 } = {}) {
  const want = new Set(Array.isArray(phases) ? phases : [phases]);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- 轮询
    const res = await rig.api('GET', '/api/hosts');
    const host = res.json?.hosts?.find((h) => h.name === name);
    if (host && want.has(host.phase)) return host;
    if (Date.now() > deadline) throw new Error(`${name} 未在期限内进入 ${[...want].join('/')}（当前 ${host?.phase}）`);
    // eslint-disable-next-line no-await-in-loop -- 同上
    await sleep(120);
  }
}

// ── Chrome ───────────────────────────────────────────────────────────────

const launchChrome = () => launchChromeShared({ headful: flag('headful') });

const screenshot = (cdp, name) => captureScreenshot(cdp, OUT_DIR, name);

/** Tab 一路走到底，回报每一跳的落点（用来判焦点是否溜进隐藏区）。 */
const FOCUS_PROBE = `
  const a = document.activeElement;
  if (!a || a === document.body) return { tag: 'body', hidden: false, label: '' };
  let hidden = false;
  for (let n = a; n; n = n.parentElement) if (n.hasAttribute && n.hasAttribute('hidden')) hidden = true;
  return {
    tag: a.tagName.toLowerCase() + (a.className ? '.' + String(a.className).split(' ').join('.') : ''),
    host: a.dataset ? (a.dataset.host ?? '') : '',
    hidden,
    label: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 24),
  };
`;

// ── 主流程 ───────────────────────────────────────────────────────────────

async function main() {
  console.log('启动本机 manager（远端为假装置）…');
  // 第三台故意用真机那种命名风格（37 字符）——短名字撑不出标签栏溢出，
  // 表格与标签栏对长名字的处理也就一直没被测过（issue #25 就是这么漏的）
  const rig = await bootManager(['gpu-1', 'gpu-2', LONG_HOST]);
  console.log(`  manager: ${rig.base}`);

  console.log('启动 Chrome…');
  const chrome = await launchChrome();
  const cdp = await pageSession(chrome);
  activeCdp = cdp;

  const consoleErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(`未捕获异常：${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push(`console.error：${p.args.map((a) => a.value ?? a.description).join(' ')}`);
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') consoleErrors.push(`${p.entry.source}：${p.entry.text}`);
  });
  const responses = [];
  cdp.on('Network.responseReceived', (p) => responses.push({ url: p.response.url, status: p.response.status }));

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('DOM.enable');

  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${rig.base}/` });
    await cdp.waitFor(
      "location.hash === '#/hub' && document.querySelectorAll('.view-hub:not([hidden]) .hub-host-card').length === 3",
      '根路由落到 hub 并渲染主机卡',
    );

    console.log('检查项：');

    await check('S1', '根路由落 hub；首屏无控制台错误、无 4xx/5xx 资源', async () => {
      const landing = await cdp.eval(`
        const visible = (node) => Boolean(node && node.getClientRects().length > 0);
        return {
          hash: location.hash,
          hub: visible(document.querySelector('.view-hub')),
          manage: visible(document.querySelector('.view-dashboard')),
          visibleOps: [...document.querySelectorAll('.probe-all, .reload-config, .config-sync-open')].filter(visible).length,
          toolbarOps: document.querySelectorAll('.manage-header .probe-all, .manage-header .reload-config, .manage-header .config-sync-open').length,
          headerOps: document.querySelectorAll('.app-header .probe-all, .app-header .reload-config, .app-header .config-sync-open').length,
        };
      `);
      assert(landing.hash === '#/hub' && landing.hub && !landing.manage,
        `新浏览器根路由应落 hub，实测 ${landing.hash}（hub=${landing.hub}, manage=${landing.manage}）`);
      assert(landing.visibleOps === 0, `hub 上露出了 ${landing.visibleOps} 个运维写按钮`);
      assert(landing.toolbarOps === 3 && landing.headerOps === 0,
        `探测/重载/同步应只属于 manage toolbar（toolbar=${landing.toolbarOps}, header=${landing.headerOps}）`);
      const bad = responses.filter((r) => r.status >= 400 && r.url.startsWith(rig.base));
      assert(bad.length === 0, `有失败请求：${bad.map((b) => `${b.status} ${b.url}`).join(', ')}`);
      assert(consoleErrors.length === 0, consoleErrors.join(' | '));
      return `${responses.length} 个请求全部 2xx`;
    });

    await check('S2', 'ready 标签按 fixture 常驻；状态不只靠颜色', async () => {
      const expected = await fixtureTabNames(rig);
      const state = await cdp.eval(`
        return {
          badges: [...document.querySelectorAll('.view-hub:not([hidden]) .phase-badge')].map((b) => ({
          tone: b.dataset.tone ?? null,
          text: b.textContent.trim(),
          dot: b.querySelector('.status-dot')?.dataset.dot ?? null,
          color: getComputedStyle(b).color,
          })),
          tabs: [...document.querySelectorAll('.host-tabs .tab')].map((t) => ({
            host: t.dataset.host,
            title: t.title,
            dot: t.querySelector('.status-dot')?.dataset.dot ?? null,
          })),
        };
      `);
      const { badges, tabs } = state;
      assert(badges.length > 0, '页面里没有状态徽章');
      for (const b of badges) {
        assert(b.text.length > 0, `徽章缺文字（tone=${b.tone}）`);
        assert(b.tone, '徽章缺 data-tone');
        assert(b.dot, '徽章缺形状标识 .status-dot[data-dot]');
      }
      assert(JSON.stringify(tabs.map((tab) => tab.host)) === JSON.stringify(expected),
        `常驻标签应按 fixture 为 ${expected.join('/')}，实测 ${tabs.map((tab) => tab.host).join('/')}`);
      for (const tab of tabs) {
        assert(tab.dot === 'hollow' && /可拉起/.test(tab.title),
          `${tab.host} 的 ready 标签缺空心状态或文字（dot=${tab.dot}, title=${tab.title}）`);
      }
      return `${tabs.length} 个 fixture 标签，${badges.length} 个文字+形状徽章`;
    });

    await cdp.send('Page.navigate', { url: `${rig.base}/#/manage` });
    await cdp.waitFor("location.hash === '#/manage' && !document.querySelector('.view-dashboard').hidden", '显式进入管理台');
    for (const width of [1024, 1440]) {
      // eslint-disable-next-line no-await-in-loop -- 逐个宽度
      await check(`S3-${width}`, `${width}px 宽不横向溢出`, async () => {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await sleep(120);
        const box = await cdp.eval(`
          const d = document.documentElement;
          const wide = [...document.querySelectorAll('.view-dashboard *')]
            .filter((e) => e.getBoundingClientRect().right > d.clientWidth + 1)
            .map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]);
          return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, wide: wide.slice(0, 5) };
        `);
        const shot = await screenshot(cdp, `dashboard-${width}`);
        assert(box.scrollWidth <= box.clientWidth + 1,
          `文档宽 ${box.scrollWidth} > 视口 ${box.clientWidth}；越界元素：${box.wide.join(', ')}`);
        return path.relative(REPO, shot);
      });
    }

    await check('S3-420', '窄屏仍是单行薄壳，管理入口常见且主机标签独立横滚', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url: `${rig.base}/#/hub` });
      await cdp.waitFor("location.hash === '#/hub' && !document.querySelector('.view-hub').hidden", '窄屏 hub 到位');
      await sleep(120);
      const layout = await cdp.eval(`
        const shell = document.querySelector('.app-shell');
        const header = document.querySelector('.app-header');
        const tabs = document.querySelector('.host-tabs');
        const manage = document.querySelector('.tab-manage');
        const sr = shell.getBoundingClientRect();
        const hr = header.getBoundingClientRect();
        const tr = tabs.getBoundingClientRect();
        const mr = manage.getBoundingClientRect();
        return {
          shellHeight: Math.round(sr.height),
          sameRow: Math.abs(hr.top - tr.top) <= 8 && Math.abs(hr.bottom - tr.bottom) <= 8,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
          manageVisible: mr.width > 0 && mr.left >= -1 && mr.right <= innerWidth + 1,
          tabs: {
            overflowX: getComputedStyle(tabs).overflowX,
            scroll: tabs.scrollWidth,
            client: tabs.clientWidth,
          },
        };
      `);
      assert(layout.shellHeight <= 52, `app shell 高 ${layout.shellHeight}px，超过薄壳上限 52px`);
      assert(layout.sameRow, '品牌与标签条没有落在同一行');
      assert(layout.documentWidth <= layout.viewportWidth + 1,
        `窄屏文档横溢 ${layout.documentWidth - layout.viewportWidth}px`);
      assert(layout.manageVisible, '窄屏管理入口被挤出视口或隐藏');
      assert(layout.tabs.overflowX === 'auto' && layout.tabs.scroll > layout.tabs.client,
        `host-tabs 没独立横滚（overflow=${layout.tabs.overflowX}, ${layout.tabs.scroll}/${layout.tabs.client}）`);
      return `shell ${layout.shellHeight}px，host-tabs ${layout.tabs.scroll}/${layout.tabs.client}px`;
    });

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${rig.base}/#/manage` });
    await cdp.waitFor("!document.querySelector('.view-dashboard').hidden", '回到管理台');

    await check('S14', '批量同步：真键盘预览/应用、secret 不出 DOM、窄屏不溢出', async () => {
      const config = (await rig.api('GET', '/api/config')).json;
      const originalSource = config.hosts['gpu-1'];
      const originalTarget = config.hosts['gpu-2'];
      const sentinel = 'REAL-BROWSER-SYNC-SECRET';
      const profilePatch = (host) => ({
        remoteWebPort: host.remoteWebPort,
        workdir: host.workdir,
        inject: host.inject,
      });

      try {
        const changedInject = {
          ...originalSource.inject,
          env: { ...originalSource.inject.env, BROWSER_SYNC_SENTINEL: sentinel },
        };
        const sourceUpdate = await rig.api('PUT', '/api/hosts/gpu-1/config', { inject: changedInject });
        assert(sourceUpdate.status === 200, `准备源配置失败：HTTP ${sourceUpdate.status}`);

        await cdp.eval("document.querySelector('.config-sync-open').focus(); return true;");
        await cdp.key('Enter', { code: 'Enter', keyCode: 13 });
        await cdp.waitFor(
          "document.querySelector('.config-sync-dialog')?.open && document.activeElement?.classList.contains('config-sync-source')",
          '同步框打开并聚焦源主机',
        );
        await cdp.eval(`
          const source = document.querySelector('.config-sync-source');
          source.value = 'gpu-1';
          source.dispatchEvent(new Event('change', { bubbles: true }));
          return source.value;
        `);
        const source = await cdp.eval("return document.querySelector('.config-sync-source').value;");
        assert(source === 'gpu-1', `切换源主机失败，实测 ${source}`);

        await cdp.eval("document.querySelector('.config-sync-targets [data-host=\"gpu-2\"]').focus(); return true;");
        await cdp.key(' ', { code: 'Space', keyCode: 32 });
        const checked = await cdp.eval("return document.querySelector('.config-sync-targets [data-host=\"gpu-2\"]').checked;");
        assert(checked, 'Space 没有选中 gpu-2 目标复选框');

        await cdp.eval("document.querySelector('.config-sync-preview').focus(); return true;");
        await cdp.key('Enter', { code: 'Enter', keyCode: 13 });
        await cdp.waitFor(
          "document.querySelector('.config-sync-results') && !document.querySelector('.config-sync-apply').disabled",
          '真实 dry-run 预览完成',
        );
        const preview = await cdp.eval(`
          const dialog = document.querySelector('.config-sync-dialog');
          const snapshot = (${snapshotDomObservables.toString()})(dialog);
          return {
            snapshot,
            active: document.activeElement?.className ?? '',
            summary: dialog.querySelector('.config-sync-change-summary')?.textContent ?? '',
          };
        `);
        assert(/环境变量/.test(preview.summary), `预览未列出环境变量差异：${preview.summary}`);
        const secretLeaks = findSecretInDomSnapshot(preview.snapshot, sentinel);
        assert(secretLeaks.length === 0, `secret 值泄漏到批量同步 DOM：${secretLeaks.join('、')}`);

        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 720, deviceScaleFactor: 1, mobile: false });
        const narrow = await cdp.eval(`
          const dialog = document.querySelector('.config-sync-dialog');
          const rect = dialog.getBoundingClientRect();
          const actions = dialog.querySelector('.config-sync-actions').getBoundingClientRect();
          return {
            left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            viewport: [innerWidth, innerHeight],
            actionTop: actions.top, actionBottom: actions.bottom,
            docWidth: document.documentElement.scrollWidth,
          };
        `);
        assert(narrow.left >= -1 && narrow.right <= narrow.viewport[0] + 1,
          `窄屏 dialog 横向越界：${narrow.left}..${narrow.right}/${narrow.viewport[0]}`);
        assert(narrow.top >= -1 && narrow.bottom <= narrow.viewport[1] + 1,
          `窄屏 dialog 纵向越界：${narrow.top}..${narrow.bottom}/${narrow.viewport[1]}`);
        assert(narrow.actionTop >= narrow.top && narrow.actionBottom <= narrow.bottom + 1,
          '窄屏主要操作区不在 dialog 可视边界内');
        assert(narrow.docWidth <= narrow.viewport[0] + 1,
          `窄屏文档横溢 ${narrow.docWidth - narrow.viewport[0]}px`);
        await screenshot(cdp, 'config-sync-narrow-preview');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

        await cdp.eval("document.querySelector('.config-sync-apply').focus(); return true;");
        await cdp.key('Enter', { code: 'Enter', keyCode: 13 });
        await cdp.waitFor(
          "/同步完成/.test(document.querySelector('.config-sync-status')?.textContent) && document.querySelector('.toast-success')",
          '真实原子应用完成',
        );
        const after = (await rig.api('GET', '/api/config')).json;
        assert(after.hosts['gpu-2'].inject.env.BROWSER_SYNC_SENTINEL === sentinel,
          '应用后目标配置没有持久化 sentinel');
        assert(after.hosts['gpu-2'].enabled === originalTarget.enabled
          && after.hosts['gpu-2'].autoStart === originalTarget.autoStart
          && after.hosts['gpu-2'].localPort === originalTarget.localPort,
        '应用改动了同步边界外字段');
        await screenshot(cdp, 'config-sync-applied');

        await cdp.key('Escape', { code: 'Escape', keyCode: 27 });
        await cdp.waitFor("!document.querySelector('.config-sync-dialog').open", 'Escape 关闭同步框');
        const restoredFocus = await cdp.eval("return document.activeElement?.classList.contains('config-sync-open');");
        assert(restoredFocus, '关闭后焦点没有回到批量同步入口');
        return '键盘链路、原子持久化、secret 边界与 360px 布局均通过';
      } finally {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
        }).catch(() => {});
        await rig.api('PUT', '/api/hosts/gpu-1/config', profilePatch(originalSource)).catch(() => {});
        await rig.api('PUT', '/api/hosts/gpu-2/config', profilePatch(originalTarget)).catch(() => {});
      }
    });

    await check('S4', '键盘链路：Tab 到主机行 → Enter 开抽屉 → Esc 关且焦点归位', async () => {
      await cdp.eval("document.body.focus(); if (document.activeElement !== document.body) document.activeElement.blur(); return true;");
      let row = null;
      for (let i = 0; i < 40 && !row; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- 逐次 Tab
        await cdp.key('Tab', { keyCode: 9 });
        // eslint-disable-next-line no-await-in-loop -- 同上
        const at = await cdp.eval(FOCUS_PROBE);
        if (at.host && at.tag.startsWith('tr')) row = at;
      }
      assert(row, 'Tab 40 次都没落到主机行上（主机行应可聚焦）');

      await cdp.key('Enter', { keyCode: 13 });
      await cdp.waitFor("document.querySelector('.host-drawer') && !document.querySelector('.host-drawer').hidden", 'Enter 打开抽屉');
      const inDrawer = await cdp.eval("return document.querySelector('.host-drawer').contains(document.activeElement);");
      assert(inDrawer, '抽屉打开后焦点应移入抽屉');

      await cdp.key('Escape', { keyCode: 27 });
      await cdp.waitFor("document.querySelector('.host-drawer').hidden", 'Esc 关抽屉');
      const back = await cdp.eval(FOCUS_PROBE);
      assert(back.host === row.host, `Esc 后焦点应回到 ${row.host} 那一行，实际落在 ${back.tag}(${back.host || '无'})`);
      return `落点 ${row.host}`;
    });

    // 抽屉的模态性只有真浏览器能证：inert 是浏览器原生语义，垫片里它只是个属性。
    // 真机上曾经 25 次 Tab 有 17 次落到遮罩后面，且焦点一出抽屉 Esc 就失灵（issue #28）。
    await check('S4b', '抽屉即模态：Tab 出不去，任何焦点位置 Esc 都能关', async () => {
      await cdp.eval("document.querySelector('.host-table tbody tr[data-host]').focus(); return true;");
      await cdp.key('Enter', { keyCode: 13 });
      await cdp.waitFor("!document.querySelector('.host-drawer').hidden", '抽屉打开');

      // 这条判据中途失败会把抽屉留在开着的状态，后景 inert 着，后面的场景全跟着崩。
      // 所以自己收尾：无论成败都把抽屉关掉、把 inert 放开。
      try {
      const scrimBlocks = await cdp.eval("return getComputedStyle(document.querySelector('.drawer-scrim')).pointerEvents !== 'none';");
      assert(scrimBlocks, '遮罩不挡鼠标的话，这条判据的前提就不成立');

      // body 是浏览器把焦点绕出文档再绕回来的折返点，不算「落到遮罩后面」；
      // 真要抓的是后景里那些**可操作控件**。
      const escapees = [];
      for (let i = 0; i < 25; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- 逐次 Tab
        await cdp.key('Tab', { keyCode: 9 });
        // eslint-disable-next-line no-await-in-loop -- 同上
        const at = await cdp.eval(`
          const a = document.activeElement;
          if (!a || a === document.body || a === document.documentElement) return null;
          if (document.querySelector('.host-drawer').contains(a)) return null;
          return a.tagName.toLowerCase() + '.' + String(a.className || '').split(' ')[0];
        `);
        if (at) escapees.push(at);
      }
      assert(escapees.length === 0,
        `25 次 Tab 有 ${escapees.length} 次落到遮罩后面的控件上：${[...new Set(escapees)].join(', ')}`);
      assert(await cdp.eval("return document.querySelector('.host-drawer').getAttribute('aria-modal') === 'true';"),
        '有遮罩就该 aria-modal=true');

      // 焦点挪到抽屉外（inert 之后 Tab 到不了，直接 focus body 模拟）再按 Esc
      await cdp.eval('document.body.focus(); return true;');
      await cdp.key('Escape', { keyCode: 27 });
      await cdp.waitFor("document.querySelector('.host-drawer').hidden", '焦点在外也能 Esc 关掉');
      const restored = await cdp.eval("return document.querySelector('.app-header').inert === false;");
      assert(restored, '关了之后后景没放开 inert，页面从此点不动');
      return 'Tab 逸出 0 次，Esc 在外也灵';
      } finally {
        await cdp.eval("document.querySelector('.host-drawer .drawer-close')?.click(); return true;");
        await sleep(150);
      }
    });

    // 就地校验的时机只有真浏览器能证：blur 不冒泡（第一版把处理器挂在 form 上，
    // 真机里根本收不到），而「碰过之后跟着值走」正是 issue #30 的修复点。
    await check('S4c', '就地校验：打字不吵、离开就报、改对即灭', async () => {
      try {
        await cdp.eval("document.querySelector('.host-table tbody tr[data-host]').click(); return true;");
        await cdp.waitFor("!document.querySelector('.host-drawer').hidden", '抽屉打开');
        const errs = async () => cdp.eval(`
          const d = document.querySelector('.host-drawer');
          return [...d.querySelectorAll('.field-error')].map((n) => n.textContent.trim()).filter(Boolean);
        `);
        const setPort = async (v) => cdp.eval(`
          const n = document.querySelector('.host-drawer input[type="number"]');
          n.focus(); n.value = ${JSON.stringify(v)};
          n.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        `);

        // 打 8080 的路上会先经过 0，这时候报错纯属噪声
        await setPort('0');
        await sleep(120);
        assert((await errs()).length === 0, `还在打字就报错：${(await errs()).join(' / ')}`);

        // 焦点挪走 → 该字段自己报（blur，不冒泡）
        await cdp.eval("document.querySelector('.host-drawer input[type=\"text\"]').focus(); return true;");
        await sleep(180);
        const lit = await errs();
        assert(lit.some((m) => /65535/.test(m)), `离开字段了还不报：${lit.join(' / ') || '（一条都没有）'}`);
        assert(await cdp.eval(`return document.querySelector('.host-drawer input[type="number"]').getAttribute('aria-invalid') === 'true';`),
          'aria-invalid 没置位，读屏用户不知道这里错了');

        // 碰过之后跟着值走：改成合法值立刻灭，不必再离开一次
        await setPort('45999');
        await sleep(150);
        const after = await errs();
        assert(after.length === 0, `改成合法值后红字还挂着：${after.join(' / ')}`);
        assert(await cdp.eval(`return document.querySelector('.host-drawer input[type="number"]').getAttribute('aria-invalid') === 'false';`),
          'aria-invalid 没跟着清');
        return '不吵 / 就报 / 即灭 三步齐';
      } finally {
        await cdp.eval(`
          const d = document.querySelector('.host-drawer');
          const cancel = [...d.querySelectorAll('.btn')].find((b) => /放弃修改/.test(b.textContent));
          if (cancel && !cancel.disabled) cancel.click();  // 还原草稿，否则关闭会弹确认框
          d.querySelector('.drawer-close')?.click();
          return true;
        `);
        await sleep(150);
      }
    });

    // 焦点在重渲染中的存活只有真浏览器能证：垫片里 disabled 元素照样「聚焦」得上，
    // 而真机上 focus() 对它静默失效——issue #32 最后那一段就栽在这儿。
    await check('S4d', '状态更新不把键盘焦点甩掉（含忙碌态的禁用键）', async () => {
      // 主机路由下管理台是 hidden 的，隐藏元素接不了焦点——先回管理台
      await cdp.eval("window.location.hash = '#/manage'; return true;");
      await cdp.waitFor("!document.querySelector('.view-dashboard').hidden", '回到管理台');
      // 从界面上按键触发，才会走「本页自己有在飞的写操作」那条路（pending:changed →
      // 整表重建，且同名控件在忙碌态下变 disabled）。直接打后端 API 压不到它：
      // pending 是页面对自己在飞请求的记账。
      await cdp.eval(`
        const tr = document.querySelector('.host-table tbody tr[data-host]');
        const b = [...tr.querySelectorAll('button')].find((x) => x.dataset.act === 'probe');
        b.focus(); return Boolean(b);
      `);
      const before = await cdp.eval("return document.activeElement?.closest('tr')?.dataset?.host ?? null;");
      assert(before, `前提：焦点没落在主机行上（${await cdp.eval(`
        const a = document.activeElement;
        return 'active=' + (a === document.body ? 'body' : a.tagName.toLowerCase())
          + ' rows=' + document.querySelectorAll('.host-table tbody tr[data-host]').length
          + ' 抽屉还开着=' + !document.querySelector('.host-drawer').hidden;
      `)}）`);

      // 采样要覆盖忙碌窗口本身：只看最终态的话，pending 那条路上丢掉的焦点
      // 会被随后的 host-changed 顺手救回来，判据于是抓不到 renderAll 这一路。
      // 采样放在驱动侧：页面里的 setInterval 会被 Chrome 的后台节流打到 1s 一次，
      // 1.4 秒只能采到 2 个点。
      const trail = [];
      // 用 click()：焦点留在按钮上，同时页面记上一笔在飞的写操作。
      await cdp.eval("document.activeElement.click(); return true;");
      for (let i = 0; i < 14; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- 逐次采样
        trail.push(await cdp.eval(`
          const a = document.activeElement;
          return a === document.body ? 'body' : (a.closest?.('tr')?.dataset.host ?? a.tagName.toLowerCase());
        `));
        // eslint-disable-next-line no-await-in-loop -- 同上
        await sleep(80);
      }
      const strayed = trail.filter((x) => x !== before);
      assert(trail.length > 5, `采样太少（${trail.length}），判据在空转`);
      assert(strayed.length === 0,
        `${trail.length} 次采样里有 ${strayed.length} 次焦点不在 ${before} 行上：${[...new Set(strayed)].join(', ')}`);
      return `${trail.length} 次采样全程守住 ${before} 行`;
    });

    await check('S4e', '行内控件的 Enter/Space 真按得动（不被行吞掉）', async () => {
      await cdp.eval("window.location.hash = '#/manage'; return true;");
      await cdp.waitFor("!document.querySelector('.view-dashboard').hidden", '回到管理台');

      const waitProbeReady = async (named) => {
        const deadline = Date.now() + 25_000;
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- 上一轮探测结束前按钮会保持 disabled
          const state = await cdp.eval(`
            const tr = document.querySelector('.host-table tbody tr[data-host]');
            const b = tr && [...tr.querySelectorAll('button')].find((x) => x.dataset.act === 'probe');
            const connection = document.querySelector('.conn-indicator')?.dataset.state ?? 'missing';
            const writable = connection === 'open' && Boolean(document.querySelector('.disconnect-banner')?.hidden);
            return {
              ready: Boolean(b && !b.disabled && writable),
              button: Boolean(b),
              disabled: b?.disabled ?? null,
              host: tr?.dataset.host ?? null,
              connection,
              writable,
            };
          `);
          if (state.ready) return state;
          if (Date.now() > deadline) {
            throw new Error(`${named}按下前置未收敛：button=${state.button}, disabled=${state.disabled}, `
              + `host=${state.host ?? 'missing'}, connection=${state.connection}, writable=${state.writable}`);
          }
          // eslint-disable-next-line no-await-in-loop -- 等页面 pending 与 SSE 状态按真实条件收敛
          await sleep(50);
        }
      };

      // 原生激活只有真浏览器能验：单测垫片不会因为 Enter 就替按钮生成 click，
      // 「行抢掉了按钮的按键」在那里只能验到一半（行不开抽屉）。
      for (const key of ['Enter', ' ']) {
        const named = key === ' ' ? 'Space' : 'Enter';
        // Enter 发出的上一笔 probe 可能超过固定 400ms；disabled 按钮不会响应下一次 Space。
        // eslint-disable-next-line no-await-in-loop -- 每个按键都须独立等到目标按钮可原生激活
        await waitProbeReady(named);
        // eslint-disable-next-line no-await-in-loop -- 逐个按键
        const focused = await cdp.eval(`
          const tr = document.querySelector('.host-table tbody tr[data-host]');
          const b = [...tr.querySelectorAll('button')].find((x) => x.dataset.act === 'probe');
          if (!b || b.disabled) return false;
          b.focus();
          return document.activeElement === b;
        `);
        assert(focused, `${named}按下前探测按钮未取得焦点`);
        const mark = responses.length;
        // eslint-disable-next-line no-await-in-loop -- 同上
        await cdp.key(key === ' ' ? ' ' : 'Enter', { code: key === ' ' ? 'Space' : 'Enter', keyCode: key === ' ' ? 32 : 13 });
        // eslint-disable-next-line no-await-in-loop -- 同上
        await sleep(400);
        const hit = responses.slice(mark).some((r) => /\/api\/hosts\/[^/]+\/probe$/.test(r.url));
        assert(hit, `按 ${named} 没发出探测请求——行的 keydown 又把控件的原生激活废了`);
        // eslint-disable-next-line no-await-in-loop -- 同上
        const drawerOpen = await cdp.eval("return !document.querySelector('.host-drawer').hidden;");
        assert(!drawerOpen, `按 ${named} 顺手把抽屉开了`);
      }
      return 'Enter 与 Space 都落到按钮自己身上';
    });

    await check('S4f', '按住的那一下不被重建吞掉（鼠标与 Space 都在抬起才激活）', async () => {
      await cdp.eval("window.location.hash = '#/manage'; return true;");
      await cdp.waitFor("!document.querySelector('.view-dashboard').hidden", '回到管理台');

      const pressReadiness = () => cdp.eval(`
        const tr = document.querySelector('.host-table tbody tr[data-host]');
        const b = tr && [...tr.querySelectorAll('button')].find((x) => x.dataset.act === 'probe');
        const connection = document.querySelector('.conn-indicator')?.dataset.state ?? 'missing';
        const writable = connection === 'open' && Boolean(document.querySelector('.disconnect-banner')?.hidden);
        return {
          ready: Boolean(b && !b.disabled && writable),
          button: Boolean(b),
          disabled: b?.disabled ?? null,
          host: tr?.dataset.host ?? null,
          connection,
          writable,
          pending: b ? Boolean(b.disabled && writable) : null,
        };
      `);
      const readinessNote = (state) => [
        `button=${state.button}`,
        `disabled=${state.disabled}`,
        `host=${state.host ?? 'missing'}`,
        `connection=${state.connection}`,
        `writable=${state.writable}`,
        `pending=${state.pending}`,
      ].join(', ');
      const waitPressReady = async (named) => {
        const deadline = Date.now() + 25_000;
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- 等上一笔页面 pending 真正结算
          const state = await pressReadiness();
          if (state.ready) return state;
          if (Date.now() > deadline) {
            throw new Error(`${named}按下前置未收敛：${readinessNote(state)}`);
          }
          // eslint-disable-next-line no-await-in-loop -- 按可写/非 pending 谓词轮询，不用固定等待猜时序
          await sleep(50);
        }
      };

      // 只有真浏览器验得到：垫片里 click 是直接调的，不存在「按下与抬起要是同一个节点」
      // 这回事。这条也是 CI 上 S4e 抽动的根：runner 一慢，一次重建就落进按下与抬起之间。
      for (const how of ['mouse', 'space']) {
        const named = how === 'mouse' ? '鼠标' : 'Space';
        // S4e / 上一轮 probe 可能仍在页面 pending 中；disabled 按钮不会产生原生激活。
        // eslint-disable-next-line no-await-in-loop -- 每轮都须独立等到目标按钮可原生激活
        const ready = await waitPressReady(named);
        // eslint-disable-next-line no-await-in-loop -- 逐条按压
        const box = await cdp.eval(`
          const tr = document.querySelector('.host-table tbody tr[data-host]');
          const b = [...tr.querySelectorAll('button')].find((x) => x.dataset.act === 'probe');
          if (!b || b.disabled) return null;
          b.scrollIntoView({ block: 'center' });
          b.focus();
          const r = b.getBoundingClientRect();
          window.__mut = 0;
          window.__obs?.disconnect();
          window.__obs = new MutationObserver((rs) => { for (const x of rs) window.__mut += x.addedNodes.length + x.removedNodes.length; });
          window.__obs.observe(document.querySelector('.host-table tbody'), { childList: true, subtree: true });
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), host: tr.dataset.host };
        `);
        assert(box, `${named}取按压目标时又失去就绪态：${readinessNote(ready)}`);
        const mark = responses.length;
        // eslint-disable-next-line no-await-in-loop -- 同上
        if (how === 'mouse') await cdp.mouseHalf('down', box.x, box.y);
        // eslint-disable-next-line no-await-in-loop -- 同上
        else await cdp.keyHalf('down', ' ', { code: 'Space', keyCode: 32 });

        // 按住期间制造一次整表重建：另一台主机的状态变化
        // eslint-disable-next-line no-await-in-loop -- 同上
        await rig.api('POST', '/api/hosts/gpu-2/probe');
        // eslint-disable-next-line no-await-in-loop -- 同上
        await sleep(700);
        // eslint-disable-next-line no-await-in-loop -- 同上
        const mutDuring = await cdp.eval('return window.__mut;');
        assert(mutDuring === 0, `按住期间表格动了 ${mutDuring} 个节点——手指底下的节点会被换掉`);

        // eslint-disable-next-line no-await-in-loop -- 同上
        if (how === 'mouse') await cdp.mouseHalf('up', box.x, box.y);
        // eslint-disable-next-line no-await-in-loop -- 同上
        else await cdp.keyHalf('up', ' ', { code: 'Space', keyCode: 32 });
        // eslint-disable-next-line no-await-in-loop -- 同上
        await sleep(600);

        const hit = responses.slice(mark).some((r) => r.url.endsWith(`/api/hosts/${box.host}/probe`));
        assert(hit, `${named}按住期间碰上重建，这一下就没了——请求一个都没发出`);
        // eslint-disable-next-line no-await-in-loop -- 同上
        const mutAfter = await cdp.eval('return window.__mut;');
        assert(mutAfter > 0, `${named}松手之后表格没刷——攒下的更新丢了`);
      }
      return '鼠标与 Space 都不丢，松手后表格追上';
    });

    // 有改动时 Esc 要弹「放弃未保存的修改？」。这条只有真键盘按得出来：`showModal()`
    // 是在这一记 Esc 的处理器里调的，而同一记 Esc 的原生默认动作（CloseWatcher）
    // 紧接着就把刚开的框关掉——用户看到的是「按 Esc 毫无反应」。
    await check('S4g', '有改动时 Esc 弹确认框，且框不会被同一记 Esc 自己关掉', async () => {
      try {
        await cdp.eval("document.querySelector('.host-table tbody tr[data-host]').focus(); return true;");
        await cdp.key('Enter', { keyCode: 13 });
        await cdp.waitFor("!document.querySelector('.host-drawer').hidden", '抽屉打开');
        await cdp.eval(`
          const d = document.querySelector('.host-drawer');
          const input = [...d.querySelectorAll('input')].find((i) => i.type === 'text');
          input.focus();
          input.value = '/tmp/dirty';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        `);
        await cdp.waitFor(`
          [...document.querySelectorAll('.host-drawer .drawer-actions .btn')]
            .some((b) => /放弃修改/.test(b.textContent) && !b.disabled)
        `, '草稿已算脏（放弃修改可点）');

        await cdp.key('Escape', { keyCode: 27 });
        await sleep(250);
        const after = await cdp.eval(`
          const dlg = document.querySelector('.confirm-dialog');
          return {
            dialogOpen: Boolean(dlg?.open),
            drawerOpen: !document.querySelector('.host-drawer').hidden,
            title: dlg?.querySelector('h2')?.textContent ?? '',
          };
        `);
        assert(after.dialogOpen, 'Esc 之后确认框没留住（用户看到的是「按了没反应」）');
        assert(after.drawerOpen, '还没确认就把抽屉关了，等于悄悄丢草稿');
        assert(/放弃/.test(after.title), `确认框标题不对：${after.title}`);

        // 第二记 Esc 是原生 cancel：收框、留抽屉（草稿还在）
        await cdp.key('Escape', { keyCode: 27 });
        await sleep(250);
        const back = await cdp.eval(`
          const dlg = document.querySelector('.confirm-dialog');
          return { dialogOpen: Boolean(dlg?.open), drawerOpen: !document.querySelector('.host-drawer').hidden };
        `);
        assert(!back.dialogOpen, '第二记 Esc 该把确认框收掉');
        assert(back.drawerOpen, '取消了却还是把抽屉关了');
        return 'Esc 弹框、再 Esc 收框，草稿都还在';
      } finally {
        await cdp.eval(`
          const dlg = document.querySelector('.confirm-dialog');
          if (dlg?.open) [...dlg.querySelectorAll('button')].find((b) => /取消/.test(b.textContent))?.click();
          const d = document.querySelector('.host-drawer');
          if (d && !d.hidden) {
            [...d.querySelectorAll('.btn')].find((b) => /放弃修改/.test(b.textContent) && !b.disabled)?.click();
            d.querySelector('.drawer-close')?.click();
          }
          return true;
        `);
        await sleep(200);
      }
    });

    await check('S4h', 'hub 卡片可键盘一步拉起；starting 遮罩与 tab/panel ARIA 配对', async () => {
      await waitHost(rig, 'gpu-1', ['ready']);
      await cdp.send('Page.navigate', { url: `${rig.base}/#/hub` });
      await cdp.waitFor("!document.querySelector('.view-hub').hidden", '进入 hub');
      await cdp.eval("document.activeElement?.blur(); document.body.focus(); return true;");

      let card = null;
      for (let i = 0; i < 30 && !card; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- 逐次 Tab，验证真实焦点链
        await cdp.key('Tab', { keyCode: 9 });
        // eslint-disable-next-line no-await-in-loop -- 同上
        const at = await cdp.eval(FOCUS_PROBE);
        if (at.tag.startsWith('button.hub-host-card') && at.host === 'gpu-1') card = at;
      }
      assert(card?.host, 'Tab 30 次都没落到 gpu-1 的 hub 主机卡');

      await cdp.key('Enter', { code: 'Enter', keyCode: 13 });
      await cdp.waitFor(`
        location.hash === '#/host/' + encodeURIComponent(${JSON.stringify(card.host)})
          && document.querySelector('.host-tabs .tab[data-host="${card.host}"] .dot-starting')
          && !document.querySelector('.iframe-pane[data-host="${card.host}"], .iframe-pane.is-placeholder').hidden
          && /正在启动/.test(document.querySelector('.iframe-overlay:not([hidden])')?.textContent ?? '')
      `, 'ready 卡一步进入 starting 遮罩');

      const starting = await cdp.eval(`
        const tab = document.querySelector('.host-tabs .tab[data-host=${JSON.stringify(card.host)}]');
        const panel = document.querySelector('[role="tabpanel"]:not([hidden])');
        const status = panel?.querySelector('.iframe-overlay:not([hidden])');
        return {
          tabStillPresent: Boolean(tab),
          tabSelected: tab?.getAttribute('aria-selected'),
          tabControls: tab?.getAttribute('aria-controls'),
          panelId: panel?.id,
          panelLabelledBy: panel?.getAttribute('aria-labelledby'),
          panelHidden: panel?.getAttribute('aria-hidden'),
          busy: status?.getAttribute('aria-busy'),
        };
      `);
      assert(starting.tabStillPresent, `${card.host} 从 ready 进 starting 时标签消失了`);
      assert(starting.tabSelected === 'true' && starting.panelHidden === 'false',
        `激活语义不完整（selected=${starting.tabSelected}, hidden=${starting.panelHidden}）`);
      assert(starting.tabControls === starting.panelId && starting.panelLabelledBy,
        `tab/panel 未配对（controls=${starting.tabControls}, panel=${starting.panelId}, labelledby=${starting.panelLabelledBy}）`);
      const expectedTabId = await cdp.eval(
        `return document.querySelector('.host-tabs .tab[data-host=${JSON.stringify(card.host)}]').id;`,
      );
      assert(starting.panelLabelledBy === expectedTabId,
        `panel aria-labelledby=${starting.panelLabelledBy}，应指向 ${expectedTabId}`);
      assert(starting.busy === 'true', `starting status aria-busy=${starting.busy}`);

      await waitHost(rig, card.host, ['running']);
      await cdp.waitFor(
        `document.querySelector('.iframe-pane[data-host=${JSON.stringify(card.host)}] iframe')`,
        '一步拉起后 iframe 就绪',
      );
      return `${card.host}：ready → starting 遮罩 → running`;
    });

    await check('S5', 'Tab 一圈都不进 [hidden] 区域', async () => {
      await cdp.eval("document.activeElement?.blur(); return true;");
      const seen = [];
      for (let i = 0; i < 60; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- 逐次 Tab
        await cdp.key('Tab', { keyCode: 9 });
        // eslint-disable-next-line no-await-in-loop -- 同上
        const at = await cdp.eval(FOCUS_PROBE);
        assert(!at.hidden, `第 ${i + 1} 次 Tab 落进隐藏区域：${at.tag}`);
        seen.push(at.tag);
      }
      return `${new Set(seen).size} 个可聚焦落点`;
    });

    // S6/S6b 验的是菜单键盘链路、焦点与 toast 遮挡，不认领系统剪贴板。真 clipboard
    // 会跨 Chrome profile 争用 macOS pasteboard：一趟被强退留下的 headless Chrome
    // 足以让下一趟卡在 Runtime.evaluate，随后所有 CDP 命令连锁超时。专用页面里把写入
    // 收成本地假动作，既保留产品的 async copy → toast 链路，也不把外部剪贴板混进判据。
    await cdp.eval(`
      if (navigator.clipboard) {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: async () => {},
        });
      }
      return true;
    `);

    await check('S6', '标签页菜单：Shift+F10 开、方向键移动、Esc 收回、选完还焦', async () => {
      const before = await waitHost(rig, 'gpu-1', ['ready', 'running']);
      if (before.phase === 'ready') await rig.api('POST', '/api/hosts/gpu-1/start');
      await waitHost(rig, 'gpu-1', ['running']);
      await cdp.waitFor("document.querySelector('.host-tabs .tab[data-host=\"gpu-1\"]')", '标签栏保留 gpu-1');

      await cdp.eval("document.querySelector('.host-tabs .tab[data-host=\"gpu-1\"]').focus(); return true;");
      await cdp.key('F10', { code: 'F10', keyCode: 121, modifiers: 8 }); // 8 = Shift
      await cdp.waitFor("document.querySelector('.context-menu') && !document.querySelector('.context-menu').hidden", 'Shift+F10 开菜单');
      // 判「焦点确实换了一项」，不能只判「落在某个菜单项上」——开菜单时焦点本就在首项，
      // 那种判据在方向键整套失效时照样绿（issue #41 就是这么漏过去的）。
      const itemNow = () => cdp.eval(`
        const a = document.activeElement;
        return a?.getAttribute('role') === 'menuitem' ? a.textContent.trim() : null;
      `);
      const first = await itemNow();
      assert(first, '开菜单后焦点应落在第一个可用项上');
      await cdp.key('ArrowDown', { keyCode: 40 });
      const second = await itemNow();
      assert(second && second !== first, `ArrowDown 没换项（还停在「${first}」）`);
      await cdp.key('End', { keyCode: 35 });
      const last = await itemNow();
      assert(last && last !== second, `End 没跳到末项（停在「${second}」）`);
      await cdp.key('Home', { keyCode: 36 });
      assert(await itemNow() === first, 'Home 该回到首项');
      await cdp.key('Escape', { keyCode: 27 });
      await cdp.waitFor("!document.querySelector('.context-menu') || document.querySelector('.context-menu').hidden", 'Esc 收回菜单');
      const backOnTab = await cdp.eval("return document.activeElement?.classList.contains('tab') === true;");
      assert(backOnTab, 'Esc 后焦点应回到标签');

      // 选中一项之后也要还焦：菜单一藏，那个按钮就带着焦点消失，人被丢到文档顶端
      await cdp.key('F10', { code: 'F10', keyCode: 121, modifiers: 8 });
      await cdp.waitFor("!document.querySelector('.context-menu').hidden", '再开一次菜单');
      await cdp.eval(`
        [...document.querySelectorAll('.context-menu [role=menuitem]')]
          .find((b) => /复制/.test(b.textContent)).focus();
        return true;
      `);
      await cdp.key('Enter', { code: 'Enter', keyCode: 13 });
      await sleep(300);
      const afterPick = await cdp.eval("return document.activeElement?.classList.contains('tab') === true;");
      assert(afterPick, '选完一项后焦点该回到标签，而不是掉回 body');
      return '开/移/收/还焦 四步齐';
    });

    // 两条一起验：菜单是 position:fixed，越出视口那一截没有滚动可言（issue #67）；
    // 右下角那条还会撞上 toast——被动通知压住亲手唤出的菜单（issue #68）。
    // 所以这里特意先弄出一条 toast 再开菜单，且要求**每一项**都点得到。
    await check('S6b', '右键菜单靠边打开：整块在视口内，且不被 toast 压住', async () => {
      await cdp.waitFor("document.querySelector('.host-tabs .tab')", '标签栏有 running 主机');
      await cdp.eval(`
        const t = document.querySelector('.host-tabs .tab[data-host="gpu-1"]');
        t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 60 }));
        return true;
      `);
      await cdp.waitFor("document.querySelector('.context-menu') && !document.querySelector('.context-menu').hidden", '先开一次菜单取「复制」');
      await cdp.eval(`
        [...document.querySelectorAll('.context-menu button')].find((b) => /复制/.test(b.textContent)).click();
        return true;
      `);
      await cdp.waitFor("document.querySelector('.toast-region').children.length > 0", 'toast 出现（右下角占位）');
      const metrics = await cdp.eval('return { w: innerWidth, h: innerHeight };');
      const corners = [
        ['右边缘', metrics.w - 3, 60],
        ['右下角', metrics.w - 3, metrics.h - 6],
        ['左上角', 2, 2],
      ];
      for (const [where, x, y] of corners) {
        // eslint-disable-next-line no-await-in-loop -- 逐个方位
        await cdp.eval(`
          const t = document.querySelector('.host-tabs .tab[data-host="gpu-1"]');
          t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: ${x}, clientY: ${y} }));
          return true;
        `);
        // eslint-disable-next-line no-await-in-loop -- 同上
        await cdp.waitFor("document.querySelector('.context-menu') && !document.querySelector('.context-menu').hidden", `${where} 开出菜单`);
        // eslint-disable-next-line no-await-in-loop -- 同上
        const box = await cdp.eval(`
          const m = document.querySelector('.context-menu');
          const r = m.getBoundingClientRect();
          const blocked = [...m.querySelectorAll('button')].filter((b) => {
            const lr = b.getBoundingClientRect();
            const cx = lr.left + lr.width / 2;
            const cy = lr.top + lr.height / 2;
            if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return true;
            const top = document.elementFromPoint(cx, cy);
            return !(top && b.contains(top));
          }).map((b) => b.textContent.trim());
          return {
            over: [Math.round(-r.left), Math.round(r.right - innerWidth), Math.round(-r.top), Math.round(r.bottom - innerHeight)],
            blocked,
          };
        `);
        const worst = Math.max(...box.over);
        assert(worst <= 1, `${where} 开的菜单越出视口 ${worst}px（左/右/上/下 = ${box.over.join('/')}）`);
        assert(box.blocked.length === 0, `${where} 开的菜单有点不到的项：${box.blocked.join('、')}`);
        // eslint-disable-next-line no-await-in-loop -- 同上
        await cdp.key('Escape', { keyCode: 27 });
      }
      return `${corners.length} 个方位都在视口内`;
    });

    await check('S7', '真 iframe：跨 origin 加载远端 dsh web 成功', async () => {
      const host = await waitHost(rig, 'gpu-1', ['running']);
      assert(host.mappedUrl, 'running 主机应有 mappedUrl');
      await cdp.eval("window.location.hash = '#/host/gpu-1'; return true;");
      await cdp.waitFor("document.querySelector('.iframe-pane[data-host=\\\"gpu-1\\\"] iframe')", 'iframe 建出来');
      const src = await cdp.eval("return document.querySelector('.iframe-pane[data-host=\"gpu-1\"] iframe').src;");
      assert(src === host.mappedUrl, `iframe src=${src} 应等于后端给的 ${host.mappedUrl}`);

      const deadline = Date.now() + 10_000;
      let hit = null;
      while (!hit && Date.now() < deadline) {
        hit = responses.find((r) => r.url.startsWith(host.mappedUrl) && r.status === 200);
        // eslint-disable-next-line no-await-in-loop -- 等 iframe 的响应
        if (!hit) await sleep(100);
      }
      assert(hit, `没看到 ${host.mappedUrl} 的 200 响应（iframe 可能被拦或隧道未通）`);
      const frames = await cdp.send('Page.getFrameTree');
      const child = (frames.frameTree.childFrames ?? []).find((f) => f.frame.url.startsWith(host.mappedUrl));
      assert(child, '帧树里应有指向映射地址的子帧');
      await screenshot(cdp, 'iframe-running');
      return `${host.mappedUrl} 200`;
    });

    await check('S7b', 'iframe keepalive：切页不换；degraded 不重载；crashed 恢复只重载一次', async () => {
      const host = await waitHost(rig, 'gpu-1', ['running']);
      await cdp.send('Page.navigate', { url: `${rig.base}/#/host/gpu-1` });
      await cdp.waitFor("document.querySelector('.iframe-pane[data-host=\"gpu-1\"] iframe')", 'keepalive 基准 iframe 在位');
      await cdp.eval(`
        const frame = document.querySelector('.iframe-pane[data-host="gpu-1"] iframe');
        window.__keepaliveFrame = frame;
        return true;
      `);
      const rootResponses = () => responses.filter((response) => response.url === host.mappedUrl).length;
      const responseMark = rootResponses();
      assert(responseMark > 0, 'keepalive 前提：没记录到 iframe 文档响应');

      await cdp.eval("window.location.hash = '#/hub'; return true;");
      await cdp.waitFor("!document.querySelector('.view-hub').hidden", '切到 hub');
      await cdp.eval("window.location.hash = '#/host/gpu-1'; return true;");
      await cdp.waitFor("!document.querySelector('.iframe-pane[data-host=\"gpu-1\"]').hidden", '切回 keepalive pane');
      const switched = await cdp.eval(`
        const frame = document.querySelector('.iframe-pane[data-host="gpu-1"] iframe');
        return {
          same: frame === window.__keepaliveFrame,
          src: frame?.src,
        };
      `);
      assert(switched.same && switched.src === host.mappedUrl && rootResponses() === responseMark,
        `切页动了 iframe（same=${switched.same}, src=${switched.src}, 文档响应 ${rootResponses() - responseMark}）`);

      const tunnel = await import('../src/tunnel.js');
      const firstTunnelPid = tunnel._childPid('gpu-1');
      assert(firstTunnelPid, 'degraded 前提：gpu-1 没有隧道子进程');
      process.kill(firstTunnelPid, 'SIGUSR1');
      await cdp.waitFor(`
        !document.querySelector('.iframe-pane[data-host="gpu-1"] .iframe-overlay').hidden
          && /隧道断开/.test(document.querySelector('.iframe-pane[data-host="gpu-1"] .iframe-overlay').textContent)
      `, 'degraded 遮罩出现', { timeoutMs: 8_000 });
      const degraded = await cdp.eval(`
        const frame = document.querySelector('.iframe-pane[data-host="gpu-1"] iframe');
        const tab = document.querySelector('.host-tabs .tab[data-host="gpu-1"]');
        return {
          same: frame === window.__keepaliveFrame,
          tabTone: tab?.querySelector('.status-dot')?.className ?? '',
        };
      `);
      assert(degraded.same && rootResponses() === responseMark,
        `degraded 不该换/重载 iframe（same=${degraded.same}, 文档响应 ${rootResponses() - responseMark}）`);
      assert(/dot-degraded/.test(degraded.tabTone), `degraded 标签状态没跟上：${degraded.tabTone}`);

      await waitHost(rig, 'gpu-1', ['running'], { timeoutMs: 20_000 });
      await cdp.waitFor(
        "document.querySelector('.iframe-pane[data-host=\"gpu-1\"] .iframe-overlay').hidden",
        'degraded 自动恢复',
        { timeoutMs: 20_000 },
      );
      await sleep(300);
      assert(rootResponses() === responseMark, 'degraded → running 触发了 iframe reload');

      rig.harness.crash('gpu-1');
      const secondTunnelPid = tunnel._childPid('gpu-1');
      assert(secondTunnelPid, 'crashed 前提：恢复后没有隧道子进程');
      process.kill(secondTunnelPid, 'SIGUSR1');
      await cdp.waitFor(`
        !document.querySelector('.iframe-pane[data-host="gpu-1"] .iframe-overlay').hidden
          && /已退出/.test(document.querySelector('.iframe-pane[data-host="gpu-1"] .iframe-overlay').textContent)
      `, 'crashed 遮罩出现', { timeoutMs: 20_000 });
      const crashed = await cdp.eval(`
        const frame = document.querySelector('.iframe-pane[data-host="gpu-1"] iframe');
        const tab = document.querySelector('.host-tabs .tab[data-host="gpu-1"]');
        return {
          same: frame === window.__keepaliveFrame,
          tabTone: tab?.querySelector('.status-dot')?.className ?? '',
        };
      `);
      assert(crashed.same && rootResponses() === responseMark,
        `crashed 期间没保住旧文档（same=${crashed.same}, 文档响应 ${rootResponses() - responseMark}）`);
      assert(/dot-crashed/.test(crashed.tabTone), `crashed 标签状态没跟上：${crashed.tabTone}`);

      const restart = await rig.api('POST', '/api/hosts/gpu-1/start');
      assert(restart.status === 202, `crashed 重启返回 ${restart.status}`);
      await waitHost(rig, 'gpu-1', ['running'], { timeoutMs: 20_000 });
      const reloadDeadline = Date.now() + 10_000;
      while (rootResponses() === responseMark && Date.now() < reloadDeadline) {
        // eslint-disable-next-line no-await-in-loop -- 等真实 iframe 文档响应
        await sleep(100);
      }
      await sleep(500);
      const reloads = rootResponses() - responseMark;
      assert(reloads === 1, `crashed 恢复应只加载一次 iframe 文档，实测 ${reloads}`);
      return '切页 0 / degraded 0 / crashed 恢复 1 次 reload';
    });

    // S7 走的是「页内改 hash」——真机 v0.2.0-rc.3 上出问题的偏偏是另一条：
    // 首屏就带着 host 路由（书签 / 刷新 / dshc open <host>）。那时主机集合还没到，
    // 曾被当成「标签已消失」直接改写回 #/，深链于是永远落在管理台（issue #15）。
    await check('S10', '深链冷启动：直接开 #/host/… 能落在主机页', async () => {
      const host = await waitHost(rig, 'gpu-1', ['running']);
      assert(host.mappedUrl, '前置条件：gpu-1 应仍在 running');

      // 全新导航（不是改 hash），逼出「首屏即 host 路由」的时序
      await cdp.send('Page.navigate', { url: `${rig.base}/#/host/gpu-1` });
      await cdp.waitFor("document.querySelector('.iframe-pane[data-host=\\\"gpu-1\\\"] iframe')", '深链把 iframe 建出来');
      const landed = await cdp.eval(`
        return {
          hash: location.hash,
          dashboardHidden: document.querySelector('.view-dashboard')?.hidden ?? null,
          src: document.querySelector('.iframe-pane[data-host="gpu-1"] iframe')?.src ?? null,
        };
      `);
      assert(landed.hash === '#/host/gpu-1', `地址被改写成 ${landed.hash}`);
      assert(landed.dashboardHidden === true, '落在了管理台');
      assert(landed.src === host.mappedUrl, `iframe src=${landed.src} 应等于 ${host.mappedUrl}`);

      // 再按一次刷新：同一条时序，用户最容易碰到的就是这个动作
      await cdp.send('Page.reload', {});
      await cdp.waitFor("document.querySelector('.iframe-pane[data-host=\\\"gpu-1\\\"] iframe')", '刷新后仍在主机页');
      const afterReload = await cdp.eval('return location.hash;');
      assert(afterReload === '#/host/gpu-1', `刷新后地址变成 ${afterReload}`);

      // 访问过的可开主机已记为 lastHost；根路由应恢复它，而不是退回管理台/hub。
      await cdp.send('Page.navigate', { url: `${rig.base}/#/` });
      await cdp.waitFor(
        "location.hash === '#/host/gpu-1' && document.querySelector('.iframe-pane[data-host=\"gpu-1\"] iframe')",
        '根路由恢复 lastHost',
      );
      await screenshot(cdp, 'deeplink-cold-boot');
      return '深链冷启动、刷新与根路由恢复都落在主机页';
    });

    // 真机上是 8 台主机 + 37 字符长名把标签栏撑到 2058px（可视 1024px），激活标签
    // 停在可视区外，看起来像一个都没选中（issue #25）。假装置只有三台主机，
    // 把视口收窄到 420px 等价复现，且不用为此多起几台主机。
    await check('S11', '标签栏溢出时激活标签仍在可视区内', async () => {
      await rig.api('POST', `/api/hosts/${encodeURIComponent(LONG_HOST)}/start`);
      await waitHost(rig, LONG_HOST, ['running']);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url: `${rig.base}/#/hub` });
      const expectedTabs = await fixtureTabNames(rig);
      await cdp.waitFor(
        `document.querySelectorAll('.host-tabs .tab').length === ${expectedTabs.length}`,
        '标签数量收敛到 fixture 实际可用态',
      );
      const actualTabs = await cdp.eval(
        "return [...document.querySelectorAll('.host-tabs .tab')].map((tab) => tab.dataset.host);",
      );
      assert(JSON.stringify(actualTabs) === JSON.stringify(expectedTabs),
        `标签应按 fixture 为 ${expectedTabs.join('/')}，实测 ${actualTabs.join('/')}`);

      const overflowing = await cdp.eval(`
        const bar = document.querySelector('.host-tabs');
        return { scroll: bar.scrollWidth, client: bar.clientWidth, overflowX: getComputedStyle(bar).overflowX };
      `);
      assert(overflowing.overflowX === 'auto', `标签栏 overflow-x=${overflowing.overflowX}，溢出就滚不动了`);
      assert(overflowing.scroll > overflowing.client,
        `420px 下标签栏没撑出溢出（${overflowing.scroll}/${overflowing.client}），判据在空转`);

      // 挑排在最后的那个标签——只有它才需要真的滚一段才看得见
      const target = await cdp.eval(`
        const tabs = [...document.querySelectorAll('.host-tabs .tab')];
        const last = tabs[tabs.length - 1];
        const bar = document.querySelector('.host-tabs');
        return {
          host: last.dataset.host,
          // 不滚的话它够不够得着（offsetLeft 是内容坐标，与 scrollLeft 无关）
          needsScroll: last.offsetLeft + last.offsetWidth > bar.clientWidth + 1,
        };
      `);
      assert(target.needsScroll,
        `最后那个标签不滚也看得见，S11 在空转（视口 420px 撑得下 ${target.host}）`);

      await cdp.eval(`window.location.hash = '#/host/' + encodeURIComponent(${JSON.stringify(target.host)}); return true;`);
      await cdp.waitFor(`document.querySelector('.host-tabs .tab.is-active')?.dataset.host === ${JSON.stringify(target.host)}`, '激活标签就位');
      await sleep(200);
      const at = await cdp.eval(`
        const bar = document.querySelector('.host-tabs');
        const t = document.querySelector('.host-tabs .tab.is-active');
        const bb = bar.getBoundingClientRect(); const tb = t.getBoundingClientRect();
        return {
          scrollLeft: Math.round(bar.scrollLeft),
          visible: tb.left >= bb.left - 1 && tb.right <= bb.right + 1,
          tab: [Math.round(tb.left), Math.round(tb.right)], bar: [Math.round(bb.left), Math.round(bb.right)],
        };
      `);
      assert(at.scrollLeft > 0, `标签栏没滚（scrollLeft=0），激活标签只能靠运气露出来`);
      assert(at.visible, `激活标签在可视区外：tab ${at.tab.join('–')} vs 可视 ${at.bar.join('–')}`);
      await screenshot(cdp, 'tabbar-overflow');
      await rig.api('POST', `/api/hosts/${encodeURIComponent(LONG_HOST)}/stop`);
      return `滚到 ${at.scrollLeft}px，激活标签在视野内`;
    });

    // 回管理台与 1440 宽，别把后面的场景留在 iframe 页 / 窄视口上
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${rig.base}/#/manage` });
    await cdp.waitFor("document.querySelector('.host-table tbody tr[data-host]')", '回到管理台');

    await check('S8', '减少动效：动画真的关掉', async () => {
      const probe = `
        const s = document.createElement('span');
        s.className = 'status-dot';
        s.dataset.dot = 'pulse';
        document.body.append(s);
        const name = getComputedStyle(s).animationName;
        s.remove();
        return name;
      `;
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      const normal = await cdp.eval(probe);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      const reduced = await cdp.eval(probe);
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      assert(normal !== 'none', `常态下 pulse 点本应有动画，实测 ${normal}`);
      assert(reduced === 'none', `reduce 下动画应为 none，实测 ${reduced}`);
      return `${normal} → none`;
    });

    await check('S9', 'manager 掉线：返回导航仍可用，写按钮禁用；期间不堆连接', async () => {
      await cdp.send('Page.navigate', { url: `${rig.base}/#/manage` });
      await cdp.waitFor("!document.querySelector('.view-dashboard').hidden", '断线前显式进入管理台');
      const before = responses.filter((r) => r.url.endsWith('/api/events')).length;
      // 掐线前先按下一次写操作，让断线发生在「有动作在飞」的真实时刻，
      // 而不是页面闲着的时候（判据不靠它，见 S9b 的说明）。
      await cdp.eval(`
        const tr = document.querySelector('.host-table tbody tr[data-host]');
        [...tr.querySelectorAll('button')].find((b) => b.dataset.act === 'start')?.click();
        return true;
      `);
      await sleep(300);
      await rig.shutdown();
      await cdp.waitFor("!document.querySelector('.disconnect-banner').hidden", '断线横幅出现', { timeoutMs: 20_000 });
      const state = await cdp.eval(`
        const row = document.querySelector('.host-table tbody tr[data-host]');
        const manageBack = document.querySelector('.manage-back');
        return {
          banner: document.querySelector('.disconnect-banner').textContent.trim(),
          navigationEnabled: Boolean(manageBack && !manageBack.disabled),
          toolbarWrites: [...document.querySelectorAll('.manage-header .probe-all, .manage-header .reload-config, .manage-header .config-sync-open')]
            .map((button) => [button.textContent.trim(), button.disabled]),
          rowWritable: [...row.querySelectorAll('.row-actions .btn')].some((b) => !b.disabled && b.textContent !== '打开'),
        };
      `);
      assert(/失联/.test(state.banner), `横幅文案不含「失联」：${state.banner}`);
      assert(state.navigationEnabled, '断线后「返回主页面」导航被禁用或缺失');
      assert(state.toolbarWrites.length === 3 && state.toolbarWrites.every(([, disabled]) => disabled),
        `断线后 manage 页头写按钮未全部禁用：${JSON.stringify(state.toolbarWrites)}`);
      assert(!state.rowWritable, '断线后行内写按钮仍可点');
      await sleep(3_000);
      const after = responses.filter((r) => r.url.endsWith('/api/events')).length;
      assert(after - before <= 4, `3s 内 /api/events 新增 ${after - before} 次，疑似自建重连风暴`);
      await screenshot(cdp, 'offline-banner');
      return `「${state.banner}」`;
    });

    await check('S9b', 'manager 回来：返回导航仍可用、横幅消失、写操作解禁、快照回灌', async () => {
      // 这条只守「恢复」这条路本身通不通（此前从没在真浏览器里跑过）。
      // 「重连后按快照结算在飞的写操作」由 tests/web/store.test.js 守：那半边在这里
      // 判不出来——重连后紧跟着的 host-changed 帧同样会把 pending 结算掉，
      // 摘掉修复它也绿。判不出来的东西就别在标题里认领。
      await rig.reboot();
      await cdp.waitFor("document.querySelector('.disconnect-banner').hidden", '横幅消失', { timeoutMs: 30_000 });
      await cdp.waitFor(`
        (() => {
          const row = document.querySelector('.host-table tbody tr[data-host]');
          return Boolean(row && [...row.querySelectorAll('.row-actions .btn')]
            .some((button) => !button.disabled && button.textContent !== '打开'));
        })()
      `, '恢复后行内写按钮解禁', { timeoutMs: 30_000 });
      const back = await cdp.eval(`
        const row = document.querySelector('.host-table tbody tr[data-host]');
        const manageBack = document.querySelector('.manage-back');
        return {
          navigationEnabled: Boolean(manageBack && !manageBack.disabled),
          toolbarWrites: [...document.querySelectorAll('.manage-header .probe-all, .manage-header .reload-config, .manage-header .config-sync-open')]
            .map((button) => [button.textContent.trim(), button.disabled]),
          rowWritable: [...row.querySelectorAll('.row-actions .btn')].some((b) => !b.disabled && b.textContent !== '打开'),
          rows: document.querySelectorAll('.host-table tbody tr[data-host]').length,
        };
      `);
      assert(back.navigationEnabled, '恢复后「返回主页面」导航被禁用或缺失');
      assert(back.toolbarWrites.length === 3 && back.toolbarWrites.every(([, disabled]) => !disabled),
        `恢复后 manage 页头写按钮未全部解禁：${JSON.stringify(back.toolbarWrites)}`);
      assert(back.rowWritable, '恢复后行内写按钮还禁着');
      assert(back.rows >= 1, `恢复后表里只有 ${back.rows} 行，快照没回灌`);
      return '横幅消失且写操作恢复';
    });

    await check('S13', '标签栏方向键：左右环绕移焦点、Enter 才切页（issue #110）', async () => {
      // 只有真浏览器验得到两件事：原生按键真派到焦点元素上（垫片是手写 dispatch），
      // 以及 <button> 上的 Enter 会不会自己变成 click（垫片不模拟原生激活）。
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      // 单独跑（--only S13）时前面那些场景没起过主机，自己把两台拉起来；已经在跑的
      // 那台再 start 一次会被拒，那是意料之中，等它 running 即可
      for (const name of ['gpu-1', 'gpu-2']) {
        // eslint-disable-next-line no-await-in-loop -- 逐台拉起
        await rig.api('POST', `/api/hosts/${name}/start`).catch(() => {});
        // eslint-disable-next-line no-await-in-loop -- 同上
        await waitHost(rig, name, ['running']);
      }
      await cdp.send('Page.navigate', { url: `${rig.base}/#/hub` });
      const expectedNames = await fixtureTabNames(rig);
      await cdp.waitFor(
        `document.querySelectorAll('.host-tabs .tab').length === ${expectedNames.length}`,
        '标签栏数量收敛到 fixture 实际可用态',
      );

      const names = await cdp.eval("return [...document.querySelectorAll('.host-tabs .tab')].map((t) => t.dataset.host);");
      assert(JSON.stringify(names) === JSON.stringify(expectedNames),
        `标签应按 fixture 为 ${expectedNames.join('/')}，实测 ${names.join('/')}`);
      assert(names.length >= 2, `fixture 只有 ${names.length} 个标签，方向键判据在空转`);
      const focused = () => cdp.eval("return document.activeElement?.dataset?.host ?? '';");
      const stops = () => cdp.eval("return [...document.querySelectorAll('.host-tabs .tab')].filter((t) => t.getAttribute('tabindex') !== '-1').length;");

      assert(await stops() === 1, `标签栏占了 ${await stops()} 个 Tab 落点——roving tabindex 没生效`);
      await cdp.eval("document.querySelector('.host-tabs .tab').focus(); return true;");
      await cdp.key('ArrowRight', { code: 'ArrowRight', keyCode: 39 });
      await sleep(120);
      assert(await focused() === names[1], `ArrowRight 后焦点在「${await focused()}」，该在 ${names[1]}`);
      const routeAfterArrow = await cdp.eval('return location.hash;');
      assert(!routeAfterArrow.startsWith('#/host/'),
        `方向键顺手切页了（${routeAfterArrow}）——手动激活才不会一路划过去拉起一串 iframe`);

      for (let i = 1; i < names.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- 逐个标签走到末尾并环绕
        await cdp.key('ArrowRight', { code: 'ArrowRight', keyCode: 39 });
        // eslint-disable-next-line no-await-in-loop -- 同上
        await sleep(120);
        // eslint-disable-next-line no-await-in-loop -- 同上
        assert(await focused() === names[(i + 1) % names.length],
          `第 ${i + 1} 次 ArrowRight 应到 ${names[(i + 1) % names.length]}，实测「${await focused()}」`);
      }
      assert(await focused() === names[0], `走到末尾该环绕回 ${names[0]}，实测「${await focused()}」`);
      await cdp.key('End', { code: 'End', keyCode: 35 });
      await sleep(120);
      const last = names[names.length - 1];
      assert(await focused() === last, `End 该跳到 ${last}，实测「${await focused()}」`);

      await cdp.key('Enter', { code: 'Enter', keyCode: 13 });
      await cdp.waitFor(`location.hash === '#/host/' + encodeURIComponent(${JSON.stringify(last)})`, 'Enter 激活焦点标签');
      assert(await stops() === 1, '切页后 Tab 落点又散开了');
      await rig.api('POST', '/api/hosts/gpu-2/stop');
      return `${names.length} 个标签：方向键环绕、Enter 落在 ${last}`;
    });

    await check('S12', '事件风暴不冻住页面：重绘合到帧边界（issue #106）', async () => {
      // 修复前：1500 条事件 → 14.8 万次 DOM 变更、一个 2278ms 的长任务，那 2.3 秒里
      // 页面点不动。issue #116 证明共享 runner 的 Long Task 会受机器负载影响；判据只取
      // 事件到达、行数与「变更批次」这些主信号，Long Task 仅作诊断。
      const BURST = 1500;
      await cdp.send('Page.navigate', { url: `${rig.base}/#/manage` });
      await cdp.waitFor("!document.querySelector('.view-dashboard').hidden", '事件风暴前显式进入管理台');
      await cdp.waitFor("document.querySelector('.event-list')", '事件面板在位');
      // 合帧靠 rAF，而 rAF 只在页面可见时才跑。跑到这里时这一页往往已经是 hidden
      // （前面开过 iframe、换过视口），那样一帧都不会来，判据就成了空转。
      await cdp.send('Page.bringToFront');
      const frameAlive = await cdp.eval(`
        return new Promise((r) => {
          const t = setTimeout(() => r(0), 1_000);
          requestAnimationFrame(() => { clearTimeout(t); r(1); });
        });
      `);
      assert(frameAlive === 1, '页面拿不到帧（hidden），这条判据没法验合帧');
      // 前面的场景（Tab 巡游 + 方向键）可能把主机过滤拨到了别的主机，那样这里灌的
      // 事件会被整条滤掉，判据就成了空转。先归零，别继承上游的 UI 状态。
      await cdp.eval(`
        const f = document.querySelector('.event-filter');
        f.value = '';
        f.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      `);
      await cdp.eval(`
        window.__storm = { long: [], mut: 0 };
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__storm.long.push(Math.round(e.duration));
        }).observe({ entryTypes: ['longtask'] });
        new MutationObserver((ms) => { window.__storm.mut += ms.length; })
          .observe(document.querySelector('.event-list'), { childList: true });
        return true;
      `);

      let frames = 0;
      cdp.on('Network.eventSourceMessageReceived', (p) => { if (p.eventName === 'log-line') frames += 1; });
      const { logEvent } = await import('../src/lib/bus.js');
      // 这一程本来就是要把日志灌爆，别把 1500 行噪音倒进检查输出里
      const real = { log: console.log, warn: console.warn, error: console.error };
      Object.assign(console, { log() {}, warn() {}, error() {} });
      try {
        for (let i = 0; i < BURST; i += 1) {
          logEvent('gpu-1', 'info', `风暴第 ${i} 条：远端回读 CWD=/data/work/run-${i}`);
        }
      } finally {
        Object.assign(console, real);
      }
      await sleep(3_000);


      const storm = await cdp.eval('return window.__storm;');
      const rows = await cdp.eval("return document.querySelectorAll('.event-item').length;");
      const worst = Math.max(0, ...storm.long);
      const verdict = evaluateS12({
        BURST, mut: storm.mut, rows, frames, worstMs: worst,
      });
      assert(verdict.ok, verdict.note);
      return verdict.note;
    });

    await check('S15', '六个手动实例：拉起先让人挑领养谁，选中的那一个才被登记', async () => {
      // 垫片验得了「选项渲染出来」，验不了六行候选在 460px 模态里还看得清、按得动，
      // 也验不了原生 radio 的 change 真派到组里（真机上是六个候选，见 issue 附图）
      const host = 'gpu-2';
      // 前面的场景改过视口（S3-420 / S13 清覆盖），六行候选放不放得下是视口相关判据，
      // 自己钉一个普通桌面尺寸，别让上一条场景的残留决定结论
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      });
      const launcher = await import('../src/launcher.js');
      launcher._setWait((ms) => new Promise((r) => { setTimeout(r, Math.min(ms, 60)); }));
      const phaseOf = async () => (await rig.api('GET', '/api/hosts')).json.hosts.find((h) => h.name === host);
      if (['running', 'degraded', 'starting'].includes((await phaseOf()).phase)) {
        await rig.api('POST', `/api/hosts/${host}/stop`);
        await waitHost(rig, host, ['ready', 'crashed']);
      }

      const manual = [];
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- 逐个占端口再拉起
        const port = await pickPort(43_000);
        // eslint-disable-next-line no-await-in-loop -- 同上；manager 不知情，正是「手动实例」
        const res = await launcher.runLaunchSequence(host, { port });
        manual.push({ pid: res.pid, port: res.actualPort });
      }
      await rig.api('POST', `/api/hosts/${host}/probe`);
      for (let i = 0; i < 120; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- 等探测把手动实例并进 HostView
        if (((await phaseOf()).manualInstances ?? []).length === manual.length) break;
        // eslint-disable-next-line no-await-in-loop -- 同上
        await sleep(120);
      }
      assert(((await phaseOf()).manualInstances ?? []).length === 6,
        `探测只认出 ${((await phaseOf()).manualInstances ?? []).length} 个手动实例`);

      await cdp.send('Page.navigate', { url: `${rig.base}/#/manage` });
      await cdp.waitFor(`document.querySelector('[data-host="${host}"] [data-act="start"]')`, '目标行就位');
      await cdp.eval(`document.querySelector('[data-host="${host}"] [data-act="start"]').click(); return true;`);
      await cdp.waitFor(
        "document.querySelector('.confirm-dialog')?.open === true && document.querySelectorAll('.confirm-choice').length === 6",
        '六个候选摆进确认框',
      );
      const shot = await screenshot(cdp, 'adopt-picker');

      const view = await cdp.eval(`
        const dlg = document.querySelector('.confirm-dialog');
        const box = dlg.getBoundingClientRect();
        const rows = [...dlg.querySelectorAll('.confirm-choice')].map((l) => {
          const r = l.getBoundingClientRect();
          const input = l.querySelector('input');
          return {
            text: l.textContent.trim(), right: r.right, bottom: r.bottom, height: r.height,
            checked: input.checked, disabled: input.disabled,
          };
        });
        const listNode = dlg.querySelector('.confirm-choices');
        const list = listNode.getBoundingClientRect();
        return {
          right: box.right, bottom: box.bottom, viewportH: innerHeight,
          listBottom: list.bottom, listH: Math.round(list.height), listScrollH: listNode.scrollHeight, rows,
          confirmDisabled: [...dlg.querySelectorAll('.confirm-actions .btn')]
            .find((b) => /只读领养/.test(b.textContent)).disabled,
        };
      `);
      assert(view.rows.filter((r) => r.checked).length === 1, '必须且只能预选一个候选');
      assert(!view.confirmDisabled, '有可领养候选却把确认按钮锁着');
      assert(view.bottom <= view.viewportH + 1, `六行候选把对话框顶出视口（bottom=${view.bottom} > ${view.viewportH}）`);
      for (const row of view.rows) {
        assert(/PID \d+/.test(row.text) && /端口/.test(row.text), `候选缺 PID 或端口：${row.text}`);
        assert(row.right <= view.right + 1, `候选行横向溢出对话框：${row.text}`);
        assert(row.height >= 20, `候选行只有 ${row.height}px 高，点不准`);
        // 六行是真机常态；末行被滚动框切成半截会让人以为只有五个候选
        assert(row.bottom <= view.listBottom + 1,
          `候选行被滚动框切掉（视口高 ${view.viewportH}，列表 ${view.listH}px 装 ${view.listScrollH}px）：${row.text}`);
      }

      const target = manual[3];
      await cdp.eval(`
        const dlg = document.querySelector('.confirm-dialog');
        [...dlg.querySelectorAll('.confirm-choice input')][3].click();
        [...dlg.querySelectorAll('.confirm-actions .btn')].find((b) => /只读领养/.test(b.textContent)).click();
        return true;
      `);
      const adopted = await waitHost(rig, host, ['running']);
      assert(adopted.web.pid === target.pid,
        `登记的是 pid=${adopted.web.pid}，选中的是 pid=${target.pid}`);
      assert(adopted.web.startedByUs === false, '领养来的实例不许被记成自己拉起的');
      assert(adopted.manualInstances.length === 5, `其余手动实例应剩 5 个，实测 ${adopted.manualInstances.length}`);
      return `${path.relative(REPO, shot)}；领养 pid=${target.pid}，另 5 个照旧只读`;
    });
  } finally {
    cdp.close();
    await chrome.kill();
    await rig.shutdown().catch(() => {});
    if (!flag('keep')) rig.cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过；截图在 ${path.relative(REPO, OUT_DIR)}/`);
  if (failed.length > 0) {
    console.log('未通过：');
    for (const f of failed) console.log(`  - ${f.id} ${f.title}：${f.note}`);
    process.exitCode = 1;
  }
}

// 被 check.mjs / 单测 import 时只取 findChrome，不能顺带把浏览器跑起来
if (isMainEntry(import.meta.url)) {
  main()
    .catch((err) => {
      console.error(`ui-smoke 失败：${err.stack ?? err.message}`);
      process.exitCode = 1;
    })
    // 结论打完就该收工。真浏览器这头总有拽住循环的东西（issue #112），别让 CI 挂着等。
    .finally(() => armExitGuard());
}
