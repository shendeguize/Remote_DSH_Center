/**
 * manager.log 的自我封顶（issue #81）。
 *
 * manager 在 launchd 下是 7×24 的常驻进程，日志只追加、从不回收。健康态几乎不写，
 * 但链路不稳的一台主机（断联 → 退避 → 重连，每一拍都记）实测约 8MB/天——放一年
 * 就是几个 G 躺在 `~/.dsh_center/` 里，没人会去看一眼。
 *
 * 必须**原地**截断：日志是被继承的 O_APPEND fd 在写（`launchDetached` 把 stdout/stderr
 * 都指到这个文件），改名换文件的话进程还往原来那个 inode 里写，新文件永远是空的，
 * 老文件继续长。
 */

import fs from 'node:fs';

/** 到这个大小就动手。 */
export const LOG_FILE_CAP_BYTES = 8 * 1024 * 1024;

/** 截完留这么多尾巴——排障看的都是最近发生的事。 */
export const LOG_FILE_KEEP_BYTES = 1024 * 1024;

/**
 * 要不要截、从哪儿开始留。
 * @param {number} size 当前字节数
 * @returns {{trim:boolean, from:number}} from = 从这个偏移读到末尾
 */
export function planTrim(size, { capBytes = LOG_FILE_CAP_BYTES, keepBytes = LOG_FILE_KEEP_BYTES } = {}) {
  if (!(size > capBytes)) return { trim: false, from: 0 };
  const keep = Math.min(keepBytes, capBytes);
  return { trim: true, from: Math.max(0, size - keep) };
}

/**
 * 超了就原地截断，只留尾巴，并在最前面补一行说明丢了多少。
 * 任何 IO 失败都吞掉：日志封顶失败不该把调用它的主流程（启动、巡检）带下去。
 * @returns {{trimmed:boolean, dropped:number}} dropped = 丢掉的字节数
 */
export function trimLogFile(file, { capBytes = LOG_FILE_CAP_BYTES, keepBytes = LOG_FILE_KEEP_BYTES } = {}) {
  try {
    const { size } = fs.statSync(file);
    const plan = planTrim(size, { capBytes, keepBytes });
    if (!plan.trim) return { trimmed: false, dropped: 0 };

    const fd = fs.openSync(file, 'r');
    let tail;
    try {
      const buf = Buffer.alloc(size - plan.from);
      fs.readSync(fd, buf, 0, buf.length, plan.from);
      tail = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }

    // 从块中间切进来的首行是残行，丢掉它：留半行只会让人怀疑自己看错了
    const cut = tail.indexOf('\n');
    const body = cut === -1 ? '' : tail.slice(cut + 1);
    const dropped = size - Buffer.byteLength(body, 'utf8');
    const head = `${new Date().toISOString()} INFO [manager] 日志已原地截断，丢掉较早的 ${dropped} 字节`
      + `（上限 ${capBytes} 字节）\n`;
    // 同一个 inode 上覆盖写：换文件的话那个 O_APPEND fd 就写进孤立文件里了
    fs.writeFileSync(file, body.endsWith('\n') || body === '' ? `${head}${body}` : `${head}${body}\n`);
    return { trimmed: true, dropped };
  } catch {
    return { trimmed: false, dropped: 0 };
  }
}
