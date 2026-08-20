/**
 * 假 GitHub Releases 服务（bundle 通道的更新与安装测试用）。
 *
 * 更新链路的价值全在「网那头给什么，本机就该怎么反应」——尤其是校验和不符时
 * 必须拒绝落盘。真连 GitHub 既慢又不可复现，所以在 127.0.0.1 上起一个只讲
 * 三件事的服务：Release 列表、附件、SHA256SUMS。
 *
 * 附件本体是真的 tar.gz（用系统 tar 打的最小 bundle 骨架），所以解包与换目录
 * 那段也是真跑，不是假的。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { BUNDLE_INFO_FILE, SUMS_FILE, assetName, bundleDirName, formatSums } from '../../src/lib/bundle.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 打一个结构齐全的 bundle tar.gz（bin/dshc + runtime/bin/node + app/ + BUNDLE_INFO.json）。
 *
 * 默认里面是占位内容（更新逻辑的测试只关心「换没换对目录」）。给了 `appSource` 与
 * `nodeExec` 就变成**真能跑**的包：app/ 是真 src + install.mjs，runtime/bin/node 转发到
 * 真 node——install.sh 的 standalone 端到端测试要靠这个，否则「装完能不能跑」证不了。
 *
 * @param {object} opts
 * @param {string} [opts.appSource] 仓库根：拷 `src/` 与 `scripts/install.mjs` 进 app/
 * @param {string} [opts.nodeExec]  真 node 的路径：runtime/bin/node 转发到它
 * @returns {{name:string, bytes:Buffer, dirName:string}}
 */
export function makeBundleTarball({
  version, arch, nodeVersion = '22.0.0', workDir, appSource = null, nodeExec = null,
}) {
  const dirName = bundleDirName({ version, arch });
  const stage = fs.mkdtempSync(path.join(workDir ?? os.tmpdir(), 'dshc-mkbundle-'));
  const root = path.join(stage, dirName);

  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });

  // 与 scripts/build-bundle.mjs 的 shimScript() 同形：必须自己解软链，
  // 否则经 ~/.local/bin/dshc 调用时会把包根算到 ~/.local
  fs.writeFileSync(
    path.join(root, 'bin', 'dshc'),
    [
      '#!/bin/sh',
      'set -e',
      'target="$0"',
      'while [ -L "$target" ]; do',
      '  link="$(readlink "$target")"',
      '  case "$link" in',
      '    /*) target="$link" ;;',
      '    *) target="$(dirname "$target")/$link" ;;',
      '  esac',
      'done',
      'DIR="$(cd -- "$(dirname -- "$target")/.." && pwd)"',
      'exec "$DIR/runtime/bin/node" "$DIR/app/src/cli.js" "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  fs.writeFileSync(
    path.join(root, 'runtime', 'bin', 'node'),
    nodeExec ? `#!/bin/sh\nexec ${JSON.stringify(nodeExec)} "$@"\n` : '#!/bin/sh\necho fake-node\n',
    { mode: 0o755 },
  );

  if (appSource) {
    fs.cpSync(path.join(appSource, 'src'), path.join(root, 'app', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'app', 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(appSource, 'scripts', 'install.mjs'), path.join(root, 'app', 'scripts', 'install.mjs'));
    for (const f of ['README.md', 'LICENSE']) {
      fs.copyFileSync(path.join(appSource, f), path.join(root, 'app', f));
    }
    fs.chmodSync(path.join(root, 'app', 'src', 'cli.js'), 0o755);
  } else {
    fs.writeFileSync(path.join(root, 'app', 'src', 'cli.js'), '// 占位\n');
  }
  // type: module 不能漏——真产物里 package.json 是照抄仓库的，漏了会让
  // node 把 src/*.js 当 CommonJS 重解析并打警告
  fs.writeFileSync(
    path.join(root, 'app', 'package.json'),
    `${JSON.stringify({ name: 'dsh-center', version, type: 'module' }, null, 2)}\n`,
  );

  fs.writeFileSync(
    path.join(root, BUNDLE_INFO_FILE),
    `${JSON.stringify({
      version, arch, tag: `v${version}`, platform: 'darwin', nodeVersion, builtAt: '2026-08-21T00:00:00Z',
    }, null, 2)}\n`,
  );

  const tarPath = path.join(stage, 'out.tar.gz');
  execFileSync('tar', ['-czf', tarPath, '-C', stage, dirName]);
  const bytes = fs.readFileSync(tarPath);
  fs.rmSync(stage, { recursive: true, force: true });
  return { name: assetName({ version, arch }), bytes, dirName };
}

/**
 * @param {Array<{version:string, arch?:string, prerelease?:boolean, draft?:boolean,
 *   assets?:Array<{name:string, bytes:Buffer}>, corrupt?:boolean}>} releases
 *   `corrupt: true` 时 SHA256SUMS 里写一个对不上的值——用来验证「校验不过就不装」。
 */
export async function startFakeReleases(releases, { workDir, appSource, nodeExec } = {}) {
  const built = releases.map((r) => {
    const arch = r.arch ?? 'arm64';
    const assets = r.assets
      ?? [(({ name, bytes }) => ({ name, bytes }))(makeBundleTarball({
        version: r.version, arch, workDir, appSource, nodeExec,
      }))];
    const sums = formatSums(assets.map((a) => [a.name, r.corrupt ? 'f'.repeat(64) : sha256(a.bytes)]));
    return {
      tag: `v${r.version}`,
      version: r.version,
      prerelease: r.prerelease ?? false,
      draft: r.draft ?? false,
      files: new Map([...assets.map((a) => [a.name, a.bytes]), [SUMS_FILE, Buffer.from(sums)]]),
    };
  });

  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const url = new URL(req.url, 'http://127.0.0.1');

    const shape = (r) => ({
      tag_name: r.tag,
      prerelease: r.prerelease,
      draft: r.draft,
      assets: [...r.files.keys()].map((name) => ({ name })),
    });

    // GitHub 的 /releases/latest 保证跳过 pre-release 与 draft——install.sh 的
    // 稳定口径就是靠这个语义，假服务得照着实现，否则测的不是真行为
    if (url.pathname.endsWith('/releases/latest')) {
      const stable = built.filter((r) => !r.prerelease && !r.draft).at(-1);
      if (!stable) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"Not Found"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(shape(stable)));
      return;
    }

    if (url.pathname.endsWith('/releases')) {
      // 真 API 按发布时间倒序返回；install.sh 的 --pre 取首条，所以顺序要一致
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([...built].reverse().map(shape)));
      return;
    }

    // /download/<tag>/<name>
    const m = /\/download\/([^/]+)\/(.+)$/.exec(url.pathname);
    const hit = m ? built.find((r) => r.tag === decodeURIComponent(m[1])) : null;
    const file = hit?.files.get(decodeURIComponent(m[2]));
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(file);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    hits,
    releasesUrl: `${base}/repos/fake/repo/releases`,
    assetUrlFor: ({ tag, name }) => `${base}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    sumsUrlFor: ({ tag }) => `${base}/download/${encodeURIComponent(tag)}/${SUMS_FILE}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
