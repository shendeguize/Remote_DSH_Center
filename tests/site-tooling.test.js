/**
 * 站点构建与文档闸门的纯逻辑（PG-13 的自证部分）。
 *
 * 这一关的存在意义是「拦住 README 里写错的命令和站点里断掉的链接」，
 * 所以它自己必须被证明真能拦——一个只会说「通过」的检查器比没有检查更糟。
 * 下面既验真阳（错命令/坏链接必须被抓到），也验假阴（正文里的散句不许误报）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BORROWED_LIB, REQUIRED_OUTPUTS, SITEMAP_ROUTES, buildSite,
  contentType, resolveStatic, rewriteDemoHtml, robotsText, sitemapXml,
} from '../scripts/build-site.mjs';
import {
  README_SECTION_MAP, checkDocs, codeChunks, compareBilingualStructure,
  extractLevel2Headings, localHtmlTargets, localMarkdownTargets, mentionedCommands,
  unknownCommands, waitUntil,
} from '../scripts/site-check.mjs';
import { COMMANDS } from '../src/cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PAGES_BASE_URL = 'https://shendeguize.github.io/Remote_DSH_Center/';

// ── build-site：唯一的内容改写 ────────────────────────────────────────────

test('rewriteDemoHtml：根绝对路径全改相对，启动脚本换成「先装垫片再启动」', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'web', 'index.html'), 'utf8');
  const out = rewriteDemoHtml(src);

  assert.match(out, /href="\.\/style\.css"/);
  assert.match(out, /href="\.\/favicon\.svg"/);
  assert.match(out, /href="\.\/demo\.css"/);
  assert.ok(!out.includes('"/style.css"'), 'Pages 子路径下根绝对路径会 404');

  const shimAt = out.indexOf('installDemo');
  const bootAt = out.indexOf('bootApp()');
  assert.ok(shimAt !== -1 && bootAt !== -1);
  assert.ok(shimAt < bootAt, '垫片必须在 bootApp 之前——否则首个 fetch 会打到真 /api');
});

test('rewriteDemoHtml：前端启动脚本形状变了就当场抛错，不许静默产出空白页', () => {
  let message = '';
  try {
    rewriteDemoHtml('<html><head></head><body></body></html>');
    assert.fail('形状不对却没抛错');
  } catch (err) {
    message = err.message;
  }
  assert.match(message, /启动脚本形状变了/);
});

test('借用进 demo 的内核模块必须是浏览器安全的：只许 import 同目录的纯模块', () => {
  for (const name of BORROWED_LIB) {
    const code = fs.readFileSync(path.join(ROOT, 'src', 'lib', name), 'utf8');
    const imports = [...code.matchAll(/^import .*? from '([^']+)';$/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(spec.startsWith('./'), `${name} 依赖了 ${spec}，搬到浏览器里会炸`);
      assert.ok(
        BORROWED_LIB.includes(path.basename(spec)),
        `${name} 依赖的 ${spec} 不在 BORROWED_LIB 里，构建产物会缺文件`,
      );
    }
    assert.ok(!/require\(|node:/.test(code), `${name} 用到了 Node 专有 API，不能借给 demo`);
  }
});

test('REQUIRED_OUTPUTS 覆盖三类关键产物，缺一个就说明拷漏了', () => {
  for (const must of [
    'index.html', 'demo/index.html', 'demo/demo-shim.js', 'mock-dsh-web/index.html',
    'assets/shots/dashboard.png', 'robots.txt', 'sitemap.xml', '.nojekyll',
  ]) {
    assert.ok(REQUIRED_OUTPUTS.includes(must), `产物清单漏了 ${must}`);
  }
});

test('robots 与 sitemap 内容固定、无时间戳，并只列构建出的 HTML 路由', (t) => {
  const expectedRobots = [
    'User-agent: *',
    'Allow: /Remote_DSH_Center/',
    'Sitemap: https://shendeguize.github.io/Remote_DSH_Center/sitemap.xml',
    '',
  ].join('\n');
  const expectedSitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url><loc>https://shendeguize.github.io/Remote_DSH_Center/</loc></url>',
    '  <url><loc>https://shendeguize.github.io/Remote_DSH_Center/demo/</loc></url>',
    '</urlset>',
    '',
  ].join('\n');

  assert.equal(robotsText(), expectedRobots);
  assert.equal(robotsText(), expectedRobots, '同一输入每次必须逐字一致');
  assert.equal(sitemapXml(), expectedSitemap);
  assert.equal(sitemapXml(), expectedSitemap, '同一输入每次必须逐字一致');
  assert.doesNotMatch(expectedSitemap, /lastmod|<changefreq>|<priority>/);
  assert.match(
    sitemapXml({ baseUrl: 'https://example.test/root/', routes: ['?a=1&b=2'] }),
    /<loc>https:\/\/example\.test\/root\/\?a=1&amp;b=2<\/loc>/,
    'URL 进入 XML 前必须转义',
  );

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-site-build-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const { files } = buildSite({ outDir });

  assert.ok(files.includes('robots.txt'));
  assert.ok(files.includes('sitemap.xml'));
  assert.equal(fs.readFileSync(path.join(outDir, 'robots.txt'), 'utf8'), expectedRobots);
  assert.equal(fs.readFileSync(path.join(outDir, 'sitemap.xml'), 'utf8'), expectedSitemap);

  const basePath = new URL(EXPECTED_PAGES_BASE_URL).pathname;
  const sitemapUrls = [...expectedSitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(sitemapUrls.length, SITEMAP_ROUTES.length);
  for (const urlText of sitemapUrls) {
    const pathname = new URL(urlText).pathname;
    assert.ok(pathname.startsWith(basePath), `${urlText} 不在 canonical Pages 根下`);
    const route = pathname.slice(basePath.length);
    const output = route === '' || route.endsWith('/') ? `${route}index.html` : route;
    assert.ok(files.includes(output), `${urlText} 没有对应的 HTML 产物 ${output}`);
  }
});

test('landing head 提供 canonical、Open Graph 与 Twitter 的完整绝对元数据', () => {
  const html = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');
  const title = 'DSH Center —— 把散在各台远端的 dsh web 收进一个页面';
  const description = '本机一个小服务 + 一个 CLI：经 ssh -L 隧道把远端 dsh web 映射到本机，用 iframe 标签页单入口打开，拉起/关停/重连/日志都在一处。零 npm 依赖、远端零常驻。';
  const image = 'https://shendeguize.github.io/Remote_DSH_Center/assets/shots/dashboard.png';

  for (const tag of [
    '<link rel="canonical" href="https://shendeguize.github.io/Remote_DSH_Center/">',
    '<meta name="robots" content="index,follow">',
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    '<meta property="og:url" content="https://shendeguize.github.io/Remote_DSH_Center/">',
    `<meta property="og:image" content="${image}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${image}">`,
  ]) {
    assert.ok(html.includes(tag), `landing head 缺少：${tag}`);
  }
  assert.ok(
    fs.existsSync(path.join(ROOT, 'site', 'assets', 'shots', 'dashboard.png')),
    '分享图必须是会随 site/ 一起复制的既有截图',
  );
});

test('resolveStatic：目录补 index.html，越界路径一律拒掉', (t) => {
  // 用系统临时目录（与其余测试一致）：写进仓库里的 .local/tmp 要求那个目录先存在，
  // 于是只在跑过 ui-smoke 的开发机上过，全新 checkout 上必炸。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-site-static-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), 'root');
  fs.writeFileSync(path.join(dir, 'demo', 'index.html'), 'demo');

  assert.equal(resolveStatic(dir, '/'), path.join(dir, 'index.html'));
  assert.equal(resolveStatic(dir, '/demo/'), path.join(dir, 'demo', 'index.html'));
  assert.equal(resolveStatic(dir, '/demo'), path.join(dir, 'demo', 'index.html'));
  assert.equal(resolveStatic(dir, '/nope.js'), null);
  assert.equal(resolveStatic(dir, '/../../etc/passwd'), null, '穿目录必须拒');
});

test('contentType：ESM 与 CSS 必须给对 MIME，否则浏览器拒绝执行模块', () => {
  assert.match(contentType('a.js'), /javascript/);
  assert.match(contentType('a.mjs'), /javascript/);
  assert.match(contentType('a.css'), /text\/css/);
  assert.match(contentType('a.html'), /text\/html/);
  assert.match(contentType('a.svg'), /image\/svg/);
  assert.match(contentType('a.unknown'), /octet-stream/);
});

// ── site-check：命令核对 ─────────────────────────────────────────────────

test('extractLevel2Headings：认 ATX 二级标题与 closing markers，忽略两类围栏里的假标题', () => {
  const headings = extractLevel2Headings([
    '## 可见一 ##',
    '```markdown',
    '## 反引号围栏里的假标题',
    '```',
    '~~~ md',
    '## 波浪号围栏里的假标题 ##',
    '~~~~',
    '  ## 可见二 ####  ',
    '### 三级不算',
  ].join('\n'));
  assert.deepEqual(headings, ['可见一', '可见二']);
});

test('extractLevel2Headings：反引号 info 含反引号不成围栏，关闭符须同类且不短于开启符', () => {
  assert.deepEqual(
    extractLevel2Headings([
      '```markdown`bad',
      '## 非法开启符不能藏掉我',
    ].join('\n')),
    ['非法开启符不能藏掉我'],
  );

  assert.deepEqual(
    extractLevel2Headings([
      '````markdown',
      '## 四反引号内',
      '```',
      '## 短反引号不能关闭',
      '~~~~',
      '## 波浪号不能关闭',
      '`````',
      '## 同类且足够长才关闭',
      '~~~~ markdown',
      '## 四波浪号内',
      '```',
      '## 反引号不能关闭波浪号',
      '~~~',
      '## 短波浪号不能关闭',
      '~~~~~',
      '## 波浪号关闭后可见',
    ].join('\n')),
    ['同类且足够长才关闭', '波浪号关闭后可见'],
  );
});

test('extractLevel2Headings：只有 closing markers 的 H2 归一为空标题', () => {
  const headings = extractLevel2Headings('## ###');
  assert.deepEqual(headings, ['']);

  const zh = README_SECTION_MAP.map((pair) => pair.zh);
  const en = README_SECTION_MAP.map((pair) => pair.en);
  zh[2] = headings[0];
  const message = compareBilingualStructure(zh, en).join('\n');
  assert.match(message, /README\.md.*空.*标题/);
  assert.match(message, /README\.md.*缺少.*支持矩阵/);
  assert.doesNotMatch(message, /## ###/);
});

test('双语 README 当前二级结构与显式映射逐节一致', () => {
  const zh = extractLevel2Headings(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
  const en = extractLevel2Headings(fs.readFileSync(path.join(ROOT, 'README.en.md'), 'utf8'));
  assert.equal(zh.length, README_SECTION_MAP.length, '中文章节数应由映射表约束');
  assert.equal(en.length, README_SECTION_MAP.length, '英文章节数应由映射表约束');
  assert.deepEqual(compareBilingualStructure(zh, en), []);
});

test('compareBilingualStructure 清楚区分缺失、额外、乱序、重复与改名', () => {
  const zh = README_SECTION_MAP.map((pair) => pair.zh);
  const en = README_SECTION_MAP.map((pair) => pair.en);

  const missing = zh.filter((_, i) => i !== 2);
  assert.match(compareBilingualStructure(missing, en).join('\n'), /README\.md.*缺少.*支持矩阵/);

  const extra = [...en, 'Appendix'];
  assert.match(compareBilingualStructure(zh, extra).join('\n'), /README\.en\.md.*额外.*Appendix/);

  const reordered = [...zh];
  [reordered[3], reordered[4]] = [reordered[4], reordered[3]];
  assert.match(compareBilingualStructure(reordered, en).join('\n'), /README\.md.*顺序/);

  const duplicate = [...en];
  duplicate.splice(4, 0, en[3]);
  assert.match(compareBilingualStructure(zh, duplicate).join('\n'), /README\.en\.md.*重复.*Install/);

  const renamed = [...en];
  renamed[3] = 'Installation';
  assert.match(
    compareBilingualStructure(zh, renamed).join('\n'),
    /README\.en\.md.*改名.*Install.*Installation/,
  );
});

test('checkDocs 真正接入双语结构比较，注入畸形 README 会返回结构问题', (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-docs-gate-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outDir, 'index.html'), '<!doctype html><title>fixture</title>');

  const zh = README_SECTION_MAP.map((pair) => pair.zh);
  [zh[3], zh[4]] = [zh[4], zh[3]];
  const fixtures = {
    'README.md': zh.map((heading) => `## ${heading}`).join('\n\n'),
    'README.en.md': README_SECTION_MAP.map((pair) => `## ${pair.en}`).join('\n\n'),
  };
  const result = checkDocs(outDir, { readReadme: (name) => fixtures[name] });

  assert.equal(result.htmlFiles, 1);
  assert.match(result.problems.join('\n'), /README\.md.*顺序不一致/);
});

test('codeChunks 只取代码位：围栏块与行内 span，正文散句不算', () => {
  const chunks = codeChunks([
    '正文里提到 dshc nonsense 这种散句',
    '',
    '```bash',
    'dshc up',
    '```',
    '',
    '行内的 `dshc down` 也算。',
  ].join('\n'));
  const joined = chunks.join('\n');
  assert.match(joined, /dshc up/);
  assert.match(joined, /dshc down/);
  assert.ok(!joined.includes('nonsense'), '正文散句混进来就会产生假警报');
});

test('mentionedCommands：认清单写法、只取命令头、忽略行尾注释', () => {
  const found = mentionedCommands([
    '```bash',
    'dshc init / up / down / service install|uninstall|status',
    "dshc config set hosts.gpu-1.workdir '~/projects/foo'",
    'node ~/.dsh_center/app/scripts/install.mjs --uninstall   # 摘掉 PATH 里的 dshc 软链',
    '```',
  ].join('\n'));

  assert.ok(found.includes('init') && found.includes('up') && found.includes('down'));
  assert.ok(found.includes('service install') && found.includes('service uninstall') && found.includes('service status'));
  assert.ok(found.includes('config set'), '二级子命令要成对识别');
  assert.ok(!found.includes('hosts.gpu-1.workdir'), '参数不是命令名');
  assert.ok(!found.some((c) => c.includes('软链')), '行尾注释里的句子不是命令');
});

test('unknownCommands：真写错了就必须抓到，写对了不许误报', () => {
  assert.deepEqual(unknownCommands(['up', 'service install', 'config get']), []);
  assert.deepEqual(unknownCommands(['nonexistent']), ['nonexistent']);
  assert.deepEqual(unknownCommands(['service nonexistent']), ['service nonexistent'], '二级子命令写错也要抓');
});

test('闸门对真 README 的判定：命令全真（顺带确认它扫到了东西，不是空转）', () => {
  for (const name of ['README.md', 'README.en.md']) {
    const text = fs.readFileSync(path.join(ROOT, name), 'utf8');
    const mentions = mentionedCommands(text);
    assert.ok(mentions.length >= 5, `${name} 只扫出 ${mentions.length} 条命令，闸门恐怕在空转`);
    assert.deepEqual(unknownCommands(mentions), [], `${name} 提到了不存在的命令`);
    // 反向确认：CLI 的主力命令确实都在文档里露过面
    for (const cmd of ['init', 'up', 'open', 'status']) {
      assert.ok(Object.keys(COMMANDS).includes(cmd));
      assert.ok(mentions.includes(cmd), `${name} 没提到 ${cmd}`);
    }
  }
});

/**
 * 回归（issue #79）：demo 冒烟里「mock 页有没有被 iframe 载入」原先是一次性判定——
 * iframe 元素建出来那一刻，它的网络响应往往还没回来。本机快，CI 上偶发红。
 * 这类判据必须是「等到」，不是「此刻」。
 */
test('waitUntil：条件后来才成立也算过，超时要把判据名带在错误里', async () => {
  let hits = 0;
  const late = () => { hits += 1; return hits >= 3; };
  await waitUntil(late, 'mock 页载入', { timeoutMs: 1_000, stepMs: 10 });
  assert.equal(hits, 3, '要真的重试到成立，而不是第一次不成立就放过');

  await assert.rejects(
    () => waitUntil(() => false, 'mock 页载入', { timeoutMs: 60, stepMs: 10 }),
    (e) => {
      assert.match(e.message, /mock 页载入/, `错误里要点明等的是什么：${e.message}`);
      return true;
    },
  );
});

// ── site-check：链接抽取 ─────────────────────────────────────────────────

test('localMarkdownTargets：只要本地目标，外链与纯锚点跳过', () => {
  const targets = localMarkdownTargets([
    '[英文](README.en.md) [外链](https://example.com) [锚](#faq)',
    '![截图](site/assets/shots/dashboard.png "标题")',
    '[邮件](mailto:a@b.c)',
  ].join('\n'));
  assert.deepEqual(targets, ['README.en.md', 'site/assets/shots/dashboard.png']);
});

test('localHtmlTargets：href/src 都要，data: 与外链跳过', () => {
  const targets = localHtmlTargets([
    '<link rel="stylesheet" href="./landing.css">',
    '<img src="data:image/svg+xml,x">',
    '<a href="https://github.com/x">gh</a>',
    '<script src="./landing.js"></script>',
  ].join('\n'));
  assert.deepEqual(targets, ['./landing.css', './landing.js']);
});

test('双语 README 顶部必须互链，且指向的文件真在', () => {
  const pairs = [['README.md', 'README.en.md'], ['README.en.md', 'README.md']];
  for (const [from, to] of pairs) {
    const head = fs.readFileSync(path.join(ROOT, from), 'utf8').split('\n').slice(0, 12).join('\n');
    assert.ok(head.includes(to), `${from} 顶部没有指向 ${to} 的链接`);
    assert.ok(fs.existsSync(path.join(ROOT, to)));
  }
});
