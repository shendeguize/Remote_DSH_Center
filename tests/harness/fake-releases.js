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
 * 打一个最小但结构齐全的 bundle tar.gz（bin/dshc + runtime/bin/node + app/ + BUNDLE_INFO.json）。
 * @returns {{name:string, bytes:Buffer, dirName:string}}
 */
export function makeBundleTarball({ version, arch, nodeVersion = '22.0.0', workDir }) {
  const dirName = bundleDirName({ version, arch });
  const stage = fs.mkdtempSync(path.join(workDir ?? os.tmpdir(), 'dshc-mkbundle-'));
  const root = path.join(stage, dirName);

  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'bin', 'dshc'),
    '#!/bin/sh\nDIR="$(cd "$(dirname "$0")/.." && pwd)"\nexec "$DIR/runtime/bin/node" "$DIR/app/src/cli.js" "$@"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(root, 'runtime', 'bin', 'node'), '#!/bin/sh\necho fake-node\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'app', 'package.json'), `${JSON.stringify({ name: 'dsh-center', version }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'app', 'src', 'cli.js'), '// 占位\n');
  fs.writeFileSync(
    path.join(root, BUNDLE_INFO_FILE),
    `${JSON.stringify({ version, arch, tag: `v${version}`, nodeVersion, builtAt: '2026-08-21T00:00:00Z' }, null, 2)}\n`,
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
export async function startFakeReleases(releases, { workDir } = {}) {
  const built = releases.map((r) => {
    const arch = r.arch ?? 'arm64';
    const assets = r.assets
      ?? [(({ name, bytes }) => ({ name, bytes }))(makeBundleTarball({ version: r.version, arch, workDir }))];
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

    if (url.pathname.endsWith('/releases')) {
      const body = built.map((r) => ({
        tag_name: r.tag,
        prerelease: r.prerelease,
        draft: r.draft,
        assets: [...r.files.keys()].map((name) => ({ name })),
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
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
