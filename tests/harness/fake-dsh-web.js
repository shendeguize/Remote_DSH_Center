/**
 * 假 dsh web（14 §1.3）：`node fake-dsh-web.js --port N [--die-after MS]`。
 *
 * 行为对齐真机实测事实（README 可行性结论 1）：
 * - 绑定成功后 stdout 输出 `dsh web: http://127.0.0.1:<port>`（可被 POLL 协议解析）
 * - 绑定失败输出 EADDRINUSE 文案并退出（驱动拉起降级路径）
 * - `/` 返回 200 极简页；供隧道转发目标与 monitor TCP 探活使用
 */

import http from 'node:http';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const port = Number(flag('port', '0'));
const dieAfter = flag('die-after') === null ? null : Number(flag('die-after'));
const label = flag('label', 'fake-dsh-web');
const forceBindError = argv.includes('--force-bind-error');
const failStart = argv.includes('--fail-start');

if (forceBindError) {
  // 端口占用故障注入（scenario bind-busy-*）：文案与真 node 栈一致，POLL 的 BIND_ERR 据此判定
  process.stdout.write(`Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n`);
  process.exit(1);
}
if (failStart) {
  // 真崩溃故障注入：无 URL、无 BIND_ERR，进程直接消失 → 驱动 12 §3 的 S2 'dead' 快败
  process.stdout.write('fatal: failed to load web profile\n');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, label }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${label}</title><h1>${label}</h1>`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // 真 dsh 的 node 栈同样以此文案报错，POLL 协议的 BIND_ERR 判据依赖它
    process.stdout.write(`Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n`);
    process.exit(1);
  }
  process.stdout.write(`Error: ${err.message}\n`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  process.stdout.write(`dsh web: http://127.0.0.1:${actual}\n`);
  if (dieAfter !== null) {
    setTimeout(() => {
      process.stdout.write('fatal: dsh web exited unexpectedly\n');
      process.exit(3);
    }, dieAfter);
  }
});

process.on('SIGTERM', () => {
  process.stdout.write('received SIGTERM, shutting down\n');
  process.exit(0);
});
