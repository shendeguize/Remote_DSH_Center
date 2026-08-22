/**
 * 本机 shell 垫片：接收 localExec 的 `-c <raw proto body>` argv，并把原始协议脚本交给
 * fake-ssh 导出的单一协议 dispatcher。不会另行解释或复制协议处理逻辑。
 */

import { dispatchProtocol } from './fake-ssh.js';

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== '-c') {
  process.stderr.write(`fake-local-sh: 期望 -c <协议脚本>，实际 ${JSON.stringify(argv)}\n`);
  process.exit(250);
}

const host = process.env.DSHC_HARNESS_LOCAL_HOST;
if (!host) {
  process.stderr.write('fake-local-sh: DSHC_HARNESS_LOCAL_HOST 未设置\n');
  process.exit(250);
}

const home = process.env.HOME;
if (!home) {
  process.stderr.write('fake-local-sh: HOME 未设置\n');
  process.exit(250);
}

dispatchProtocol(host, argv[1], { home, transport: 'local' });
