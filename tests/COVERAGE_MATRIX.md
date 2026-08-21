# 覆盖矩阵（14 §6 / TST-03、TST-07）

行 = 状态机迁移 / 协议分支 / 故障场景 / 前端边界；列 = 覆盖它的测试。
「仅真机」列出 IT 编号；逐项结论记在本机的验收记录里（设计语料与验收记录不入库，
复跑方式见下方命令）。

- 一条命令跑全：`npm run check`（测试+覆盖率 → 真浏览器 → 打包产物 → CLI 入口）
- 全量单测与集成：`npm test`
- 覆盖率门槛核对：`npm run coverage:gate`
- 真浏览器冒烟：`npm run ui:smoke`（无头 Chrome + 假远端，10 项）
- 真机验收：`npm run acceptance:real -- --host <ssh-host>`

## 1. 主机状态机迁移（`src/lib/machine.js` TRANSITIONS 全表）

自环恒许可（只刷数据不算迁移），下表为 8 态间的全部合法迁移。

| from → to | 触发者 | 覆盖 |
|---|---|---|
| unknown → ready/no_dsh/unreachable | 探测三分类 | `tests/prober.test.js`（applyProbe 三分类）、`tests/integration/flows.test.js`（探测流程）、IT-01 |
| unreachable → ready/no_dsh/unreachable | 重新探测 | `tests/prober.test.js`「unreachable 后再探测可回到 ready」 |
| no_dsh → ready/no_dsh/unreachable | 重新探测 | `tests/prober.test.js`（no_dsh 两种原因）、`tests/harness/harness.test.js`（PROBE 三分类） |
| ready → starting | start / autoStart | `tests/integration/flows.test.js`、`tests/integration/cli.test.js`、IT-02 |
| ready → ready/no_dsh/unreachable | 探测覆盖 | `tests/prober.test.js`、`tests/integration/flows.test.js` |
| starting → running | 拉起成功 | `tests/integration/flows.test.js`、`tests/integration/loop.test.js`、IT-02、IT-03 |
| starting → ready | 拉起失败回滚 | `tests/integration/flows.test.js`（launch-dies）、`tests/integration/cli.test.js`（退出码 1）、假远端 `bind-busy-twice` |
| running → degraded | 隧道断联 | `tests/integration/resilience.test.js`、IT-06 |
| running → crashed | 深复核判死 | `tests/integration/resilience.test.js`（两条：隧道同时断 / 隧道照活）、IT-07 |
| running → ready | stop | `tests/integration/flows.test.js`、`tests/integration/cli.test.js`、IT-05 |
| degraded → running | 重连成功 / 巡检重建子进程 | `tests/integration/resilience.test.js`、IT-06 |
| degraded → crashed | 重连前复核判死 | `tests/integration/resilience.test.js` |
| degraded → ready | 挂起/重连期间 stop | `tests/integration/resilience.test.js`「degraded 期间 stop」 |
| crashed → starting | 直接再 start（视作重启） | `tests/integration/resilience.test.js`、IT-05 后续 |
| crashed → ready/no_dsh/unreachable | 重新探测 | `tests/prober.test.js`、`tests/integration/flows.test.js` |
| 非法迁移一律拒绝 | 三层守卫 | `tests/lib/machine.test.js`（8×8 快照）、`tests/store.test.js`（setPhase 守卫零改动） |

## 2. 远端协议分支（12 §1）

| 协议 / 分支 | 覆盖 |
|---|---|
| PROBE 模板逐字一致 | `tests/lib/proto.test.js` §1.1 |
| PROBE → ready（dsh 路径/版本/web profile） | `tests/harness/harness.test.js`、`tests/prober.test.js`、IT-01 |
| PROBE → no_dsh（缺二进制 / 缺 web profile 两种原因） | `tests/harness/harness.test.js`、`tests/prober.test.js` |
| PROBE → unreachable（ssh 失败 / 超时 / 输出截断缺哨兵） | `tests/lib/ssh.test.js`、`tests/prober.test.js`、IT-01 |
| PROBE 发现手动实例（RUNNING_DSH_WEB → manualInstances） | `tests/harness/harness.test.js`、`tests/prober.test.js`、IT-05（拒杀演练） |
| PROBE 不把自己那层 `sh -c` 记成手动实例（`$$` 排除；假 `ps` 一并回放调用方自身那行，否则测不出自匹配） | `tests/harness/harness.test.js`（ready 与 no_dsh 两态）、`tests/lib/proto.test.js` §1.1 |
| LISTEN=unknown（远端无 ss）不作否定证据 | `tests/harness/harness.test.js`（no-ss） |
| LAUNCH 模板逐字一致 + 双层转义算例 + `sh -n` 语法 | `tests/lib/proto.test.js` §1.2 |
| LAUNCH `--patch` 紧跟 `web`（启动器旗标顺序） | `tests/lib/proto.test.js` §1.2、IT-09 |
| LAUNCH 注入 env / extraArgs 抵达远端命令行与指纹 | `tests/harness/harness.test.js`、`tests/integration/flows.test.js`、IT-09 |
| LAUNCH `workdir=null` 时模板逐字不含 cd（回归锁） | `tests/lib/proto.test.js` §1.2、`tests/harness/harness.test.js`、`tests/integration/flows.test.js` |
| LAUNCH cd 段：绝对路径 / `~` 拼接抵达远端并还原真实目录 | `tests/lib/shq.test.js`（真 `sh` 还原为单个词）、`tests/lib/proto.test.js` §1.2、`tests/harness/harness.test.js` |
| LAUNCH `ERR=workdir` + 退出码 8 → LAUNCH_FAILED（不误报 unreachable，phase 回 ready） | `tests/harness/harness.test.js`（workdir-missing）、`tests/integration/flows.test.js` |
| workdir 形态校验拦在 manager 侧（非法即不拼装脚本） | `tests/lib/shq.test.js`、`tests/lib/proto.test.js` §1.2、`tests/lib/validate.test.js` |
| VERIFY 回读 CWD → `state.web.cwd`；不可读降级 null 且不进 kill 判据 | `tests/lib/proto.test.js` §1.3、`tests/harness/harness.test.js`（no-proc-cwd，含「cwd 变了照样按指纹停掉」） |
| POLL 三元组（URL / ALIVE / BIND_ERR） | `tests/lib/proto.test.js` §1.2、`tests/harness/harness.test.js` |
| 固定端口拉起成功 | `tests/integration/flows.test.js`、IT-02 |
| 端口占用降级 `--port 0`（logName 换 auto 命名） | `tests/harness/harness.test.js`（bind-busy-once）、IT-03 |
| 两次拉起均绑定失败 → LAUNCH_FAILED（含两份日志尾） | `tests/harness/harness.test.js` + `tests/integration/flows.test.js`（bind-busy-twice）；**IT-04 豁免**（真机无法构造） |
| 起来即崩 → 不等满 5 拍快败 | `tests/harness/harness.test.js`（launch-dies）、`tests/integration/cli.test.js` |
| VERIFY 模板 + 指纹全等判定 | `tests/lib/proto.test.js` §1.3、`tests/harness/harness.test.js` |
| VERIFY ALIVE=no（远端已消失） | `tests/harness/harness.test.js`（remote-crash）、`tests/integration/resilience.test.js`、IT-07 |
| STOP → killed / already-dead | `tests/harness/harness.test.js`、`tests/integration/flows.test.js`、IT-05 |
| STOP 指纹不符 → 拒杀（KILL_REFUSED，不清 state） | `tests/harness/harness.test.js`（pid-reuse）、`tests/integration/flows.test.js`、IT-05 |
| STOP 缺指纹拒绝拼装 | `tests/lib/proto.test.js` §1.3 |
| LOG 尾部读取 / 文件缺失 → `(no log)` | `tests/lib/proto.test.js` §1.4、`tests/harness/harness.test.js`、`tests/integration/cli.test.js` |
| patch 清理协议（空格包裹匹配 + 兼职 mkdir） | `tests/lib/proto.test.js` §1.5 |
| patch 同步：首传 / hash 未变跳过 / 改内容换名 / 旧文件清理 | `tests/harness/harness.test.js`、IT-09 |
| patch 本地不可读 → VALIDATION 快败；scp 失败 → 整体快败 | `tests/harness/harness.test.js`（scp-fail） |
| ssh 统一参数、`sh -c <shq(body)>` 双层包装 | `tests/lib/ssh.test.js`、`tests/lib/shq.test.js` |
| ssh 超时 TERM→2s→KILL 强杀链 | `tests/lib/ssh.test.js`、`tests/harness/harness.test.js`（conn-timeout） |
| 每主机串行队列（串行 / 前序失败不阻断 / 跨主机并行 / 队列超时） | `tests/lib/ssh.test.js` |

## 3. 隧道与巡检分支（11 §5）

| 分支 | 覆盖 |
|---|---|
| 隧道就绪判据（本机监听可连） | `tests/integration/flows.test.js`、IT-02 |
| 子进程退出分类：主动杀 / 本机端口被占 / 转发被拒 / network | `tests/tunnel.test.js`、`tests/harness/harness.test.js` |
| 退避重连 1,2,4,8,16,30…（30s 封顶）与恢复归零 | `tests/tunnel.test.js`、`tests/integration/resilience.test.js` |
| 转发被拒 → 挂起 forward-disabled，不进退避环；手动 reconnect 可再试 | `tests/integration/resilience.test.js`；**IT-10 豁免**（需改共享节点 sshd） |
| 本机端口占用 → 隧道启动失败并报 cannot listen | `tests/harness/harness.test.js`、`tests/ports.test.js` |
| 巡检：转发通道探活通过 → 不动手 | `tests/integration/resilience.test.js` |
| 巡检：本地监听半死但远端活 → 重建子进程 | `tests/integration/resilience.test.js`（SIGUSR2 只关监听） |
| 巡检：ssh 仍在 accept 但远端已死 → crashed | `tests/integration/resilience.test.js`、IT-07 |
| localPort 一次分配后固定、区间耗尽 → PORT_EXHAUSTED | `tests/ports.test.js`、`tests/integration/loop.test.js` |
| manager 重启：running 不重拉、只重建隧道；已运行则跳过 autoStart | `tests/integration/resilience.test.js`、IT-08 |
| 关停撞上重连的一拍：复核回来后不再重建隧道，本进程名下无孤儿子进程 | `tests/integration/resilience.test.js`「关停正撞上重连的一拍」 |
| 关停收走在飞的一次性 ssh（TERM→KILL），且落闩不再起新的 | `tests/lib/ssh.test.js`（`shutdownSsh` 两条） |

## 4. 故障注入场景库（`tests/harness/scenarios.js` 15 个）

| 场景 | 覆盖它的用例 |
|---|---|
| healthy | 全部集成主干（flows / loop / cli / sse / setup） |
| no-dsh-missing-bin | `tests/harness/harness.test.js`、`tests/integration/flows.test.js` |
| no-dsh-no-profile | 同上 |
| unreachable | 同上 + IT-01 |
| hostkey-fail | `tests/harness/harness.test.js` |
| conn-timeout | `tests/harness/harness.test.js`（强杀链） |
| bind-busy-once | `tests/harness/harness.test.js`、`tests/integration/flows.test.js`、IT-03 |
| bind-busy-twice | `tests/harness/harness.test.js`、`tests/integration/flows.test.js`（IT-04 的替身） |
| launch-dies | `tests/harness/harness.test.js`、`tests/integration/flows.test.js`、`tests/integration/cli.test.js` |
| forward-disabled | `tests/integration/resilience.test.js`（两条：挂起不退避 / 挂起期间 stop；IT-10 的替身） |
| no-ss | `tests/harness/harness.test.js` |
| workdir-missing | `tests/harness/harness.test.js`（含「对 workdir=null 无效」）、`tests/integration/flows.test.js`；真机侧见 IT-14（用户手动） |
| no-proc-cwd | `tests/harness/harness.test.js`（CWD 降级 + 不误杀判据不受影响）、`tests/web/mount.test.js`（UI 显示「—」） |
| scp-fail | `tests/harness/harness.test.js` |
| slow-probe | `tests/harness/harness.test.js`（并行探测不互相阻塞） |

## 5. HTTP / SSE 契约（13 文档，TST-05）

| 面 | 覆盖 |
|---|---|
| 全部 REST 响应逐一过 schema 校验 | `tests/contract/schemas.js` 接入 `tests/integration/*.test.js` |
| 契约漂移检测（改名 / 多键 / 枚举越界 / null 语义 / 时间戳形态） | `tests/contract/schemas.test.js` |
| 202 受理体（accepted + operationId uuid v4） | `tests/contract/schemas.test.js`、`tests/integration/flows.test.js` |
| SSE snapshot 首帧 / 心跳 / 断开摘除 / debounce 合并 | `tests/api.test.js`、`tests/integration/sse.test.js` |
| SSE revision 单调 + 帧类型白名单 | `tests/integration/sse.test.js`、`tests/contract/schemas.test.js` |
| 请求体解析边界（空体 / 非法 JSON / 超限 → VALIDATION） | `tests/api.test.js` |
| 错误码族与 HTTP 状态映射（VALIDATION/PHASE_CONFLICT/KILL_REFUSED/NOT_FOUND/SETUP_REQUIRED…） | `tests/integration/flows.test.js`、`tests/integration/setup.test.js` |
| setup 门禁：未初始化时白名单外全 409 | `tests/integration/setup.test.js`、IT-12（页面侧人工） |

## 6. CLI 与守护（11 §6、02 §9）

| 面 | 覆盖 |
|---|---|
| 参数解析 / 命令表 / 用法错误退出码 3 | `tests/cli.test.js` |
| 终态等待表（含 start/restart 的 ready 需在 starting 之后才算失败） | `tests/cli.test.js`、`tests/integration/cli.test.js`、IT-09、IT-13 |
| 退出码 0/1/2/3 全覆盖 | `tests/integration/cli.test.js`、IT-13 |
| `--no-wait` 立即返回 | `tests/integration/cli.test.js`、IT-13 |
| 主机名前缀匹配（唯一 / 歧义 / 不存在） | `tests/cli.test.js`、`tests/integration/cli.test.js` |
| `config set hosts.<主机>.workdir`：点路径路由、落盘、空串/`null` 清空、非法值报错 | `tests/cli.test.js`（`buildHostPatchFor` 形态边界）、`tests/integration/cli.test.js`（三分支端到端） |
| up / status / down / restart / stale pidfile 自愈 | `tests/integration/daemon.test.js` |
| `POST /api/manager/restart` 裸后台继任 | `tests/integration/daemon.test.js` |
| launchd plist 快照（KeepAlive / DSHC_MODE / DSHC_HOME 注入） | `tests/integration/daemon.test.js`；真机接管与 kill -9 拉回见 IT-11 |
| `dshc init` 向导脚本化（默认值 / 重问 / --force 预填 / 取消） | `tests/setup-wizard.test.js` |

## 7. 前端逻辑与边界（10 §7 的 20 条）

| 边界（10 §7 编号） | 覆盖 |
|---|---|
| 1 iframe 崩溃不自判 / crashed 后只 reload 一次 | `tests/web/panes.test.js` |
| 2 localPort 变更整只重建 | `tests/web/panes.test.js` |
| 3 探测中途提交向导（冻结快照、迟到结果不改） | `tests/web/setup-mount.test.js`、`tests/web/setup-wizard.test.js` |
| 4 双标签与脏草稿冲突提示 | `tests/web/drawer.test.js`、`tests/web/mount.test.js` |
| 5 断线期间禁写 | `tests/web/store.test.js`、`tests/web/actions.test.js`、`tests/web/mount.test.js` |
| 6 请求超时但后端继续 | `tests/web/store.test.js`（pending 超时只解 loading） |
| 7 手动实例禁 stop/restart | `tests/web/utils.test.js`、`tests/web/tabbar.test.js`、`tests/web/actions.test.js` |
| 8 主机从 ssh config 消失 → orphaned | `tests/store.test.js`（mergeSshHosts）、`tests/web/utils.test.js` |
| 9 主机名特殊字符（dataset + encodeURIComponent） | `tests/web/router.test.js` |
| 10 SSE 乱序 / 重复（revision 丢旧） | `tests/web/store.test.js`、`tests/integration/sse.test.js` |
| 11 连续点击同一危险动作 | `tests/web/actions.test.js` |
| 12 degraded 已自愈时不再发重连 | `tests/web/actions.test.js` |
| 13 stop 后当前正显示 iframe | `tests/web/panes.test.js` |
| 14 配置草稿与运行态分离 | `tests/web/drawer.test.js`、`tests/web/form.test.js` |
| 启动目录输入：非法值就地报错且不发请求、空串提交 null、只提交改动键 | `tests/web/form.test.js`（`parseWorkdir`/`buildHostPatch`）、`tests/web/mount.test.js` |
| 「重启后生效」徽标只在运行实例值与已存配置不一致时出现 | `tests/web/drawer.test.js`（`workdirPending`）、`tests/web/mount.test.js` |
| 实际工作目录展示：有值即显示，不可读显示「—」不编造 | `tests/web/mount.test.js`、`tests/integration/flows.test.js`（后端侧 `web.cwd`） |
| 15 patch 路径无效 / 同步失败提示 | `tests/web/form.test.js`、`tests/web/actions.test.js`（错误 detail 展开） |
| 16 事件洪峰 50 条环形缓冲 | `tests/web/store.test.js` |
| 17 前台模式 manager restart 被拒 | `tests/web/actions.test.js`、`tests/web/mount.test.js`（确认后才发请求）、`tests/integration/setup.test.js`（前台只给 restartRequired） |
| 18 setup JSON 手工删字段 | `tests/web/setup-wizard.test.js`、`tests/web/setup-mount.test.js` |
| 19 新端口迁移超时 | `tests/web/setup-mount.test.js`、`tests/web/setup-wizard.test.js` |
| 20 GET 首屏与 SSE 全量交错 | `tests/web/store.test.js`（mergeFetchedHosts） |
| 首屏即 host 路由（书签 / 刷新 / `dshc open <host>`）：主机集合迟到也不改写地址；到齐后建 iframe | `tests/web/mount.test.js`（用 responder 把 `/api/hosts` 卡住造出迟到）、`scripts/ui-smoke.mjs` S10 |
| 主机真从状态里消失（≠ 尚未同步）→ 仍回管理台 | `tests/web/mount.test.js`（snapshot 整体替换掉该主机） |
| 切主机时激活标签滚进可视区；同一路由重渲染不再滚（否则用户自己拖的位置会被拽回去） | `tests/web/mount.test.js`（垫片记 `scrollIntoView` 的账）、`scripts/ui-smoke.mjs` S11（真滚了多少像素） |
| 无障碍：键盘链路 / `[hidden]` 不吃焦点 / 状态不只靠颜色 | `tests/web/a11y.test.js`、`tests/web/utils.test.js`；渲染观感见 UI-28 人工清单 |
| 抽屉的 Esc 挂在 document 上（焦点在外也能关）、开着时后景 `inert`、关掉即放开 | `tests/web/a11y.test.js` |
| 重渲染保焦：同控件还在→留在它上面；控件消失或被禁用→退到那一行；更新别人不掀我的焦点 | `tests/web/a11y.test.js`（垫片已如实建模「移除含焦点子树→焦点回 body」） |
| 错误提示随输入更新（碰过的字段才实时报）、离开字段即校验、保存时全量校验 | `tests/web/mount.test.js` |

`tests/web/*` 喂的是手写 fixture，抓不到「后端改了字段名 / 少一层对象」这类漂移。
`tests/integration/ui-live.test.js` 把 DOM 垫片接到真 manager（真 HTTP + 真 SSE 分帧，
只有 ssh 那一层是假的），补上前后端接缝：

| 接缝 | 覆盖 |
|---|---|
| 首屏三个 GET 全为同源相对路径（无硬编码端口） | `tests/integration/ui-live.test.js`；静态扫描另见 `tests/architecture.test.js` |
| 真 probe 结果渲染成徽章 + 真 revision 不落后于 GET | 同上 |
| 页面点「拉起」→ 真起真隧道 → iframe src 用后端给的 mappedUrl → 「关停」销毁 pane | 同上（UI-28 第 9、12 项的无头部分） |
| 未初始化时后端门禁把页面按到 `#/setup`，且不越权拉主机清单 | 同上（UI-28 第 1 项的后端侧） |
| manager 掉线 → 横幅出现、写按钮全禁用 | 同上（UI-28 第 13 项的无头部分） |

垫片判不了真样式表、真焦点环、真跨 origin iframe，这三样由 `npm run ui:smoke`
（无头 Chrome + CDP，远端仍是假装置）盯住：

| 真浏览器检查 | 覆盖 |
|---|---|
| 首屏零控制台错误、零 4xx/5xx（含 favicon 声明可取） | `scripts/ui-smoke.mjs` S1；静态侧回归 `tests/integration/static.test.js` |
| 徽章「颜色 + 文字 + 形状」三重标识 | S2 |
| 1024 / 1440 宽不横向溢出（附截图） | S3 |
| Tab → 主机行 → Enter 开抽屉 → Esc 关且焦点归位 | S4（暴露过「抽屉一开即脏草稿」，回归见 `tests/web/drawer.test.js`） |
| 抽屉即模态：25 次 Tab 一次都不落到遮罩后面的控件上，焦点在抽屉外按 Esc 照样能关（`inert` 是浏览器原生语义，垫片证不了；判据自带收尾，失败也不会把后面的场景带崩） | S4b |
| 就地校验的时机：打字不吵、离开字段就报、改对即灭（`blur` 不冒泡——第一版把处理器挂在 form 上，垫片能过、真机收不到） | S4c |
| 焦点扛住整表重建：驱动侧连续采样 14 次，全程守在原来那一行（页面里的 `setInterval` 会被后台节流打到 1s 一次，采不到忙碌窗口；摘掉守卫则 14/14 掉 `body`） | S4d |
| 行内控件的按键归控件自己：真机上 Enter/Space 都发出探测请求且抽屉不开（原生激活只有真浏览器验得到——垫片不会因为 Enter 就替按钮生成 click；单测那半边在 `mount.test.js` 里守「按了不开抽屉」） | S4e |
| 事件面板：按主机筛选、折叠（`hidden` + `aria-expanded`）、清空、以及单条 `host-changed` 带来的新主机要进筛选下拉（此前只订 `hosts:reset`，缺这台） | `tests/web/mount.test.js` |
| 向导换步带住焦点：前进/后退都落在新步骤标题，同一步内输入时不被标题夺走，收尾后落在管理台标题（真机四跳全部复验过） | `tests/web/setup-mount.test.js` |
| 菜单方向键真的换项（首项 → ArrowDown → End → Home），选完一项还焦到标签；外加静态闸门禁止前端把 `querySelectorAll` 结果当数组使——这类差异被垫片永久掩盖，单测判不出来 | S6、`tests/web/a11y.test.js`、`tests/architecture.test.js` |
| 重连的快照结算在飞写操作：已 running 的快照解锁按钮，`starting` 的快照不解锁；恢复本身（横幅消失、写操作解禁、快照回灌）另有真浏览器场景 | `tests/web/store.test.js`、S9b |
| 跨站防线：环回名判定、同源放行（含不带 Origin 的 CLI）、跨站各形态（换协议/换端口/`null`/非 URL/子域名障眼法）、Host 先判、不回显攻击者域名；集成侧验「跨站 start 被拒且主机确实没被拉起」与「非环回 Host 连 `/`、`/app.js` 一起拒」 | `tests/lib/origin-guard.test.js`、`tests/integration/security.test.js` |
| 按住期间不重建：鼠标与 Space 的原生激活都在抬起那一刻且要求同一个节点，按住期间表格必须一个节点都不动，松手后又必须追上（松手当场刷也不行——click 在 pointerup 之后才派发，当场重建会把这一次点击掐掉） | S4f、`tests/web/mount.test.js` |
| 60 次 Tab 不落进 `[hidden]` 子树 | S5 |
| 标签页菜单 Shift+F10 / ArrowDown / Esc | S6 |
| 真 iframe 跨 origin 取到远端 dsh web（200 + 帧树） | S7 |
| `prefers-reduced-motion: reduce` 下动画真为 none | S8 |
| 掉线横幅 + 禁写 + 不堆 `/api/events` 连接 | S9 |
| 深链冷启动与刷新都落在主机页（S7 走页内改 hash，抓不到「首屏即 host 路由」那条时序） | S10 |
| 标签栏溢出时激活标签仍在可视区内（视口收窄 + 长名主机撑出溢出，且先断言「不滚就够不着」防空转） | S11 |

## 8. 架构约束（ENG-24）

| 约束 | 覆盖 |
|---|---|
| `src/` 内部依赖图无环 | `tests/architecture.test.js` |
| 分层不倒挂（lib 不依赖上层、前端不依赖后端） | 同上 |
| 前端不碰 node 内置模块 | 同上 |
| 零 npm 依赖（运行时与测试） | 同上 |
| `setup-schema.js` 零 import（双侧共用） | 同上 |
| 覆盖率三档门槛判定逻辑 | 同上（parseLcov / 门槛表），执行入口 `npm run coverage:gate` |

## 8.1 工程化工具链（ENG-24 的交付面）

| 约束 | 覆盖 |
|---|---|
| 入口判定认软链（装到 PATH 的 dshc 是软链，判错就静默退 0） | `tests/tooling.test.js`（`isMainEntry` + 真软链跑 `dshc --help`） |
| 安装脚本不覆盖非本仓库的 dshc、PATH 缺失时当场提示 | 同上（`linkPlan` / `prefixInPath` / `pathHint`） |
| 闸门关卡选择与摘要、`--only/--skip` 打错字要报错 | 同上（`selectStages` / `summarize`） |
| 打包产物：该进的都在，`tests/`、`.local/` 不混进去 | 同上（`verifyPackFiles`），执行入口 `npm run check --only pack` |
| Chrome 查找跨平台（显式指定优先，缺了可跳过） | 同上（`findChrome`） |

## 8.2 版本自证与自更新（补丁集 0.1.0）

失败方式都不响：通道认错会动错目录，快进判据松了会冲掉本地提交，校验和不核
等于让人装未经核对的二进制。所以逐条钉住：

| 约束 | 覆盖 |
|---|---|
| SemVer 解析 + pre-release 优先级四条规则（数值比 / 字典序 / 数字段小于字母段 / 字段少的更小 / 正式版大于预发布） | `tests/lib/semver.test.js`（含规范完整序列一次跑通） |
| 稳定口径不挑 pre-release，`--pre` 才看得见 | 同上（`pickLatest`）、`tests/updater.test.js`（`chooseTarget` 与 `updateBundle` 双层） |
| 本机装着预发布时「已是最新」要点出更新的预发布（rc 用户不被卡在旧 rc 上），装正式版的人不受打扰、已在 `--pre` 口径上不重复啰嗦 | `tests/updater.test.js`（`chooseTarget.newerPrerelease`）、`tests/cli.test.js`（`upToDateLines` 文案） |
| 产物名与 `SHA256SUMS` 格式的逐字形态（改名 = 下载 404，静默） | `tests/lib/bundle.test.js` |
| 发布仓库单一源：`install.sh` 默认 URL == `RELEASE_REPO` | 同上（跨语言一致性用例） |
| 安装通道识别：git / bundle / 认不出（含 `BUNDLE_INFO.json` 坏掉） | `tests/updater.test.js`（`resolveInstall`、`collectVersionInfo`） |
| git 通道**只快进**：脏工作区拒、非后代拒、ref 不存在报清楚、detached HEAD 形态下成立 | 同上（本地一对真仓库演练，PV-5） |
| bundle 通道：校验和不符 / SUMS 缺项 / HTTP 非 200 一律拒装 | 同上（假 Releases 服务，PV-12） |
| bundle 通道原子换目录：`.new` 解包 → 改名，旧版留 `.prev`；结构不对时原安装一字节不动 | 同上（`installBundle`，PV-6 / PV-10 的自动化部分） |
| 架构归一与不支持架构的拦截（拦在下载之前） | `tests/lib/bundle.test.js`、`tests/updater.test.js` |
| `version` / `update` 在命令表与用法文本里 | `tests/cli.test.js` |

假 Releases 服务（`tests/harness/fake-releases.js`）挂的是**真 tar.gz**（系统 tar 打的
最小 bundle 骨架），所以下载、校验、解包、换目录四段都是真跑，只有「网那头是谁」是假的。

## 8.3 发布包与双通道安装（补丁集 0.1.0 · PR ②）

| 约束 | 覆盖 |
|---|---|
| 随包 Node 版本满足 `engines.node`，且只挑 LTS | `tests/tooling.test.js`（`NODE_RUNTIME_VERSION` 与 package.json 对照） |
| 启动器**自己解软链**（装到 PATH 的是软链，拿 `$0` 算 dirname 会找不到 runtime/app） | 同上（`shimScript` 逐字断言），`tests/install-sh.test.js`（真软链 + 自带 node 跑 `dshc version --json`） |
| 发布包 `app/` 的内容口径 = 打包白名单，不另立第二份 | 同上（`packFileList` 复用 `verifyPackFiles`：缺文件 / 混入 `tests/` 都拒） |
| `BUNDLE_INFO.json` 字段齐全（通道识别与 `update` 都读它） | 同上（`makeBundleInfo`） |
| 软链落点随通道走：git → `src/cli.js`，bundle → 包内 `bin/dshc` | 同上（`linkTarget` 双通道） |
| `install.sh` 通道自动选择：有 node 走 git，缺 node / 版本过低在 mac 上**降级 standalone** | `tests/install-sh.test.js`（去掉 node 的 stub PATH 里真跑到底） |
| `--git` 强制时缺 node 就报错（不静默降级），且提示怎么走另一条 | 同上 |
| standalone 全链：取 Release → 下载 → SHA256 核对 → 解包 → 原子换目录（旧版留 `.prev`） | 同上（假 Releases 服务 + 真 tar.gz + 真 shasum） |
| 校验和不符时拒装，且不留半个安装 | 同上 |
| `--pre` 才看得见预发布；`--version <tag>` 钉死 | 同上 |
| 已是 git clone 的目录上拒绝 standalone 覆盖（两种安装形态不混） | 同上 |
| git 通道默认跟 `release` 而不是 `main` | 同上（origin 里 `main` 与 `release` 指不同提交，靠独有文件判定） |
| 收尾「下一步」只印一遍（`install.sh` 那份为准，`install.mjs` 由 `--no-next-steps` 让位） | 同上（数「下一步」出现次数） |
| stdout 被下游提前关掉（`\| head`）不抛 EPIPE 栈，且该建的软链照建 | 同上（用 `\| true` 让读端立刻关闭，触发不依赖时序）、`tests/tooling.test.js`（`isBrokenPipe` 码表） |

CLI 在「manager 没起」与「参数写错」这两类误用上的口径：

| 约束 | 覆盖 |
|---|---|
| manager 没起时所有命令同一句人话、同一退出码（2），不漏 errno 与内部码 | `tests/integration/cli.test.js`（`ls`/`start`/`open`/`open <host>`/`config set` 逐条过） |
| `config get` 读本地文件，manager 没起也能用（不能为了统一口径把它一起拦掉） | 同上 |
| `open` 先探活再拉浏览器；manager 没起时**不开**浏览器 | 同上（假 `open` 记账，`DSHC_OPEN_BIN` 注入，见 `tests/harness/fake-open.js`） |
| 引导模式下 `open` 仍放行（页面就是向导），其他主机命令照旧拦住 | 同上 + `tests/cli.test.js`（`allowSetupMode` 只有 open 有） |
| `open <host>` 拉起的是那台主机的深链 | 同上（账本里就是 `#/host/<name>`） |
| `up --port` 越界当场退 3，不 spawn | 同上；判据单一源 `src/lib/validate.js` 的 `isBindablePort` |
| 漏参数的主机命令（`start`/`stop`/`restart`/`log`）按用法错误退 3、带「用法错误」前缀并打完整 usage（`withApi` 不许吞 `UsageError`）；命令行给了非法值同样退 3，且 `VALIDATION` 的 detail 不用 `--verbose` 就能看到 | `tests/integration/cli.test.js`、`tests/cli.test.js`（`exitCodeFor` 映射） |

发版守卫的 rc 语义（补丁集 0.1.0 · PR ③）：

| 约束 | 覆盖 |
|---|---|
| tag 形状认预发布后缀，但拒 build 元数据与空后缀 | `tests/tooling.test.js`（`versionFromTag`，形状判定借 semver 不另写正则） |
| rc 豁免「必须打在 release HEAD」，但仍要求出自 main | 同上（`evaluateGuards` rc 用例） |
| 豁免不许误伤正式版：同样的 sha 错位，正式版必须红 | 同上（同一组输入换成 final tag 的反面用例） |
| rc 的版本号一致性与 CHANGELOG 要求一点不放松 | 同上（`0.2.0` vs `0.2.0-rc.1` 判红） |

`scripts/build-bundle.mjs` 的纯函数（命名、shim、清单、标记）在用例里，下载与组装那段是
IO，靠**真跑一次**代证：`npm run build:bundle` 出双架构产物，解包后经软链执行
`dshc version --json`，断言 `node.execPath` 落在包内 `runtime/bin/node`——这条是「自带运行时
真的在用」的唯一硬证据（也是流水线 verify 段的断言，PV-3）。

## 9. 门槛核对结果（最近一次 `npm run coverage:gate`）

| 档位 | 行覆盖 | 门槛 | 结果 |
|---|---|---|---|
| `src/lib/**` | 99.37% | ≥ 90% | 达标（新增 `semver.js` 100%、`bundle.js` 100%） |
| `src/*.js` | 88.79% | ≥ 75% | 达标（新增 `updater.js` 95.91%；最低仍是 `cli.js` 74.24%） |
| `src/web/`（不含 components） | 96.20% | ≥ 80% | 达标 |
| `src/web/components/**` | 93.97% | 仅报告 | DOM 组件不设卡（最低 `iframe-pane.js` 86.28%） |

## 10. 未覆盖行说明

矩阵内没有「未覆盖且非仅真机」的行。五处仅真机 / 仅人工，理由与替身：

| 项 | 原因 | 替身覆盖 |
|---|---|---|
| IT-04 两次拉起失败 | 真机无法让 `--port 0` 也绑定失败 | 假远端 `bind-busy-twice` |
| IT-14 启动目录真机验收（补丁 v0.0.1/01 的 WS-01/WS-10） | 需真远端 + 浏览器内确认 dsh 的 workspace picker 默认根与 AGENTS.md 加载——这是 dsh 自身行为，假远端无从模拟 | 我们这侧的全链（脚本 cd 段、state/HostView 回写、失败分类、UI、CLI）已全自动化；假远端只能证明「cd 到了那里」，证不了「dsh 因此把它当工作区根」 |
| IT-10 远端禁止转发 | 需改共享节点 sshd 配置并重启服务 | 假远端 `forward-disabled` |
| IT-12 页面向导 | 需人工点击（UI-28 清单第 1 项） | CLI 侧向导 `tests/setup-wizard.test.js`、挂载测试 `tests/web/setup-mount.test.js`、门禁跳转 `tests/integration/ui-live.test.js` |
| UI 观感（字号/对比度/留白）与灰度可辨 | 好不好看只能人眼判 | `npm run ui:smoke` 出两个宽度的截图供人过目；结构性判据（文字+形状、不溢出）已自动化 |
| SSE 背压：不读的客户端持续积压后被断开（宽限期内排空的不算）、读得动的客户端不被误踢、连接断开与 hub dispose 都撤掉复查定时器 | `tests/integration/sse.test.js` |
| 配置落盘失败：内存不动、磁盘不动、不发 config-changed、错误是 `CONFIG_WRITE_FAILED` 人话（原始 EACCES 只进 detail）、权限恢复后照常能写 | `tests/store.test.js` |
| 日志行上限：巨行 msg/detail 各自按字数截断且注明原文多长、正常长度一字不动、20 条 8MB 不再顶内存 | `tests/lib/bus.test.js` |
| 配置被外部改过：落盘前核对指纹，对不上报 `CONFIG_STALE` 整份拒写（磁盘手改一字不动、内存不动、不发 config-changed）；自己连写多次不误判；CLI 侧退 1 且「`dshc restart`」这条出路不藏在 `--verbose` 后面 | `tests/store.test.js`、`tests/integration/cli.test.js` |
| 配置文件分类：不存在/截断/空文件/顶层非对象/权限不可读各自成一类；`dshc up` 遇损坏或不可读拒绝启动且不进向导、文案指明文件与出路；`init --force` 覆盖前备份 | `tests/cli.test.js`、`tests/integration/cli.test.js` |
| XSS 面：前端静态禁用 innerHTML 一类注入口；日志里的 HTML 原样当文本显示、不解析成节点 | `tests/architecture.test.js`、`tests/web/mount.test.js` |
| 右键菜单落点：够得下照原点摆、右/下不够朝反方向翻、视口比菜单还小则贴边不出负坐标；层序上菜单高于 toast 且低于对话框、toast 容器不吃指针事件；真浏览器里三个方位开菜单都整块在视口内且每一项都点得到（带着一条 toast） | `tests/web/tabbar.test.js`、`scripts/ui-smoke.mjs`（S6b） |
| 拉起没确认健康：把拉起的进程收走（TERM→1s→KILL），`dshc up` 报的是「已把它收走」且指到日志；它自己退了的走另一句 | `tests/integration/daemon.test.js` |
| 闸门自查用例点名：静态数顶格声明数、从 TAP 读实跑数、逐文件对账点名（防某个用例自伤后整文件被报成通过） | `tests/tooling.test.js` |
| 浏览器侧判据的等待语义：条件后来才成立也算过、超时把判据名带进错误（防 demo 冒烟这类「此刻」判据在慢机器上偶发红） | `tests/site-tooling.test.js` |
| 有改动时的 Esc：这一记摘掉原生默认动作（否则 CloseWatcher 把刚开的确认框顺手关掉，体感「按了没反应」），框开着时不再插手（否则 Esc 被焊死）；真键盘按下去要「弹框 → 再 Esc 收框 → 草稿还在」 | `tests/web/a11y.test.js`、`scripts/ui-smoke.mjs`（S4g，判据必须带 `keyCode: 27`，否则只惊动 JS、判不出浏览器那半边） |
| 安装器参数：不认识的旗标在 `install.sh` 与 `install.mjs` 两侧都退 3 并点名，且不留下半个安装 | `tests/install-sh.test.js` |
| 装置孤儿看护：假 dsh web 在拥有者进程消失后自行退出（运行被 Ctrl-C/SIGKILL 掐断、或收尾里断言抛错都兜住），拥有者健在期间不误杀 | `tests/harness/harness.test.js` |
