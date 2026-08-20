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
  BORROWED_LIB, REQUIRED_OUTPUTS, contentType, resolveStatic, rewriteDemoHtml,
} from '../scripts/build-site.mjs';
import {
  codeChunks, localHtmlTargets, localMarkdownTargets, mentionedCommands, unknownCommands,
} from '../scripts/site-check.mjs';
import { COMMANDS } from '../src/cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  for (const must of ['index.html', 'demo/index.html', 'demo/demo-shim.js', 'mock-dsh-web/index.html', '.nojekyll']) {
    assert.ok(REQUIRED_OUTPUTS.includes(must), `产物清单漏了 ${must}`);
  }
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
