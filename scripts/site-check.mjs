#!/usr/bin/env node
/**
 * 站点与文档的质量闸门（`npm run check` 的 site 关）。
 *
 * 三小关，任一红就整体红：
 *   build  站点能构建出完整产物（缺文件当场红）
 *   docs   站内链接可达 + README（中英）里的本地链接/图片存在 +
 *          README 里出现的 dshc 子命令确实存在于 CLI 的命令表
 *   demo   真浏览器打开在线 demo，跑一遍「首屏 → 拉起 → 断联 → 恢复」
 *
 * 文档这一关的价值在「README 里写的命令是真的」——命令改了名而 README 没跟上，
 * 是新用户第一分钟就会踩到的坑，靠人读是读不出来的。
 *
 * 用法：
 *   node scripts/site-check.mjs                    # 全部
 *   node scripts/site-check.mjs --only build,docs  # 跳过浏览器
 *   node scripts/site-check.mjs --require-browser  # 没装 Chrome 也要判红
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { armExitGuard } from './lib/exit-guard.mjs';

import { buildSite, serveStatic } from './build-site.mjs';
import { captureScreenshot, findChrome, launchChrome, pageSession, sleep } from './lib/browser.mjs';
import { COMMANDS } from '../src/cli.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO, '.local', 'tmp', 'site-check');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};

/**
 * 等到条件成立。浏览器侧的判据几乎都是「迟一点才成立」——iframe 元素建出来那一刻，
 * 它的网络响应还在路上；本机快看不出来，CI 上就是偶发红（issue #79）。
 * @param {() => boolean} ok
 * @param {string} label 超时文案用：说清等的是什么
 */
export async function waitUntil(ok, label, { timeoutMs = 5_000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ok()) return;
    if (Date.now() >= deadline) throw new Error(`${label}：等了 ${timeoutMs}ms 还没成立`);
    // eslint-disable-next-line no-await-in-loop -- 就是在轮询
    await sleep(stepMs);
  }
}

// ── docs：链接与命令核对（纯函数，便于单测） ──────────────────────────────

/** `service install` 这类二级子命令：README 会写全，命令表里只有一级。 */
const SUBCOMMANDS = Object.freeze({
  service: ['install', 'uninstall', 'status'],
  config: ['get', 'set'],
});

/**
 * markdown 里的代码内容（围栏块 + 行内 span）。
 *
 * 命令核对只看代码位：正文里「摘掉 PATH 里的 dshc 软链」这种句子，
 * 按字面扫会把后面那个词当成子命令，全是假警报。
 */
export function codeChunks(text) {
  const out = [];
  const fenced = text.replace(/```[a-z]*\n([\s\S]*?)```/g, (_, body) => {
    out.push(body);
    return '\n';
  });
  for (const m of fenced.matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
  return out;
}

/**
 * 抽出代码位里所有 `dshc <子命令>` 的提及。
 *
 * 两种写法都要认：
 *   - 真实命令行 `dshc config set hosts.gpu-1.workdir '~/x'` —— 只取头一两个词，
 *     后面全是参数（否则 `hosts.gpu-1.workdir` 会被当成命令名）
 *   - 命令清单 `dshc init / up / down / service install|uninstall|status`
 *     —— 斜杠分隔的每段各是一条命令
 *
 * @returns {string[]} 去重后的命令名（含 `service install` 这类两段式）
 */
export function mentionedCommands(text) {
  const found = new Set();

  const take = (segment) => {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const head = tokens[0];
    if (!head || !/^[a-z][a-z-]*$/.test(head)) return;
    const subs = SUBCOMMANDS[head];
    if (!subs) {
      found.add(head);
      return;
    }
    // `service install|uninstall|status` 里每个都要核对
    const pieces = (tokens[1] ?? '').split('|').filter((p) => /^[a-z][a-z-]*$/.test(p));
    if (pieces.length === 0) found.add(head);
    else for (const p of pieces) found.add(`${head} ${p}`);
  };

  for (const chunk of codeChunks(text)) {
    for (const raw of chunk.split('\n')) {
      // 先砍掉行尾注释再找命令：注释里出现「the dshc symlink」这种句子不算命令
      const line = raw.split('#')[0];
      const m = /\bdshc\s+(.+)$/.exec(line);
      if (!m) continue;
      const rest = m[1];
      if (rest.includes(' / ')) for (const seg of rest.split(' / ')) take(seg);
      else take(rest);
    }
  }
  return [...found];
}

/**
 * 校验提及的命令都真实存在。
 * @returns {string[]} 不存在的命令
 */
export function unknownCommands(mentions, commands = COMMANDS) {
  const known = new Set(Object.keys(commands));
  return mentions.filter((m) => {
    const [head, tail] = m.split(' ');
    if (!known.has(head)) return true;
    if (tail && SUBCOMMANDS[head] && !SUBCOMMANDS[head].includes(tail)) return true;
    return false;
  });
}

/** markdown 里的本地链接与图片（跳过 http(s)、mailto、纯锚点）。 */
export function localMarkdownTargets(text) {
  const out = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    out.push(target);
  }
  return out;
}

/** html 里的本地 href/src。 */
export function localHtmlTargets(html) {
  const out = [];
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|data:|#)/.test(target)) continue;
    out.push(target);
  }
  return out;
}

function checkDocs(outDir) {
  const problems = [];

  // 1. README（中英）的本地链接与图片
  for (const name of ['README.md', 'README.en.md']) {
    const file = path.join(REPO, name);
    if (!fs.existsSync(file)) {
      problems.push(`${name} 不存在`);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    for (const target of localMarkdownTargets(text)) {
      const clean = target.split('#')[0];
      if (clean === '') continue;
      if (!fs.existsSync(path.resolve(REPO, clean))) problems.push(`${name} 指向不存在的路径：${target}`);
    }
    const unknown = unknownCommands(mentionedCommands(text));
    if (unknown.length > 0) problems.push(`${name} 提到了不存在的命令：${unknown.map((c) => `dshc ${c}`).join(', ')}`);
  }

  // 2. 站点产物里的站内链接
  const htmlFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) htmlFiles.push(full);
    }
  };
  walk(outDir);

  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    for (const target of localHtmlTargets(html)) {
      const clean = target.split('#')[0].split('?')[0];
      if (clean === '') continue;
      const resolved = clean.startsWith('/')
        ? path.join(outDir, clean)
        : path.resolve(path.dirname(file), clean);
      const ok = fs.existsSync(resolved)
        || (fs.existsSync(path.join(resolved, 'index.html')));
      if (!ok) problems.push(`${path.relative(outDir, file)} 指向不存在的资源：${target}`);
    }
  }

  return { problems, htmlFiles: htmlFiles.length };
}

// ── demo：真浏览器冒烟 ────────────────────────────────────────────────────

async function checkDemo(outDir) {
  const srv = await serveStatic(outDir);
  const chrome = await launchChrome({ headful: flag('headful') });
  const cdp = await pageSession(chrome);

  const consoleErrors = [];
  const responses = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(`未捕获异常：${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push(`console.error：${p.args.map((a) => a.value ?? a.description).join(' ')}`);
  });
  cdp.on('Network.responseReceived', (p) => responses.push({ url: p.response.url, status: p.response.status }));

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const notes = [];
  try {
    // ① 首屏：根路由落到 hub，ready 主机已经是常驻标签与一步拉起入口
    await cdp.send('Page.navigate', { url: `${srv.origin}/demo/?fast` });
    await cdp.waitFor(
      `window.location.hash === '#/hub'
        && document.querySelector('.view-hub:not([hidden])')
        && window.__demo.manager.hosts().hosts.length === 4`,
      'demo 首屏进入 hub 并同步四台主机',
    );
    await cdp.waitFor(
      `window.__demo.manager.getHost('gpu-4090-daily').phase === 'ready'
        && document.querySelector('.hub-host-card[data-host="gpu-4090-daily"][data-phase="ready"]')
        && document.querySelector('.host-tabs .tab[data-host="gpu-4090-daily"]')`,
      'ready 主机同时出现在 hub 与常驻标签',
    );
    notes.push('hub 首屏 4 台、ready 标签常驻');

    // ② 控制栏在位
    await cdp.waitFor("document.querySelectorAll('.demo-bar .demo-btn').length >= 5", 'demo 控制栏渲染');

    // ③ 从 hub 点 ready 卡片：一步完成「拉起 + 进入」，且不能跳过 starting
    await cdp.click('.hub-host-card[data-host="gpu-4090-daily"]');
    await cdp.waitFor(
      `window.location.hash === '#/host/gpu-4090-daily'
        && window.__demo.manager.getHost('gpu-4090-daily').phase === 'starting'
        && !document.querySelector('.iframe-pane[data-host="gpu-4090-daily"] .iframe-overlay').hidden`,
      'ready 卡片进入 starting 主机页',
    );
    await cdp.waitFor(
      `window.__demo.manager.getHost('gpu-4090-daily').phase === 'running'
        && document.querySelector('.iframe-pane[data-host="gpu-4090-daily"] iframe')`,
      'starting 后进入 running 并创建 iframe',
    );
    notes.push('ready 一步拉起经过 starting → running');

    // ④ 标签页与 iframe：src 必须是后端下发的 mappedUrl
    const iframeOk = await cdp.eval(`
      const frame = document.querySelector('.iframe-pane[data-host="gpu-4090-daily"] iframe');
      const host = window.__demo.manager.getHost('gpu-4090-daily');
      return frame.getAttribute('src') === host.mappedUrl && host.mappedUrl.includes('mock-dsh-web');
    `);
    if (!iframeOk) throw new Error('iframe src 与假 manager 下发的 mappedUrl 不一致');
    // iframe 的 src 刚设上，响应还在路上：这里必须「等到」而不是「此刻」（issue #79）
    await waitUntil(
      () => responses.some((r) => r.url.includes('mock-dsh-web') && r.status === 200),
      'mock dsh web 页被 iframe 加载（应有 200 响应）',
    );
    await cdp.waitFor(
      `document.querySelector('.iframe-pane[data-host="gpu-4090-daily"] iframe')
        .contentDocument?.documentElement.hasAttribute('data-mock-dsh-web')`,
      'iframe 内载入标明 Mock 的 dsh web 轮廓',
    );

    // ⑤ mock 表单是 keep-alive 探针：去管理页再回来，iframe 不得重建或清空输入
    const keepaliveValue = 'site-check keepalive';
    const filled = await cdp.eval(`
      const frame = document.querySelector('.iframe-pane[data-host="gpu-4090-daily"] iframe');
      const input = frame.contentDocument?.querySelector('#draft');
      if (!input) return false;
      input.value = ${JSON.stringify(keepaliveValue)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value === ${JSON.stringify(keepaliveValue)};
    `);
    if (!filled) throw new Error('mock dsh web 的 keep-alive 输入框不可用');

    await cdp.click('.tab-manage');
    await cdp.waitFor(
      `window.location.hash === '#/manage'
        && document.querySelector('.view-dashboard:not([hidden])')
        && document.querySelectorAll('.host-table tbody tr').length === 4`,
      '从标签栏进入 manage 并看到四台主机',
    );
    await cdp.click('.host-tabs .tab[data-host="gpu-4090-daily"]');
    await cdp.waitFor(
      `window.location.hash === '#/host/gpu-4090-daily'
        && !document.querySelector('.iframe-pane[data-host="gpu-4090-daily"]').hidden`,
      '从 manage 返回运行中主机',
    );
    const kept = await cdp.eval(`
      const frame = document.querySelector('.iframe-pane[data-host="gpu-4090-daily"] iframe');
      return frame.contentDocument?.querySelector('#draft')?.value === ${JSON.stringify(keepaliveValue)};
    `);
    if (!kept) throw new Error('切到 manage 再返回后 mock 输入被清空，iframe keep-alive 失效');
    notes.push('manage 入口可达、mock 输入保活');

    // ⑥ 注入断联：遮罩出现
    await cdp.eval("window.__demo.manager.injectTunnelDrop('gpu-4090-daily'); return true;");
    await cdp.waitFor(
      `!document.querySelector('.iframe-pane[data-host="gpu-4090-daily"] .iframe-overlay').hidden`,
      '断联遮罩出现',
    );
    notes.push('断联出遮罩');

    // ⑦ 退避重连：遮罩消失且回到运行中
    await cdp.waitFor(
      `document.querySelector('.iframe-pane[data-host="gpu-4090-daily"] .iframe-overlay').hidden`,
      '重连后遮罩消失',
      { timeoutMs: 10_000 },
    );
    notes.push('重连自愈');

    // ⑧ 首启引导：?setup 能走到向导
    await cdp.send('Page.navigate', { url: `${srv.origin}/demo/?setup&fast` });
    await cdp.waitFor("document.querySelector('.setup-wizard') && !document.querySelector('.setup-wizard').hidden", '首启引导可达');
    notes.push('首启引导可达');

    await captureScreenshot(cdp, OUT_DIR, 'demo-setup');

    // ⑨ 无控制台错误、无失败资源
    const bad = responses.filter((r) => r.status >= 400 && r.url.startsWith(srv.origin));
    if (bad.length > 0) throw new Error(`有失败请求：${bad.map((b) => `${b.status} ${b.url}`).join(', ')}`);
    if (consoleErrors.length > 0) throw new Error(`控制台有错误：${consoleErrors.join(' | ')}`);
    notes.push(`${responses.length} 个请求全 2xx`);
  } finally {
    await captureScreenshot(cdp, OUT_DIR, 'demo-final').catch(() => {});
    cdp.close();
    chrome.kill();
    await srv.close();
  }

  return notes.join('、');
}

// ── 主流程 ───────────────────────────────────────────────────────────────

const CHECKS = ['build', 'docs', 'demo'];

async function main() {
  const only = opt('only');
  const selected = only ? only.split(',').map((s) => s.trim()) : CHECKS;
  const unknown = selected.filter((s) => !CHECKS.includes(s));
  if (unknown.length > 0) {
    process.stderr.write(`未知子检查：${unknown.join(', ')}（可选：${CHECKS.join(', ')}）\n`);
    process.exitCode = 3;
    return;
  }

  const outDir = path.resolve(opt('out', path.join(REPO, '_site')));
  const results = [];
  let built = null;

  if (selected.includes('build')) {
    const { files } = buildSite({ outDir });
    built = files;
    results.push(['build', 'pass', `${files.length} 个文件`]);
  } else {
    buildSite({ outDir });
  }

  if (selected.includes('docs')) {
    const { problems, htmlFiles } = checkDocs(outDir);
    if (problems.length > 0) {
      results.push(['docs', 'fail', `\n    - ${problems.join('\n    - ')}`]);
    } else {
      results.push(['docs', 'pass', `${htmlFiles} 个页面 + 双语 README 链接与命令一致`]);
    }
  }

  if (selected.includes('demo')) {
    if (!findChrome()) {
      if (flag('require-browser')) results.push(['demo', 'fail', '未找到 Chrome，而 --require-browser 已开']);
      else results.push(['demo', 'skip', '未装 Chrome，已跳过']);
    } else {
      try {
        results.push(['demo', 'pass', await checkDemo(outDir)]);
      } catch (err) {
        results.push(['demo', 'fail', err.message]);
      }
    }
  }

  const mark = { pass: '✔', fail: '✘', skip: '·' };
  process.stdout.write(`\n站点检查：\n${results.map(([id, st, note]) => `  ${mark[st]} ${id.padEnd(6)} ${note}`).join('\n')}\n`);
  if (built) process.stdout.write(`  产物：${path.relative(REPO, outDir)}/\n`);

  const failed = results.filter(([, st]) => st === 'fail');
  if (failed.length > 0) {
    process.stdout.write(`\n未通过：${failed.map(([id]) => id).join('、')}\n`);
    process.exitCode = 1;
  }
}

if (isMainEntry(import.meta.url)) {
  await main();
  // 这条也开浏览器，同一个坑（issue #112）
  armExitGuard();
}
