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

import { createHarness, newHostState } from '../tests/harness/index.js';
import { CONFIG_VERSION } from '../src/defaults.js';
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

async function check(id, title, fn) {
  const started = Date.now();
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
    await cdp.waitFor("document.querySelector('.host-table tbody tr')", '首屏渲染出主机行');

    console.log('检查项：');

    await check('S1', '首屏无控制台错误、无 4xx/5xx 资源', async () => {
      await cdp.waitFor("document.querySelectorAll('.host-table tbody tr').length === 3", '三台主机都到位');
      const bad = responses.filter((r) => r.status >= 400 && r.url.startsWith(rig.base));
      assert(bad.length === 0, `有失败请求：${bad.map((b) => `${b.status} ${b.url}`).join(', ')}`);
      assert(consoleErrors.length === 0, consoleErrors.join(' | '));
      return `${responses.length} 个请求全部 2xx`;
    });

    await check('S2', '状态呈现：颜色之外还有文字与形状', async () => {
      const badges = await cdp.eval(`
        return [...document.querySelectorAll('.phase-badge')].map((b) => ({
          tone: b.dataset.tone ?? null,
          text: b.textContent.trim(),
          dot: b.querySelector('.status-dot')?.dataset.dot ?? null,
          color: getComputedStyle(b).color,
        }));
      `);
      assert(badges.length > 0, '页面里没有状态徽章');
      for (const b of badges) {
        assert(b.text.length > 0, `徽章缺文字（tone=${b.tone}）`);
        assert(b.tone, '徽章缺 data-tone');
        assert(b.dot, '徽章缺形状标识 .status-dot[data-dot]');
      }
      return `${badges.length} 个徽章，形状取值 ${[...new Set(badges.map((b) => b.dot))].join('/')}`;
    });

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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

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
      await cdp.eval("document.querySelector('.host-table tbody tr').focus(); return true;");
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

    await check('S6', '标签页菜单：Shift+F10 开、方向键移动、Esc 收回', async () => {
      const host = await waitHost(rig, 'gpu-1', ['ready']);
      assert(host, 'gpu-1 应已就绪');
      await rig.api('POST', '/api/hosts/gpu-1/start');
      await waitHost(rig, 'gpu-1', ['running']);
      await cdp.waitFor("document.querySelector('.host-tabs .tab')", '标签栏出现 running 主机');

      await cdp.eval("document.querySelector('.host-tabs .tab').focus(); return true;");
      await cdp.key('F10', { code: 'F10', keyCode: 121, modifiers: 8 }); // 8 = Shift
      await cdp.waitFor("document.querySelector('.context-menu') && !document.querySelector('.context-menu').hidden", 'Shift+F10 开菜单');
      await cdp.key('ArrowDown', { keyCode: 40 });
      const onItem = await cdp.eval("return document.activeElement?.getAttribute('role') === 'menuitem';");
      assert(onItem, '方向键应把焦点落到菜单项上');
      await cdp.key('Escape', { keyCode: 27 });
      await cdp.waitFor("!document.querySelector('.context-menu') || document.querySelector('.context-menu').hidden", 'Esc 收回菜单');
      const backOnTab = await cdp.eval("return document.activeElement?.classList.contains('tab') === true;");
      assert(backOnTab, 'Esc 后焦点应回到标签');
      return '开/移/收 三步齐';
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
      await screenshot(cdp, 'deeplink-cold-boot');
      return '冷启动与刷新都落在主机页';
    });

    // 真机上是 8 台主机 + 37 字符长名把标签栏撑到 2058px（可视 1024px），激活标签
    // 停在可视区外，看起来像一个都没选中（issue #25）。假装置只有两台短名主机，
    // 撑不出溢出——把视口收窄到 480px 等价复现，且不用为此多起几台主机。
    await check('S11', '标签栏溢出时激活标签仍在可视区内', async () => {
      await rig.api('POST', `/api/hosts/${encodeURIComponent(LONG_HOST)}/start`);
      await waitHost(rig, LONG_HOST, ['running']);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url: `${rig.base}/#/` });
      // gpu-1 在 S6/S7 里已经起着，加上长名这台就是两个标签
      await cdp.waitFor("document.querySelectorAll('.host-tabs .tab').length === 2", '长名主机的标签也在');

      const overflowing = await cdp.eval(`
        const bar = document.querySelector('.tabbar');
        return { scroll: bar.scrollWidth, client: bar.clientWidth, overflowX: getComputedStyle(bar).overflowX };
      `);
      assert(overflowing.overflowX === 'auto', `标签栏 overflow-x=${overflowing.overflowX}，溢出就滚不动了`);
      assert(overflowing.scroll > overflowing.client,
        `480px 下标签栏没撑出溢出（${overflowing.scroll}/${overflowing.client}），判据在空转`);

      // 挑排在最后的那个标签——只有它才需要真的滚一段才看得见
      const target = await cdp.eval(`
        const tabs = [...document.querySelectorAll('.host-tabs .tab')];
        const last = tabs[tabs.length - 1];
        const bar = document.querySelector('.tabbar');
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
        const bar = document.querySelector('.tabbar');
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
    await cdp.send('Page.navigate', { url: `${rig.base}/#/` });
    await cdp.waitFor("document.querySelector('.host-table tbody tr')", '回到管理台');

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

    await check('S9', 'manager 掉线：横幅出现且写按钮禁用；期间不堆连接', async () => {
      const before = responses.filter((r) => r.url.endsWith('/api/events')).length;
      await rig.shutdown();
      await cdp.waitFor("!document.querySelector('.disconnect-banner').hidden", '断线横幅出现', { timeoutMs: 20_000 });
      const state = await cdp.eval(`
        const row = document.querySelector('.host-table tbody tr');
        return {
          banner: document.querySelector('.disconnect-banner').textContent.trim(),
          writable: [...document.querySelectorAll('.header-actions .btn')].some((b) => !b.disabled),
          rowWritable: [...row.querySelectorAll('.row-actions .btn')].some((b) => !b.disabled && b.textContent !== '打开'),
        };
      `);
      assert(/失联/.test(state.banner), `横幅文案不含「失联」：${state.banner}`);
      assert(!state.writable, '断线后 header 写按钮仍可点');
      assert(!state.rowWritable, '断线后行内写按钮仍可点');
      await sleep(3_000);
      const after = responses.filter((r) => r.url.endsWith('/api/events')).length;
      assert(after - before <= 4, `3s 内 /api/events 新增 ${after - before} 次，疑似自建重连风暴`);
      await screenshot(cdp, 'offline-banner');
      return `「${state.banner}」`;
    });
  } finally {
    cdp.close();
    chrome.kill();
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
  main().catch((err) => {
    console.error(`ui-smoke 失败：${err.stack ?? err.message}`);
    process.exit(1);
  });
}
