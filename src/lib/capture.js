/**
 * 有界的「留尾」收集器（issue #92）。
 *
 * 为什么留尾不留头：这东西收的是远端命令的 stdout/stderr，两种超量场合都指向尾巴——
 * POLL/VERIFY 的 `KEY=VALUE` 是我们的脚本在**最后**打的，前面刷屏的是远端登录 shell
 * （.bashrc/motd）；看日志的人要的也是最新几行，不是十万行之前的开头。
 *
 * 为什么必须有界：`stdout += chunk` 这种写法等于把 manager 的 RSS 交给远端决定。
 * 越过 V8 的字符串上限（约 512MB）时抛的 `RangeError: Invalid string length` 落在流的
 * data 回调里，没人接得住——manager 当场死，所有隧道陪葬。
 */

/**
 * @param {number} cap 留在手里的字符数上限；<=0 表示不封顶
 * @returns {{push(s:string):void, text():string, dropped():number, chunkCount():number}}
 */
export function createTailCapture(cap) {
  /** @type {string[]} */
  const chunks = [];
  let size = 0;
  let dropped = 0;

  return {
    push(s) {
      if (s === '') return;
      chunks.push(s);
      size += s.length;
      if (cap <= 0) return;
      // 先整块地扔，再对边界那块切一刀——这样账本长度只跟 cap 有关，与吐了多少无关
      while (chunks.length > 1 && size - chunks[0].length >= cap) {
        size -= chunks[0].length;
        dropped += chunks[0].length;
        chunks.shift();
      }
      if (size > cap) {
        const over = size - cap;
        chunks[0] = chunks[0].slice(over);
        size -= over;
        dropped += over;
      }
    },
    text() {
      return chunks.join('');
    },
    dropped() {
      return dropped;
    },
    /** 判据用：账本自身不许随吐出量增长。 */
    chunkCount() {
      return chunks.length;
    },
  };
}
