import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInstallGuide } from '../../src/web/install-guide.js';

test('嗅探命中但非交互 PATH 缺 dsh：给出路径暴露指引', () => {
  const guide = buildInstallGuide({
    local: false,
    noDshReason: 'missing-bin',
    sniff: {
      paths: ['/root/.canon/node/bin/dsh', '/usr/local/bin/dsh'],
      loginPath: '/root/.canon/node/bin/dsh',
      probePath: '/usr/local/bin:/usr/bin',
    },
  });

  assert.match(guide.summary, /远端非交互环境/);
  assert.match(guide.summary, /\/root\/\.canon\/node\/bin\/dsh/);
  assert.match(guide.steps[1], /\/usr\/local\/bin/);
  assert.match(guide.steps[1], /\.bashrc/);
});

test('未命中 dsh：给出官方文档与 web profile 指引', () => {
  const guide = buildInstallGuide({
    local: true,
    noDshReason: 'missing-bin',
  });

  assert.match(guide.summary, /本机/);
  assert.match(guide.steps[0], /官方安装文档/);
  assert.match(guide.steps[1], /web profile/);
  assert.match(guide.steps[1], /非交互 SSH/);
});

test('缺 web profile：给出惰性初始化与可选 pnpm 前置', () => {
  const guide = buildInstallGuide({
    local: false,
    noDshReason: 'no-web-profile',
    dshHome: '/root/.dsh',
  });

  assert.match(guide.summary, /\/root\/\.dsh\/profiles\/web/);
  assert.match(guide.steps[0], /dsh plugin --profile web list/);
  assert.match(guide.steps[1], /仅当需要管理 profile 插件时/);
  assert.match(guide.steps[1], /pnpm/);
});

test('未知或缺失原因安全回退到安装指引', () => {
  const guide = buildInstallGuide();
  assert.equal(guide.steps.length, 3);
  assert.match(guide.steps[0], /Center 不会代为安装/);
});

test('安装指引按探测结果列出二进制/profile/可选依赖，并只提供复制命令', () => {
  const guide = buildInstallGuide({
    noDshReason: 'no-web-profile',
    dshHome: '/root/.dsh',
    dependencies: { binary: true, webProfile: false, bash: false, timeout: true },
  });
  assert.deepEqual(guide.checks.map(({ id, status }) => [id, status]), [
    ['binary', 'pass'],
    ['web-profile', 'fail'],
    ['bash', 'optional'],
    ['timeout', 'pass'],
  ]);
  assert.ok(guide.checks.every((check) => check.commands.length > 0));
  assert.doesNotMatch(JSON.stringify(guide), /npm install|brew install|curl .*install/);
});
