/**
 * manager.log 的自我封顶（issue #81）。
 *
 * 这是个 launchd 下 7×24 跑的常驻进程，日志只追加、从不回收：链路不稳的一台主机
 * 实测约 8MB/天（断联→退避→重连每一拍都记），一年就是几个 G，谁也不会去看一眼。
 * 所以它得自己封顶——而且必须原地截断：日志是被继承的 O_APPEND fd 在写，
 * 改名换文件的话进程还往那个 inode 里写，新文件永远是空的。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LOG_FILE_CAP_BYTES, LOG_FILE_KEEP_BYTES, planTrim, trimLogFile } from '../../src/lib/logfile.js';

function tmpfile(t, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-logfile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'manager.log');
  if (bytes !== undefined) fs.writeFileSync(file, bytes);
  return file;
}

test('planTrim：没到顶不动，到顶了才截，留的是尾巴', () => {
  assert.equal(planTrim(0, { capBytes: 100, keepBytes: 40 }).trim, false);
  assert.equal(planTrim(100, { capBytes: 100, keepBytes: 40 }).trim, false, '刚好到顶还不算超');

  const plan = planTrim(101, { capBytes: 100, keepBytes: 40 });
  assert.equal(plan.trim, true);
  assert.equal(plan.from, 61, '从「总长 − 保留」处开始读，留最后 40 字节');
});

test('planTrim：保留量不许大于上限（配错了也不能截出个更大的文件）', () => {
  const plan = planTrim(1_000, { capBytes: 100, keepBytes: 500 });
  assert.equal(plan.trim, true);
  assert.ok(plan.from >= 500, `保留量被上限压住，实得 from=${plan.from}`);
});

test('出厂上限是有限值且保留量更小：不然这道封顶等于没有', () => {
  assert.ok(Number.isFinite(LOG_FILE_CAP_BYTES) && LOG_FILE_CAP_BYTES > 0);
  assert.ok(LOG_FILE_KEEP_BYTES < LOG_FILE_CAP_BYTES, '保留量必须小于上限');
});

test('trimLogFile：超了就原地截断，留尾巴、补一行说明、inode 不变', (t) => {
  const file = tmpfile(t);
  const lines = [];
  for (let i = 0; i < 2_000; i += 1) lines.push(`2026-08-21T00:00:00.000Z INFO [manager] 第 ${i} 行`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);

  const before = fs.statSync(file);
  const res = trimLogFile(file, { capBytes: 20_000, keepBytes: 4_000 });

  assert.equal(res.trimmed, true);
  const after = fs.statSync(file);
  assert.equal(after.ino, before.ino, '必须原地截断：换了 inode，写日志的那个 fd 就写进孤立文件里了');
  assert.ok(after.size <= 6_000, `截完该在保留量附近，实得 ${after.size}`);

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('第 1999 行'), '最新的那行必须还在');
  assert.ok(!text.includes('第 0 行'), '最老的应该被丢掉');
  assert.match(text.split('\n')[0], /截断|truncat/i, '第一行要说清这里被截过，别让人以为日志从头就长这样');
  assert.match(text.split('\n')[0], /\d/, '说明里要带上丢了多少（字节数）');
  assert.ok(text.endsWith('\n'), '末尾要留换行，否则下一条日志跟最后一行黏在一起');
  const second = text.split('\n')[1];
  assert.match(second, /^2026-08-21T/, '截断点要落在行边界上，不许留半行');
});

test('trimLogFile：没超就一个字节都不动，也不写说明', (t) => {
  const file = tmpfile(t, 'x\n'.repeat(10));
  const before = fs.readFileSync(file, 'utf8');
  const res = trimLogFile(file, { capBytes: 1_000, keepBytes: 100 });
  assert.equal(res.trimmed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('trimLogFile：文件不在 / 读不了都不许抛（收尾路径上不能因为日志把主流程搞停）', (t) => {
  const missing = path.join(path.dirname(tmpfile(t, '')), 'nope.log');
  assert.deepEqual(trimLogFile(missing), { trimmed: false, dropped: 0 });

  if (process.getuid?.() === 0) return; // root 无视权限位，这条判据在 root 下没意义
  const file = tmpfile(t, 'y\n'.repeat(5_000));
  fs.chmodSync(file, 0o000);
  try {
    assert.deepEqual(trimLogFile(file, { capBytes: 100, keepBytes: 50 }), { trimmed: false, dropped: 0 });
  } finally {
    fs.chmodSync(file, 0o600); // 放回去，好让目录清理得掉
  }
});
