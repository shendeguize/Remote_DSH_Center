/**
 * demo 的假数据（在线 demo 专用，不参与产品运行）。
 *
 * 硬约束：零 import、纯数据 + 纯函数。浏览器 <script type=module> 与 node:test
 * 都直接吃它，所以既不能碰 DOM 也不能碰 node API。
 *
 * 这里的端口/版本号是**演示用字面量**，与 src/defaults.js 的出厂表无关——
 * demo 跑在浏览器里，读不到 config.json，只能自带一份。
 */

export const DEMO_MANAGER = Object.freeze({
  version: '0.1.0',
  pid: 4213,
  port: 7788,
  mode: 'background',
});

export const DEMO_DEFAULTS = Object.freeze({
  remoteWebPort: 8899,
  localPortRange: Object.freeze([17701, 17799]),
});

/**
 * 初始态的「年龄」：让 demo 一打开看起来像个已经跑了一阵的系统，
 * 而不是满屏「已运行 0 秒 / 探测 0 秒前」。只影响种子数据，
 * 之后真实发生的动作一律用当前时间。
 */
export const SEED_AGE_MS = Object.freeze({
  manager: 3 * 3_600_000 + 17 * 60_000,
  web: 2 * 3_600_000 + 41 * 60_000,
  probe: 4 * 60_000,
});

/**
 * 四台假主机铺满状态谱系：一台在跑（可进标签页）、一台待拉起（演示拉起流程）、
 * 一台没装 dsh、一台连不上。名字刻意短——标签栏里长名字会挤成一团。
 */
export const DEMO_HOSTS = Object.freeze([
  Object.freeze({
    name: 'gpu-a100',
    sshInfo: Object.freeze({ hostName: '10.10.16.112', user: 'root', port: 22 }),
    probeResult: 'ready',
    dsh: Object.freeze({ dshPath: '/usr/local/bin/dsh', version: '0.1.0-rc.7', dshHome: '/root/.dsh' }),
    // 初始就在跑：进 demo 第一眼就有可点开的标签页
    initial: 'running',
    localPort: 17701,
    remoteWebPort: null,
    workdir: '~/work/train',
    pid: 60768,
    probeDelayMs: 700,
    // 同机上还有一个别人手起的实例：演示「只读、禁关停」
    manualInstances: Object.freeze([
      Object.freeze({ pid: 51122, args: 'dsh web --no-open --host 127.0.0.1 --port 9001' }),
    ]),
    autoStart: true,
    // 抽屉里的「注入配置」有东西可看：环境变量、追加参数、已同步的 patch
    inject: Object.freeze({
      env: Object.freeze({ HF_HOME: '/data/hf', DSH_LOG_LEVEL: 'debug' }),
      extraArgs: Object.freeze(['--verbose']),
      patches: Object.freeze(['/Users/me/patches/dsh-web-theme.yml']),
    }),
    patchSync: Object.freeze({
      '/Users/me/patches/dsh-web-theme.yml': Object.freeze({
        hash: '3f9c0d12ab34',
        remoteName: '3f9c0d12ab34-dsh-web-theme.yml',
        syncedAt: '2026-08-20T16:41:07.000Z',
      }),
    }),
  }),
  Object.freeze({
    name: 'gpu-4090-daily',
    sshInfo: Object.freeze({ hostName: '10.10.16.117', user: 'root', port: 22 }),
    probeResult: 'ready',
    dsh: Object.freeze({ dshPath: '/usr/local/bin/dsh', version: '0.1.0-rc.7', dshHome: '/root/.dsh' }),
    initial: 'ready',
    // localPort 留空：演示「首次拉起时才从区间里分配，之后固定」
    localPort: null,
    remoteWebPort: null,
    workdir: null,
    pid: 33417,
    probeDelayMs: 1_300,
    manualInstances: Object.freeze([]),
    autoStart: false,
  }),
  Object.freeze({
    name: 'cpu-build',
    sshInfo: Object.freeze({ hostName: '10.10.16.130', user: 'ci', port: 22 }),
    probeResult: 'no_dsh',
    dsh: Object.freeze({ dshPath: '/usr/local/bin/dsh', version: '0.1.0-rc.5', dshHome: '/home/ci/.dsh' }),
    initial: 'no_dsh',
    localPort: null,
    remoteWebPort: null,
    workdir: null,
    pid: null,
    probeDelayMs: 1_900,
    manualInstances: Object.freeze([]),
    autoStart: false,
  }),
  Object.freeze({
    name: 'legacy-box',
    sshInfo: Object.freeze({ hostName: '10.10.16.9', user: 'root', port: 2222 }),
    probeResult: 'unreachable',
    dsh: null,
    initial: 'unreachable',
    localPort: null,
    remoteWebPort: 18899,
    workdir: null,
    pid: null,
    probeDelayMs: 2_700,
    manualInstances: Object.freeze([]),
    autoStart: false,
  }),
]);

/** 探测结果 → probe 视图（no_dsh / unreachable 的缺失原因也在这里定）。 */
export function probeView(seed, at) {
  if (seed.probeResult === 'unreachable') {
    return {
      dshPath: null,
      version: null,
      dshHome: null,
      profileWeb: false,
      noDshReason: null,
      at,
      errorSummary: 'ssh: connect to host 10.10.16.9 port 2222: Operation timed out',
    };
  }
  if (seed.probeResult === 'no_dsh') {
    return {
      dshPath: seed.dsh?.dshPath ?? null,
      version: seed.dsh?.version ?? null,
      dshHome: seed.dsh?.dshHome ?? null,
      profileWeb: false,
      noDshReason: 'no-web-profile',
      at,
      errorSummary: null,
    };
  }
  return {
    dshPath: seed.dsh.dshPath,
    version: seed.dsh.version,
    dshHome: seed.dsh.dshHome,
    profileWeb: true,
    noDshReason: null,
    at,
    errorSummary: null,
  };
}

/** 远端 web.log 的合成尾部（主机详情抽屉里「远端日志」拉到的东西）。 */
export function fakeLog(name, port, lines) {
  const base = [
    `[dsh] harness v0.1.0-rc.7 (node v22.22.0)`,
    `[dsh] loading profile: web`,
    `[dsh] workspace: /root/work/train`,
    `dsh web: http://127.0.0.1:${port}`,
    `[web] static assets mounted (312 files)`,
    `[web] plugin registry ready: 7 plugins`,
    `[web] GET /            200  12ms`,
    `[web] GET /api/session 200   4ms`,
    `[web] websocket /api/events.mux  open`,
    `[web] websocket /api/events.host open`,
    `[web] POST /api/listModels 200  38ms`,
    `[web] heartbeat ok (rss 148MB)`,
  ];
  const tail = [];
  for (let i = 0; i < Math.max(1, lines); i += 1) {
    tail.push(`${base[i % base.length]}`);
  }
  return `# ${name}:~/.dsh_center_remote/web-${port}.log（尾 ${tail.length} 行）\n${tail.join('\n')}\n`;
}

/**
 * 自动演播剧本。每步：字幕 + 一个动作（由控制栏执行）。
 * `note` 说的是「真实场景此处发生了什么」——demo 的意义在于把不可见的
 * ssh/隧道动作讲出来。
 */
export const DEMO_SCRIPT = Object.freeze([
  Object.freeze({
    id: 'intro',
    caption: '这是本机管理台：一张表管所有远端 dsh web。',
    note: '真实环境下主机清单来自 ~/.ssh/config，状态由 manager 每 30s 巡检刷新。',
    action: null,
    holdMs: 3_200,
  }),
  Object.freeze({
    id: 'probe',
    caption: '先全量探测：逐台确认 ssh 能否连上、dsh 装没装。',
    note: '每台各发一条一次性 ssh 命令：command -v dsh 且检查 profiles/web 是否存在。',
    action: 'probe-all',
    holdMs: 3_600,
  }),
  Object.freeze({
    id: 'start',
    caption: '拉起 gpu-4090-daily —— 状态走 starting → running，标签页随之出现。',
    note: 'nohup 起远端 dsh web 拿到 PID，再用 ssh -L 把远端端口映射到本机，并记下命令行指纹。',
    action: 'start:gpu-4090-daily',
    holdMs: 4_200,
  }),
  Object.freeze({
    id: 'open',
    caption: '切进标签页：iframe 里就是远端的 dsh web 本体。',
    note: '同源环回地址 http://127.0.0.1:<本机端口>/，页面、静态资源、WebSocket 全走隧道。',
    action: 'open:gpu-4090-daily',
    holdMs: 4_000,
  }),
  Object.freeze({
    id: 'drop',
    caption: '注入故障：隧道断了。遮罩盖上，manager 按 1/2/4s 退避重连。',
    note: '断联不 reload iframe——页面内容留着，dsh web 自己的 WebSocket 恢复即可。',
    action: 'drop:gpu-4090-daily',
    holdMs: 7_500,
  }),
  Object.freeze({
    id: 'crash',
    caption: '再注入一次：远端进程直接没了 → crashed，需要人工重启。',
    note: '巡检发现记录的 PID 消失且不是我们关的，才判 crashed；重启后 iframe 会重载一次。',
    action: 'crash:gpu-4090-daily',
    holdMs: 5_000,
  }),
  Object.freeze({
    id: 'restart',
    caption: '重启：新进程起来，页面自动重新载入。',
    note: '关停只对指纹逐字对得上的进程生效——手动起的实例一律不碰。',
    action: 'restart:gpu-4090-daily',
    holdMs: 5_000,
  }),
  Object.freeze({
    id: 'done',
    caption: '演示结束。表里的每个按钮现在都可以自己点。',
    note: '这个 demo 跑的是产品前端本体，后端换成了浏览器里的假 manager。',
    action: 'dashboard',
    holdMs: 2_500,
  }),
]);
