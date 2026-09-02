#!/usr/bin/env node
/**
 * GitHub Pages 站点构建：把 `site/` 与 `src/web/` 拼成 `_site/`。
 *
 * 没有打包器（与本体同一哲学）。构建只做三件事：
 *   1. 拷贝 —— site/* 到根、src/web/* 到 demo/、src/lib/{machine,errors}.js 到 demo/lib/
 *   2. 改写 —— demo/index.html 的绝对路径改相对（Pages 部署在子路径下），
 *      并把启动脚本换成「先装假 manager 垫片，再 bootApp」
 *   3. 校验 —— 产物里该有的文件必须都在（缺了当场红，而不是等浏览器 404）
 *
 * `src/web/**` 一个字节都不改：demo 跑的就是产品前端本体，
 * 一切「假」都在 site/demo/demo-shim.js 里（覆写 fetch / EventSource）。
 *
 * 用法：
 *   node scripts/build-site.mjs                  # 构建到 _site/
 *   node scripts/build-site.mjs --out /tmp/x     # 换输出目录
 *   node scripts/build-site.mjs --serve          # 构建后起本地静态服务（site:dev）
 *   node scripts/build-site.mjs --serve --port 4321
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** GitHub Pages 的公开根地址；canonical、robots 与 sitemap 共用这一口径。 */
export const PAGES_BASE_URL = 'https://shendeguize.github.io/Remote_DSH_Center/';

/** sitemap 只发布真实生成 HTML 的公开路由，路径均相对 PAGES_BASE_URL。 */
export const SITEMAP_ROUTES = Object.freeze(['', 'demo/']);

/** 从 src/lib 借到 demo 的模块：必须是浏览器安全的纯模块（machine/host-filter 只依赖 errors）。 */
export const BORROWED_LIB = Object.freeze(['machine.js', 'errors.js', 'host-filter.js']);

/** 构建产物里必须存在的文件（相对 outDir）。少一个就说明拷漏了。 */
export const REQUIRED_OUTPUTS = Object.freeze([
  'index.html',
  'robots.txt',
  'sitemap.xml',
  'landing.css',
  'landing.js',
  'assets/shots/dashboard.png',
  '.nojekyll',
  'demo/index.html',
  'demo/app.js',
  'demo/style.css',
  'demo/components/host-table.js',
  'demo/demo-shim.js',
  'demo/demo-manager.js',
  'demo/demo-routes.js',
  'demo/demo-data.js',
  'demo/demo-bar.js',
  'demo/demo.css',
  'demo/lib/machine.js',
  'demo/lib/errors.js',
  'mock-dsh-web/index.html',
]);

/**
 * demo/index.html 的唯一改写。
 *
 * 两件事：
 *   - `/style.css` 这类根绝对路径在 Pages 的子路径下会 404，改成相对；
 *   - 启动脚本换成显式两步（装垫片 → bootApp），保证 fetch/EventSource
 *     在 app.js 发出第一个请求之前就已经被换掉。
 *
 * 找不到预期的启动脚本就抛错：src/web/index.html 若改了形状，
 * 这里必须跟着改，不能静默产出一个「打开就是空白页」的 demo。
 *
 * @param {string} html src/web/index.html 原文
 * @returns {string}
 */
export function rewriteDemoHtml(html) {
  const bootRe = /<script type="module">\s*import \{ bootApp \} from '\/app\.js';\s*bootApp\(\);\s*<\/script>/;
  if (!bootRe.test(html)) {
    throw new Error('src/web/index.html 的启动脚本形状变了，scripts/build-site.mjs 的改写规则需同步更新');
  }

  const out = html
    .replace(/href="\/favicon\.svg"/, 'href="./favicon.svg"')
    .replace(/href="\/style\.css"/, 'href="./style.css"')
    .replace('<title>DSH Center</title>', '<title>DSH Center — 在线 demo</title>')
    .replace(
      '</head>',
      '<link rel="stylesheet" href="./demo.css">\n</head>',
    )
    .replace(bootRe, [
      '<script type="module">',
      "  import { installDemo } from './demo-shim.js';",
      "  import { bootApp } from './app.js';",
      '  // 垫片先就位，再启动真前端：app.js 的第一个 fetch 必须已经被接管',
      '  await installDemo();',
      '  bootApp();',
      '</script>',
    ].join('\n'));

  if (out.includes('"/style.css"') || out.includes("'/app.js'")) {
    throw new Error('改写后仍残留根绝对路径，Pages 子路径下会 404');
  }
  return out;
}

export function robotsText({ baseUrl = PAGES_BASE_URL } = {}) {
  const projectPath = new URL(baseUrl).pathname;
  return [
    'User-agent: *',
    `Allow: ${projectPath}`,
    `Sitemap: ${new URL('sitemap.xml', baseUrl).href}`,
    '',
  ].join('\n');
}

function escapeXml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function sitemapXml({
  baseUrl = PAGES_BASE_URL,
  routes = SITEMAP_ROUTES,
} = {}) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...routes.map((route) => `  <url><loc>${escapeXml(new URL(route, baseUrl).href)}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');
}

function copyDir(from, to, { filter = () => true } = {}) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (!filter(src, entry)) continue;
    if (entry.isDirectory()) copyDir(src, dst, { filter });
    else fs.copyFileSync(src, dst);
  }
}

/**
 * @param {{outDir?:string, repo?:string}} [opts]
 * @returns {{outDir:string, files:string[]}}
 */
export function buildSite({ outDir = path.join(REPO, '_site'), repo = REPO } = {}) {
  const siteDir = path.join(repo, 'site');
  const webDir = path.join(repo, 'src', 'web');
  const libDir = path.join(repo, 'src', 'lib');

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 1. 站点自有资源（site/demo 单独处理，避免它落到根上）
  copyDir(siteDir, outDir, { filter: (src) => path.basename(src) !== 'demo' });

  // 2. 产品前端原样进 demo/
  const demoOut = path.join(outDir, 'demo');
  copyDir(webDir, demoOut);

  // 3. demo 自有脚本（垫片、假 manager、控制栏）
  copyDir(path.join(siteDir, 'demo'), demoOut);

  // 4. 借用的纯内核模块
  const libOut = path.join(demoOut, 'lib');
  fs.mkdirSync(libOut, { recursive: true });
  for (const name of BORROWED_LIB) {
    fs.copyFileSync(path.join(libDir, name), path.join(libOut, name));
  }

  // 5. 唯一的内容改写
  const indexPath = path.join(demoOut, 'index.html');
  fs.writeFileSync(indexPath, rewriteDemoHtml(fs.readFileSync(indexPath, 'utf8')));

  // 6. 爬虫入口固定生成，不带构建时钟，重复构建逐字一致
  fs.writeFileSync(path.join(outDir, 'robots.txt'), robotsText());
  fs.writeFileSync(path.join(outDir, 'sitemap.xml'), sitemapXml());

  // Pages 不跑 Jekyll，但下划线目录的历史坑太深，留个护栏
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');

  const missing = REQUIRED_OUTPUTS.filter((rel) => !fs.existsSync(path.join(outDir, rel)));
  if (missing.length > 0) throw new Error(`构建产物缺文件：${missing.join(', ')}`);

  return { outDir, files: listFiles(outDir).map((f) => path.relative(outDir, f)) };
}

export function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

// ── 本地静态服务（site:dev / demo 冒烟共用） ───────────────────────────────

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // 站点目前只有 .js，但 MIME 给错时浏览器是「静默拒绝执行模块」，留着省一次排查
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
});

export function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 把 URL 路径解析成 root 下的真实文件；越界（`..`）一律拒绝。
 * @returns {string|null}
 */
export function resolveStatic(root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  const full = path.join(root, rel);
  const resolved = path.resolve(full);
  if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) return null;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const index = path.join(resolved, 'index.html');
    return fs.existsSync(index) ? index : null;
  }
  return fs.existsSync(resolved) ? resolved : null;
}

export function serveStatic(root, { port = 0, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    const file = resolveStatic(root, req.url ?? '/');
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        server,
        port: server.address().port,
        origin: `http://${host}:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(`--${n}`);
  const opt = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? d : argv[i + 1];
  };

  const outDir = path.resolve(opt('out', path.join(REPO, '_site')));
  const { files } = buildSite({ outDir });
  process.stdout.write(`站点已构建：${path.relative(REPO, outDir) || outDir}（${files.length} 个文件）\n`);

  if (!flag('serve')) return;
  const srv = await serveStatic(outDir, { port: Number(opt('port', 0)) });
  process.stdout.write(`\n本地预览：${srv.origin}/\n      demo：${srv.origin}/demo/\n\nCtrl-C 结束。\n`);
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`站点构建失败：${err.message}\n`);
    process.exit(1);
  });
}
