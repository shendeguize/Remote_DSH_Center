/**
 * fake-scp 垫片（14 §1.1）：argv 形态为 [...COMMON_SSH_OPTS, '--', local, host:remoteRel]，
 * 把文件内容落进假远端的 files 表，供 patch 同步断言。
 */

import fs from 'node:fs';

import { host as hostState, mutate, readState } from './state.js';

const argv = process.argv.slice(2);
const sepIndex = argv.indexOf('--');
if (sepIndex === -1 || argv.length < sepIndex + 3) {
  process.stderr.write('fake-scp: argv 形状不符（缺 -- local host:remote）\n');
  process.exit(250);
}

const localPath = argv[sepIndex + 1];
const target = argv[sepIndex + 2];
const m = /^([^:]+):(.+)$/.exec(target);
if (!m) {
  process.stderr.write(`fake-scp: 无法解析目标 ${target}\n`);
  process.exit(250);
}
const [, name, remoteRel] = m;

const st = readState();
const h = hostState({ hosts: st.hosts ?? {} }, name);
if (!h.reachable || h.faults.hostkeyFail) {
  process.stderr.write(`ssh: connect to host ${name} port 22: Operation timed out\n`);
  process.exit(255);
}
if (h.faults.scpFail) {
  process.stderr.write(`scp: ${remoteRel}: Permission denied\n`);
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(localPath, 'utf8');
} catch (err) {
  process.stderr.write(`scp: ${localPath}: ${err.code}\n`);
  process.exit(1);
}

mutate((state) => {
  hostState(state, name).files[remoteRel] = content;
});
