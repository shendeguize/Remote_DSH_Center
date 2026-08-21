#!/usr/bin/env node
/**
 * 假的 `open`（mac 上拉起浏览器那条命令）。
 *
 * 存在的理由只有一个：`dshc open` 该不该真去开浏览器，是它的核心行为之一
 * （manager 没起时开了就是错，见 issue #23），而这件事没有替身就没法验——
 * 要么不验，要么每跑一次用例弹一个窗口。
 *
 * 只做一件事：把每次调用追加到 $DSHC_HARNESS_DIR/open.log，一行一个 URL。
 */

import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.DSHC_HARNESS_DIR;
if (dir) {
  fs.appendFileSync(path.join(dir, 'open.log'), `${process.argv.slice(2).join(' ')}\n`);
}
