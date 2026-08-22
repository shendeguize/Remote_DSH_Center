#!/usr/bin/env node
/**
 * README 与 landing 用的界面截图，由无头浏览器自动生成。
 *
 * 为什么不手拍：手拍的图会在下一次 UI 改动后静静过时，而且没人记得重拍。
 * 这里跑的是**构建产物里的真前端**（src/web 原样 + 浏览器内假 manager），
 * 所以 `npm run site:shots` 随时可重跑，图永远跟代码同步。
 *
 * 截图里的 demo 控制栏会被摘掉——那是站点的东西，不属于产品界面。
 *
 * 用法：
 *   npm run site:shots
 *   node scripts/site-shots.mjs --headful          # 想亲眼看着拍
 *   node scripts/site-shots.mjs --out /tmp/shots
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';

import { buildSite, serveStatic } from './build-site.mjs';
import { captureScreenshot, findChrome, launchChrome, pageSession, sleep } from './lib/browser.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};

const OUT_DIR = path.resolve(opt('out', path.join(REPO, 'site', 'assets', 'shots')));
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

/** 摘掉 demo 控制栏并把它让出的高度收回，免得截图底部留一条黑边。 */
const HIDE_DEMO_BAR = `
  document.querySelector('.demo-bar')?.remove();
  document.documentElement.style.setProperty('--demo-bar-h', '0px');
  return true;
`;

/** 截图里不收正在消退的通知，也不收意外悬着的菜单/确认框。 */
const CLEAN_FRAME = `
  document.querySelectorAll('.toast').length === 0
    && !document.querySelector('.confirm-dialog[open]')
    && !document.querySelector('.context-menu:not([hidden])')
`;

async function main() {
  if (!findChrome()) {
    process.stderr.write('找不到 Chrome/Chromium；用 DSHC_CHROME=<路径> 指定。\n');
    process.exitCode = 1;
    return;
  }

  buildSite();
  const srv = await serveStatic(path.join(REPO, '_site'));
  const chrome = await launchChrome({ headful: flag('headful') });
  const cdp = await pageSession(chrome);
  const shots = [];

  const shoot = async (name, label) => {
    await cdp.waitFor(CLEAN_FRAME, `${name} 没有临时弹层`, { timeoutMs: 12_000 });
    await sleep(200);
    const file = await captureScreenshot(cdp, OUT_DIR, name, { beyondViewport: false });
    shots.push({ name, label, file });
    process.stdout.write(`  ✔ ${name.padEnd(10)} ${label}\n`);
  };

  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
    // 截图是基线，不记录 pulse/blink 正好走到哪一帧。
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    process.stdout.write('截图：\n');

    // ① Hub 首屏。文件名继续叫 dashboard，兼容 README 与 landing 的既有引用；
    // 管理全景放到下一张抽屉图的后景里，两层信息架构都能在五张图里出现。
    await cdp.send('Page.navigate', { url: `${srv.origin}/demo/` });
    await cdp.waitFor(
      "location.hash === '#/hub' && document.querySelectorAll('.view-hub:not([hidden]) .hub-host-card').length === 2",
      'Hub 可用主机就位',
    );
    await cdp.eval(HIDE_DEMO_BAR);
    await sleep(400);
    await shoot('dashboard', 'Hub 首屏：日常主机入口与管理入口');

    // ② #/manage 上的主机详情抽屉
    await cdp.eval("window.location.hash = '#/manage'; return true;");
    await cdp.waitFor(
      "location.hash === '#/manage' && !document.querySelector('.view-dashboard').hidden && document.querySelectorAll('.host-table tbody tr').length === 4",
      '管理页四台主机就位',
    );
    await cdp.click('.host-table tr[data-host="gpu-a100"]');
    await cdp.waitFor(
      "document.querySelector('.host-drawer:not([hidden])') && document.querySelector('.drawer-scrim:not([hidden])')",
      '抽屉打开',
    );
    // demo 事件时间取自当前时钟；只固定截图里的显示文本，避免每次重跑制造无意义像素差。
    await cdp.eval(`
      document.querySelectorAll('.probe-at').forEach((node) => { node.textContent = '探测 4 秒前'; });
      document.querySelectorAll('.event-item time').forEach((node, index) => {
        node.textContent = '00:00:' + String(index).padStart(2, '0');
      });
      return true;
    `);
    await sleep(300);
    await shoot('drawer', '管理页主机详情：注入配置、远端日志、探测详情');
    await cdp.key('Escape', { keyCode: 27 });
    await cdp.waitFor("document.querySelector('.host-drawer').hidden", '抽屉关闭');

    // ③ 标签页里的远端 dsh web
    await cdp.eval("window.location.hash = '#/host/gpu-a100'; return true;");
    await cdp.waitFor(
      `document.querySelector('.iframe-pane[data-host="gpu-a100"]:not([hidden]) iframe')?.contentDocument?.documentElement?.hasAttribute('data-mock-dsh-web')`,
      'mock dsh web iframe 就绪',
    );
    // mock 页脚刻意带随机 session id；基线图把这一个易变字段归一化，避免每次重跑产生噪声。
    await cdp.eval(`
      const foot = document.querySelector('.iframe-pane[data-host="gpu-a100"] iframe')?.contentDocument?.querySelector('#foot');
      if (!foot) return false;
      foot.textContent = 'Mock session demo01 · http://127.0.0.1:17701/ · gpu-a100';
      return true;
    `);
    await shoot('iframe', '单行薄壳：iframe 内是 mock dsh web 本体');

    // ④ 断联遮罩（退避重连要 ~7s 才恢复，够拍）
    await cdp.eval("window.__demo.manager.injectTunnelDrop('gpu-a100'); return true;");
    await cdp.waitFor(
      `!document.querySelector('.iframe-pane[data-host="gpu-a100"] .iframe-overlay').hidden`,
      '断联遮罩出现',
    );
    await sleep(250);
    await shoot('degraded', '隧道断开：遮罩盖上但页面内容留着');

    // ⑤ 首启引导第 3 步（逐台探测 + 纳管/开启链接勾选）
    await cdp.send('Page.navigate', { url: `${srv.origin}/demo/?setup` });
    await cdp.waitFor("document.querySelector('.setup-wizard') && !document.querySelector('.setup-wizard').hidden", '向导渲染');
    await cdp.eval(HIDE_DEMO_BAR);
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- 一步一步往前走
      await cdp.click('.wizard-foot .btn-primary');
      // eslint-disable-next-line no-await-in-loop -- 同上
      await sleep(250);
    }
    await cdp.waitFor("document.querySelector('.setup-hosts tbody tr')", '第 3 步的主机清单出现');
    // 等最慢那台探测完（四台 SSH + 一台本机候选，最慢 2.7s）：
    // 五台结果都在且本机标签已渲染，才拍下 README 承诺的同屏候选画面。
    await cdp.waitFor(
      `document.querySelector('.wizard-progress')?.textContent.includes('5 / 共 5')
        && document.querySelectorAll('.setup-hosts tbody tr').length === 5
        && document.querySelector('.setup-hosts tbody .tag-lock')?.textContent === '本机'`,
      '本机与四台 SSH 候选探测全部完成',
      { timeoutMs: 12_000 },
    );
    await sleep(300);
    await shoot('setup', '首启引导第 3 步：逐台探测 + 纳管/开启链接');
  } finally {
    cdp.close();
    chrome.kill();
    await srv.close();
  }

  process.stdout.write(`\n${shots.length} 张图已写入 ${path.relative(REPO, OUT_DIR)}/\n`);
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`截图失败：${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}
