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
    const file = await captureScreenshot(cdp, OUT_DIR, name, { beyondViewport: false });
    shots.push({ name, label, file });
    process.stdout.write(`  ✔ ${name.padEnd(10)} ${label}\n`);
  };

  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
    process.stdout.write('截图：\n');

    // ① 管理台全景
    await cdp.send('Page.navigate', { url: `${srv.origin}/demo/` });
    await cdp.waitFor("document.querySelectorAll('.host-table tbody tr').length === 4", '管理台四台主机就位');
    await cdp.eval(HIDE_DEMO_BAR);
    await sleep(400);
    await shoot('dashboard', '管理台全景（四台主机铺满状态谱系）');

    // ② 主机详情抽屉
    await cdp.click('tr[data-host="gpu-a100"]');
    await cdp.waitFor("document.querySelector('.host-drawer') && !document.querySelector('.host-drawer').hidden", '抽屉打开');
    await sleep(300);
    await shoot('drawer', '主机详情抽屉：注入配置、远端日志、探测详情');
    await cdp.key('Escape', { keyCode: 27 });
    await cdp.waitFor("document.querySelector('.host-drawer').hidden", '抽屉关闭');

    // ③ 标签页里的远端 dsh web
    await cdp.eval("window.location.hash = '#/host/gpu-a100'; return true;");
    await cdp.waitFor(`document.querySelector('.iframe-pane[data-host="gpu-a100"] iframe')`, 'iframe 建出来');
    await sleep(3_600); // 等 mock 页的打字机把终端铺满
    await shoot('iframe', '标签页：iframe 里是远端 dsh web 本体');

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
    // 等最慢那台探测完（demo 里刻意让四台快慢不一，最慢 2.7s）：
    // 四台结果都在的画面才看得出「开启链接只对可拉起的主机开放」
    await cdp.waitFor(
      "document.querySelector('.wizard-progress')?.textContent.includes('4 / 共 4')",
      '四台探测全部完成',
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
