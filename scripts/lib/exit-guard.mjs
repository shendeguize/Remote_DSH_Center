/**
 * 收尾兜底（issue #112）：结论都打完了，就不许再让残留句柄拖着不退。
 *
 * 这层是最后一道保险，不是修漏的地方——漏在哪要各自去修（Chrome 旁支继承的
 * stderr 管子、没清的定时器）。但 CI 上「挂到 job 超时」和「红一条判据」代价差着
 * 一个量级：前者退出码根本传不出去，还白烧一整段 runner 时间。所以兜底要报出
 * 句柄名（下次好查）再硬退，且带上原本的退出码。
 *
 * 逻辑全部可注入，判据在 tests/tooling.test.js。
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.graceMs] 结论打完后再等多久；到点还活着就硬退
 * @param {() => string[]} [opts.resources] 活句柄清单（默认问 Node 自己）
 * @param {(code:number) => void} [opts.exit]
 * @param {(msg:string) => void} [opts.log]
 * @param {(fn:Function, ms:number) => any} [opts.setTimer]
 * @param {() => number} [opts.code] 原本要用的退出码
 * @returns {any} 那个定时器（已 unref，正常收场时它一次都不会响）
 */
export function armExitGuard({
  graceMs = 3_000,
  resources = () => process.getActiveResourcesInfo(),
  exit = (code) => process.exit(code),
  log = console.error,
  setTimer = setTimeout,
  code = () => process.exitCode ?? 0,
} = {}) {
  const timer = setTimer(() => {
    const alive = resources();
    const names = [...new Set(alive)].join('、') || '（问不出名字）';
    log(`收尾兜底：结论已打完，却还有 ${alive.length} 个句柄拖着不退（${names}）——硬退。`);
    exit(code());
  }, graceMs);
  // 必须 unref：正常收场时事件循环空了，Node 该立刻退，不该被这道保险多留 3 秒。
  // 反过来，unref 的定时器只在「循环因别的东西还活着」时才会响——它响了就等于确诊。
  timer.unref?.();
  return timer;
}
