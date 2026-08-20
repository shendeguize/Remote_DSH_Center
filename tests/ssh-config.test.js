import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseSshConfig, loadHosts } from '../src/ssh-config.js';

test('基本 Host 块解析出 hostName/user/port', () => {
  const hosts = parseSshConfig(`
Host gpu-1
  HostName 10.10.16.112
  User root
  Port 5141
`);
  assert.deepEqual(hosts, [{ name: 'gpu-1', hostName: '10.10.16.112', user: 'root', port: 5141 }]);
});

test('一行多主机名：属性写入全部', () => {
  const hosts = parseSshConfig('Host a b\n  User root\n');
  assert.deepEqual(hosts, [
    { name: 'a', user: 'root' },
    { name: 'b', user: 'root' },
  ]);
});

test('含 * ? ! 的 pattern 剔除', () => {
  const hosts = parseSshConfig(`
Host *
  User default
Host gpu-?
  User x
Host !bad
  User y
Host real
  User root
`);
  assert.deepEqual(hosts.map((h) => h.name), ['real']);
  assert.equal(hosts[0].user, 'root');
});

test('通配 Host 块内的属性不泄漏到后续主机', () => {
  const hosts = parseSshConfig('Host *\n  User wildcard\nHost real\n  HostName h\n');
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].user, undefined);
});

test('键大小写不敏感、Key=value 形式、注释与空行', () => {
  const hosts = parseSshConfig(`
# comment
HOST gpu-1

  hostname=10.0.0.1
  USER   root
  port=22
`);
  assert.deepEqual(hosts, [{ name: 'gpu-1', hostName: '10.0.0.1', user: 'root', port: 22 }]);
});

test('同名后写覆盖', () => {
  const hosts = parseSshConfig('Host a\n HostName first\nHost a\n HostName second\n User root\n');
  assert.equal(hosts.length, 1);
  assert.deepEqual(hosts[0], { name: 'a', hostName: 'second', user: 'root' });
});

test('CRLF 与行首空白容错', () => {
  const hosts = parseSshConfig('Host a\r\n\tHostName h\r\n    User u\r\n');
  assert.deepEqual(hosts, [{ name: 'a', hostName: 'h', user: 'u' }]);
});

test('非法 Port 被忽略而非写入错值', () => {
  const hosts = parseSshConfig('Host a\n Port notanumber\nHost b\n Port 99999\n');
  assert.equal(hosts[0].port, undefined);
  assert.equal(hosts[1].port, undefined);
});

test('Match 块整块跳过，不归属任何 Host', () => {
  const hosts = parseSshConfig('Host a\n User root\nMatch host b\n User leak\n');
  assert.deepEqual(hosts, [{ name: 'a', user: 'root' }]);
});

test('空输入与 null 输入返回空数组', () => {
  assert.deepEqual(parseSshConfig(''), []);
  assert.deepEqual(parseSshConfig(null), []);
});

test('loadHosts 展开 Include（glob）并防环路', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sshcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(dir, 'conf.d'));
  fs.writeFileSync(
    path.join(dir, 'config'),
    'Host base\n User root\nInclude conf.d/*.conf\nHost after\n User u\n',
  );
  fs.writeFileSync(path.join(dir, 'conf.d', 'a.conf'), 'Host inc-a\n HostName ha\n');
  fs.writeFileSync(path.join(dir, 'conf.d', 'b.conf'), 'Host inc-b\n HostName hb\n');
  fs.writeFileSync(path.join(dir, 'conf.d', 'ignored.txt'), 'Host nope\n');

  const hosts = loadHosts({ configPath: path.join(dir, 'config') });
  assert.deepEqual(hosts.map((h) => h.name).sort(), ['after', 'base', 'inc-a', 'inc-b']);
});

test('loadHosts 环路 Include 不死循环', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sshcfg-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'config'), 'Host a\nInclude other\n');
  fs.writeFileSync(path.join(dir, 'other'), 'Host b\nInclude config\n');

  const hosts = loadHosts({ configPath: path.join(dir, 'config') });
  assert.deepEqual(hosts.map((h) => h.name).sort(), ['a', 'b']);
});

test('loadHosts 对缺失文件返回空数组而非抛错', () => {
  assert.deepEqual(loadHosts({ configPath: '/nonexistent/dshc/config' }), []);
});

test('Include 内属性归属正确（不与父文件块串味）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sshcfg-attr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'config'), 'Host parent\nInclude child\n  User leaked\n');
  fs.writeFileSync(path.join(dir, 'child'), 'Host kid\n User kiduser\n');

  const hosts = loadHosts({ configPath: path.join(dir, 'config') });
  const byName = Object.fromEntries(hosts.map((h) => [h.name, h]));
  assert.equal(byName.kid.user, 'kiduser');
  assert.equal(byName.parent.user, undefined, 'Include 之后的属性不再属于 Include 之前的 Host 块');
});
