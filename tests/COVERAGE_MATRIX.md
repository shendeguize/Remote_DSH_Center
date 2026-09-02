# 覆盖矩阵（14 §6 / TST-03、TST-07）

行 = 状态机迁移 / 协议分支 / 故障场景 / 前端边界；列 = 覆盖它的测试。
「仅真机」列出 IT 编号；逐项结论记在本机的验收记录里（设计语料与验收记录不入库，
复跑方式见下方命令）。

- 一条命令跑全：`npm run check`（lint → 测试/覆盖率 → 真浏览器 → 站点/文档 → 打包 → CLI）
- 全量单测与集成：`npm test`
- 覆盖率门槛核对：`npm run coverage:gate`
- 行为清单对账（§11）：`npm run matrix:gate`（加 `-- --suggest` 给未登记项列候选用例）
- 真浏览器冒烟：`npm run ui:smoke`（无头 Chrome + 假远端，覆盖 Hub / 管理页 / iframe）
- 真机验收：`npm run acceptance:real -- --host <ssh-host>`

## 1. 主机状态机迁移（`src/lib/machine.js` TRANSITIONS 全表）

自环恒许可（只刷数据不算迁移），下表为 8 态间的全部合法迁移。第一列的 `FSM:` ID 由
`scripts/lib/inventory.mjs` 直接从 `TRANSITIONS` 算出，`npm run matrix:gate` 逐项对账：
迁移表加了一条而这里没登记即红。

| ID（from→to） | 触发者 | 覆盖 |
|---|---|---|
| `FSM:unknown→ready` `FSM:unknown→no_dsh` `FSM:unknown→unreachable` | 探测三分类 | `tests/prober.test.js`（applyProbe 三分类）、`tests/integration/flows.test.js`（探测流程）、IT-01 |
| `FSM:unreachable→ready` `FSM:unreachable→no_dsh` `FSM:unreachable→unreachable` | 重新探测 | `tests/prober.test.js`「unreachable 后再探测可回到 ready」 |
| `FSM:no_dsh→ready` `FSM:no_dsh→no_dsh` `FSM:no_dsh→unreachable` | 重新探测 | `tests/prober.test.js`（no_dsh 两种原因）、`tests/harness/harness.test.js`（PROBE 三分类） |
| `FSM:ready→starting` | start / autoStart | `tests/integration/flows.test.js`、`tests/integration/cli.test.js`、IT-02 |
| `FSM:ready→ready` `FSM:ready→no_dsh` `FSM:ready→unreachable` | 探测覆盖 | `tests/prober.test.js`、`tests/integration/flows.test.js` |
| `FSM:starting→running` | 拉起成功 | `tests/integration/flows.test.js`、`tests/integration/loop.test.js`、IT-02、IT-03 |
| `FSM:starting→ready` | 拉起失败回滚 | `tests/integration/flows.test.js`（launch-dies）、`tests/integration/cli.test.js`（退出码 1）、假远端 `bind-busy-twice` |
| `FSM:running→degraded` | 隧道断联 | `tests/integration/resilience.test.js`、IT-06 |
| `FSM:running→crashed` | 深复核判死 | `tests/integration/resilience.test.js`（两条：隧道同时断 / 隧道照活）、IT-07 |
| `FSM:running→ready` | stop | `tests/integration/flows.test.js`、`tests/integration/cli.test.js`、IT-05 |
| `FSM:degraded→running` | 重连成功 / 巡检重建子进程 | `tests/integration/resilience.test.js`、IT-06 |
| `FSM:degraded→crashed` | 重连前复核判死 | `tests/integration/resilience.test.js` |
| `FSM:degraded→ready` | 挂起/重连期间 stop | `tests/integration/resilience.test.js`「degraded 期间 stop」 |
| `FSM:crashed→starting` | 直接再 start（视作重启） | `tests/integration/resilience.test.js`、IT-05 后续 |
| `FSM:crashed→ready` `FSM:crashed→no_dsh` `FSM:crashed→unreachable` | 重新探测 | `tests/prober.test.js`、`tests/integration/flows.test.js` |
| 非法迁移一律拒绝 | 三层守卫 | `tests/lib/machine.test.js`（8×8 快照）、`tests/store.test.js`（setPhase 守卫零改动） |

## 2. 远端协议分支（12 §1）

| 协议 / 分支 | 覆盖 |
|---|---|
| PROBE 模板逐字一致 | `tests/lib/proto.test.js` §1.1 |
| PROBE → ready（dsh 路径/版本/web profile/嗅探字段） | `tests/harness/harness.test.js`、`tests/prober.test.js`、IT-01 |
| PROBE → no_dsh（缺二进制 / 缺 web profile 两种原因 + 非交互 PATH 嗅探） | `tests/harness/harness.test.js`、`tests/prober.test.js` |
| PROBE 嗅探结果只作诊断，旧输出回退为空 | `tests/prober.test.js`、`tests/web/install-guide.test.js` |
| PROBE → unreachable（ssh 失败 / 超时 / 输出截断缺哨兵） | `tests/lib/ssh.test.js`、`tests/prober.test.js`、IT-01 |
| PROBE 发现手动实例（RUNNING_DSH_WEB → manualInstances） | `tests/harness/harness.test.js`、`tests/prober.test.js`、IT-05（拒杀演练） |
| PROBE 不把自己那层 `sh -c` 记成手动实例（`$$` 排除；假 `ps` 一并回放调用方自身那行，否则测不出自匹配） | `tests/harness/harness.test.js`（ready 与 no_dsh 两态）、`tests/lib/proto.test.js` §1.1 |
| PROBE 不把 Center 派给别台的 `ssh … sh -c '<探测脚本>'` 记成手动实例（本机幻影：判据要求 `dsh web` 相邻；假 `ps` 回放兄弟 ssh 行，且判据取自协议模板而非手写对译） | `tests/harness/harness.test.js`、`tests/lib/proto.test.js` §1.1（含真 `ps`/`grep` 上的布陷阱验证） |
| LISTEN=unknown（远端无 ss）不作否定证据 | `tests/harness/harness.test.js`（no-ss） |
| LAUNCH 模板逐字一致 + 双层转义算例 + `sh -n` 语法 | `tests/lib/proto.test.js` §1.2 |
| LAUNCH 必须带探测解析出的绝对路径：缺路径拒绝拼装（不退回裸 `dsh` 走 PATH 查找）、路径与其 bin 目录一并抵达远端命令行；假远端照 nohup 那样对找不到的命令失败 | `tests/lib/proto.test.js` §1.2、`tests/fuzz/proto.test.js`、`tests/harness/harness.test.js`（canon 装法拉起 + 漏传即拒）、`tests/integration/flows.test.js`（`SCN:canon-login-only` 端到端） |
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
| SETTINGS READ/WRITE 模板逐字一致、`sh -n` 语法、固定 `${DSH_HOME:-$HOME/.dsh}/settings.yaml`、新退出码 10/11/12 不撞 8/9；POSIX `cksum` 能力探测同时核对算法，`od` hex 输出在 macOS/BSD 上也不超过 2 MiB transport 上限 | `tests/lib/proto.test.js` |
| SETTINGS READ：missing/empty/UTF-8/精确 512 KiB 成功；超限、非法 UTF-8、工具不支持、读取失败、CRC/framing/txn 污染严格分类，正文与协议噪声不进入错误 | `tests/settings-file.test.js`、`tests/integration/settings.test.js` |
| SETTINGS WRITE：base checksum CAS、backup 后二次 CAS、同目录临时文件 + `mv` 提交、chmod 600；提交前/后中断保守报告 commit state，stale 不覆盖，unknown 要求 GET；正常退出和后续操作只清理 reserved staging | `tests/lib/proto.test.js`、`tests/settings-file.test.js`、`tests/integration/settings.test.js` |
| dsh Web `workspace.create` 官方 HTTP 信封：固定 method、随机 `rpcId` 回显、实际绝对 CWD；响应封顶 64 KiB，只消费最小安全字段并兼容上游新增字段，invalid-path/transport/timeout 脱敏分类 | `tests/dsh-workspace.test.js`、`tests/harness/fake-dsh-web.js`、`tests/integration/workspace.test.js` |
| patch 清理协议（空格包裹匹配 + 兼职 mkdir） | `tests/lib/proto.test.js` §1.5 |
| 远端 patch 同步：首传 / hash 未变跳过 / 改内容换名 / 已移除项与旧文件清理；建目录失败不继续半套上传 | `tests/harness/harness.test.js`、`tests/launcher.test.js`、`tests/patchsync.test.js`、IT-09 |
| 本机 patch 目标防护：dangling symlink 不覆盖、不沿链写出受控目录；256 个稳定候选全占用时有界失败且保留既有项 | `tests/patchsync.test.js` |
| patch 本地不可读 → VALIDATION 快败；scp 失败 → 整体快败 | `tests/harness/harness.test.js`（scp-fail） |
| ssh 统一参数、`sh -c <shq(body)>` 双层包装 | `tests/lib/ssh.test.js`、`tests/lib/shq.test.js` |
| ssh 超时 TERM→2s→KILL 强杀链 | `tests/lib/ssh.test.js`、`tests/harness/harness.test.js`（conn-timeout） |
| 每主机串行队列（串行 / 前序失败不阻断 / 跨主机并行 / 队列超时） | `tests/lib/ssh.test.js` |

## 2.1 本机 transport 与 harness 全链

| 分支 / 场景 | 覆盖 |
|---|---|
| `sshExec` / `localExec` 接受有界 binary stdin，拒绝非 Buffer/Uint8Array 与超限输入，spawn/error/EPIPE/abort 都安全收口；`localExec` argv 为可覆盖前缀 + `-c` + 原始协议正文，ExecResult、2 MiB 留尾、timeout / AbortSignal 的 TERM→KILL 语义与 ssh 一致，本机失败归 `LOCAL_TIMEOUT / LOCAL_EXEC_FAILED` | `tests/lib/ssh.test.js`（stdin / argv / 结果形状 / 输出封顶 / timeout / abort）、`tests/launcher.test.js` |
| `localCopy` 目标只许在真实 HOME 的 `.dsh_center_remote/` 内：拒绝绝对路径、`..`、NUL、中间目录 symlink；同目录临时文件提交，源失败/预中止不留正式文件，rename 后迟到 abort 不回滚 | `tests/lib/ssh.test.js`（正常复制 / 提交点 / 路径穿越 / symlink / 失败与中止） |
| ssh / localExec / localCopy 共用在飞账本与关停闩：关停收敛、闩后不启动、`reopenSsh` 恢复；本机 copy/exec 错误不伪装成 SSH 错误 | `tests/lib/ssh.test.js`（`shutdownSsh`、`liveChildCount`、共享闩、`execFailure`） |
| PROBE 与 LAUNCH/POLL/VERIFY/STOP/LOG 只按显式 `local` 分流；同一 proto builder 输出逐字一致，普通主机名不触发本机猜测 | `tests/prober.test.js`、`tests/launcher.test.js` |
| 配置身份：旧 config 缺 `local` 按 false 迁移且不升版本；`local:true` 要求 `localPort:null`、全配置最多一条，HostView 顶层回传身份；本机不与 SSH Host 合并 | `tests/lib/validate.test.js`、`tests/store.test.js`、`tests/contract/schemas.test.js` |
| `localExec` 以 `-c <raw proto body>` 进入本机垫片；与 fake-ssh 共用唯一协议 dispatcher，远端 HOME 仍为 `/root`、本机 HOME 为隔离临时目录 | `tests/harness/harness.test.js`（远端 `/root` 快照回归）、`tests/harness/local-flow.test.js` |
| 本机 PROBE ready → LAUNCH/POLL/VERIFY → direct entry → `/api/health` 200 → HostView.mappedUrl 恒等映射 → STOP 后 ready 且进程/state 清空 | `tests/harness/local-flow.test.js`「本机全链」 |
| 本机不 spawn fake-ssh `-N -L`、`tunnel._childPid() === null`；不调用映射端口池且 `config.localPort` 始终为 null | `tests/harness/local-flow.test.js`（transport 账本 + 端口池注入计数） |
| 本机 patch 与用户源共用目录：`local:true` 永久跳过 cleanup；每轮都对既有初始目标/摘要候选核对真实文件与内容，相同才复用、未知内容则有界避让；跨轮 `[A,B] → [A]` 不覆盖已移除 B，PATCH_ARGS 仍指向 A 内容；空格 / Unicode / 前导 `-` 与 symlink 源均不进入 cleanup API | `tests/launcher.test.js`、`tests/harness/local-flow.test.js` |
| 本机进程崩溃：HTTP 失败后巡检经同一 VERIFY 判死，清 direct entry 并 `running → crashed` | `tests/harness/local-flow.test.js`「本机巡检」 |
| 本机 PID 复用：STOP 指纹不符返回 `KILL_REFUSED`，保留 state.web / direct entry / mappedUrl 与存活进程；后续巡检不退化为 no-tunnel | `tests/harness/local-flow.test.js`「本机停止」 |
| 本机 STOP timeout：保留 running 与 direct entry / mappedUrl，后续巡检仍正常；再次 STOP 成功后才清 web / direct / mappedUrl | `tests/harness/local-flow.test.js`「STOP timeout」 |
| 本机 settings-file 复用同一模板、解析器、CAS 与固定路径规则，经 stdin 完成 missing→create→read→update→stale；不经过 fake ssh | `tests/harness/local-flow.test.js`、`tests/settings-file.test.js` |
| 本机 Workspace 登记直接走实际 web 端口；远端登记只走既有 SSH 本机映射，两者都不新增远端 CLI/落地物或任意 RPC 代理 | `tests/harness/local-flow.test.js`、`tests/integration/workspace.test.js` |

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
| 巡检循环 start/stop 幂等：重复启动不叠定时器，停止后释放 | `tests/monitor.test.js` |
| 深复核协议损坏保留 running 与现有恢复线索；远端存活但隧道重建失败归 restart-failed，不误报 crashed | `tests/monitor.test.js` |
| 关停撞上重连的一拍：复核回来后不再重建隧道，本进程名下无孤儿子进程 | `tests/integration/resilience.test.js`「关停正撞上重连的一拍」 |
| 关停收走在飞的一次性 ssh（TERM→KILL），且落闩不再起新的 | `tests/lib/ssh.test.js`（`shutdownSsh` 两条） |
| 本机 direct entry 恒等端口、无子进程、HTTP 直达实际 web 端口；崩溃巡检不走隧道重建 | `tests/tunnel.test.js`、`tests/harness/local-flow.test.js` |

## 4. 故障注入场景库（`tests/harness/scenarios.js` 30 个）

场景名即 ID：`SCENARIOS` 加了一个键而这里没登记，`npm run matrix:gate` 即红。

| ID（场景） | 覆盖它的用例 |
|---|---|
| `SCN:healthy` | 全部集成主干（flows / loop / cli / sse / setup） |
| `SCN:settings-missing` | `tests/integration/settings.test.js`（missing→create） |
| `SCN:settings-existing` | `tests/integration/settings.test.js`（GET/PUT/backup/stale 主干） |
| `SCN:settings-empty` | `tests/integration/settings.test.js`（零字节存在态） |
| `SCN:settings-invalid-utf8` | `tests/integration/settings.test.js`（422 且不泄漏原始字节） |
| `SCN:settings-exact-cap` | `tests/integration/settings.test.js`（精确 512 KiB GET/PUT） |
| `SCN:settings-too-large` | `tests/integration/settings.test.js`（超一字节即 413） |
| `SCN:settings-unsupported` | `tests/integration/settings.test.js`（501，其他生命周期协议不受影响） |
| `SCN:settings-read-fail` | `tests/integration/settings.test.js`（固定目标读取失败） |
| `SCN:settings-protocol-corrupt` | `tests/integration/settings.test.js`（CRC/成功帧损坏） |
| `SCN:settings-write-fail` | `tests/integration/settings.test.js`（提交前失败不改正式文件） |
| `SCN:settings-staging-catastrophic` | `tests/integration/settings.test.js`（灾难中断后的 reserved staging 收敛） |
| `SCN:settings-write-unknown-before-commit` | `tests/integration/settings.test.js`（提交前结果未知） |
| `SCN:settings-write-unknown-after-commit` | `tests/integration/settings.test.js`（已提交但响应未知，必须 GET） |
| `SCN:settings-write-unknown` | `tests/integration/settings.test.js`（兼容 unknown-after-commit 场景名） |
| `SCN:settings-change-before-second-cas` | `tests/integration/settings.test.js`（backup 后外部改写，二次 CAS 拒绝覆盖） |
| `SCN:no-dsh-missing-bin` | `tests/harness/harness.test.js`、`tests/integration/flows.test.js` |
| `SCN:no-dsh-unusual-path` | `tests/harness/harness.test.js`、`tests/integration/cli.test.js` |
| `SCN:canon-login-only` | `tests/integration/flows.test.js`（dsh 只在 canon 目录、不在非交互 PATH：start 必须用探测解析出的绝对路径） |
| `SCN:no-dsh-no-profile` | 同上 |
| `SCN:unreachable` | 同上 + IT-01 |
| `SCN:hostkey-fail` | `tests/harness/harness.test.js` |
| `SCN:conn-timeout` | `tests/harness/harness.test.js`（强杀链） |
| `SCN:bind-busy-once` | `tests/harness/harness.test.js`、`tests/integration/flows.test.js`、IT-03 |
| `SCN:bind-busy-twice` | `tests/harness/harness.test.js`、`tests/integration/flows.test.js`（IT-04 的替身） |
| `SCN:launch-dies` | `tests/harness/harness.test.js`、`tests/integration/flows.test.js`、`tests/integration/cli.test.js` |
| `SCN:forward-disabled` | `tests/integration/resilience.test.js`（两条：挂起不退避 / 挂起期间 stop；IT-10 的替身） |
| `SCN:no-ss` | `tests/harness/harness.test.js` |
| `SCN:workdir-missing` | `tests/harness/harness.test.js`（含「对 workdir=null 无效」）、`tests/integration/flows.test.js`；真机侧见 IT-14（用户手动） |
| `SCN:no-proc-cwd` | `tests/harness/harness.test.js`（CWD 降级 + 不误杀判据不受影响）、`tests/web/mount.test.js`（UI 显示「—」） |
| `SCN:scp-fail` | `tests/harness/harness.test.js` |
| `SCN:slow-probe` | `tests/harness/harness.test.js`（并行探测不互相阻塞） |

## 5. HTTP / SSE 契约（13 文档，TST-05）

## 5.1 新增能力登记（F1 / F2）

| 行为 ID | 覆盖 |
|---|---|
| `API:GET /api/sidecar/status` | `tests/analysis.test.js`、真机 `dshc status` |
| `API:POST /api/analysis/fleet` | `tests/analysis.test.js`、真机 Center 舰队分析 |
| `API:POST /api/hosts/:name/adopt` | `tests/cli.test.js`、`tests/integration/flows.test.js`（多候选：盲领养被拒 / 指定 PID 只登记那一个）、真机标准 8899 只读领养 |
| `UI:多手动实例挑一个领养` | `tests/web/actions.test.js`、`tests/web/mount.test.js`（候选单选、端口未知禁用、全禁用只剩强拉） |
| `FSM:ready→running` `FSM:crashed→running` | `tests/lib/machine.test.js`、真机领养恢复 |
| `ERR:ADOPTION_AVAILABLE` `ERR:ADOPT_REFUSED` `ERR:PORT_UNKNOWN` | `tests/cli.test.js`、`tests/prober.test.js` |
| `CLI:cleanup` | `tests/cleanup.test.js`、真机 dry-run/apply 清理护栏 |

| 面 | 覆盖 |
|---|---|
| 全部 REST 响应逐一过 schema 校验 | `tests/contract/schemas.js` 接入 `tests/integration/*.test.js` |
| 契约漂移检测（改名 / 多键 / 枚举越界 / null 语义 / 时间戳形态） | `tests/contract/schemas.test.js` |
| DSH Center → Agent Sidecar C2 字段/类型、C3 资格语义、C4 config/state 最小回退结构 | `tests/contract/agent-sidecar-consumer.test.js`、`tests/contract/fixtures/ls-json.v1.json` |
| 202 受理体（accepted + operationId uuid v4） | `tests/contract/schemas.test.js`、`tests/integration/flows.test.js` |
| SSE snapshot 首帧 / 心跳 / 断开摘除 / debounce 合并 | `tests/api.test.js`、`tests/integration/sse.test.js` |
| SSE revision 单调 + 帧类型白名单 | `tests/integration/sse.test.js`、`tests/contract/schemas.test.js` |
| `POST /api/hosts/sync-config` 请求契约：固定五个 profile 路径，排除身份/启用/自启/localPort/运行态；空/重复/源混入/缺失/超过 200 目标整单拒绝，主机查找只认 own property | `tests/config-sync.test.js`、`tests/api.test.js`、`tests/lib/validate.test.js`、`tests/contract/schemas.test.js` |
| 批量同步响应的条件契约：`dryRun:true` 必须带 opaque `previewToken` 且 applied/hosts 为空；`dryRun:false` 不回 token 并返回应用结果，判别字段缺失或非法不能误入任一分支 | `tests/api.test.js`、`tests/demo-contract.test.js`（共用 `tests/contract/schemas.js`） |
| preview token 绑定源、目标集合与五类同步字段：对象/目标顺序稳定且不泄漏 secret；源或任一目标的 profile 变化、会话重置（manager 重启边界）都会 `CONFIG_STALE`，范围外字段变化不误判；apply 在提交点重新核对后只做一次原子落盘，全一致时不重写 | `tests/config-sync.test.js`、`tests/api.test.js`、`tests/demo-contract.test.js`、`tests/integration/ui-live.test.js` |
| 主机配置与全局默认经真 PUT 持久化并由 SSE/REST/页面 store 收敛；`CONFIG_STALE` 返回 409 且磁盘逐字不变 | `tests/integration/flows.test.js`、`tests/integration/ui-live.test.js` |
| `GET/PUT /api/hosts/:name/dsh-settings` 只接受无 query、无尾斜杠的固定资源；先过 setup/主机/body/schema/UTF-8/512 KiB 校验，再在 hostQueue 队首重查主机与 local 身份；同主机最多一个 settings 操作占位，忙时 409 快败 | `tests/api.test.js`、`tests/settings-file.test.js`、`tests/integration/settings.test.js` |
| settings 响应契约覆盖 missing/existing 与 write 结果；CAS stale/too-large/invalid-UTF8/unsupported/read-write fail/transport unknown 映射稳定，非成功响应、解析错误、toast/detail 不回显 content、hex、stdin、stderr 或任意服务端 code | `tests/contract/schemas.js`、`tests/api.test.js`、`tests/settings-file.test.js`、`tests/integration/settings.test.js`、`tests/web/actions.test.js` |
| `POST /api/hosts/:name/dsh-workspace` 只接受严格空对象且不接收路径；setup/主机/phase/已保存并实际生效的 workdir/CWD/环回映射在调用前与队首复核，同主机并发快败；首次与重复登记返回同一最小契约且不改 HostView/config/revision/SSE | `tests/api.test.js`、`tests/dsh-workspace.test.js`、`tests/contract/schemas.test.js`、`tests/integration/workspace.test.js` |
| 请求体解析边界（空体 / 非法 JSON / 超限 → VALIDATION） | `tests/api.test.js` |
| 错误码族与 HTTP 状态映射（VALIDATION/PHASE_CONFLICT/KILL_REFUSED/NOT_FOUND/SETUP_REQUIRED…） | `tests/integration/flows.test.js`、`tests/integration/setup.test.js` |
| setup 门禁：未初始化时白名单外全 409 | `tests/integration/setup.test.js`、IT-12（页面侧人工） |
| `POST /api/hosts/local`：缺省 hostname / 自定义名的 201、单例与名称冲突 409、setup gate 拒绝；创建后 HostView 与 SSE 都带 `local:true` | `tests/api.test.js`、`tests/demo-contract.test.js`、`tests/web/hub.test.js`、`tests/web/mount.test.js` |
| 本机/SSH 身份不可经 host config patch 翻转；setup 只信内置 canonical 本机候选，重跑保留既有身份且拒绝伪装 SSH 主机 | `tests/api.test.js`、`tests/integration/setup.test.js`、`tests/cli.test.js` |
| setup 模式注入一台本机候选，probe-all 同时覆盖 local 与 ssh；提交后最多一台 local，普通已初始化启动不凭空新增 | `tests/integration/setup.test.js`、`tests/setup-wizard.test.js` |

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
| `dshc init` 合并 SSH 与内置本机候选：冲突时稳定改名、`--force` 复用既有 local、探测携带 transport、落盘为 `local:true/localPort:null`，未选择则不创建 | `tests/cli.test.js`、`tests/setup-wizard.test.js`、`tests/integration/setup.test.js` |

## 7. 前端逻辑与边界（10 §7 的 20 条）

| 边界（10 §7 编号） | 覆盖 |
|---|---|
| 1 iframe 崩溃不自判 / crashed 后只 reload 一次 | `tests/web/panes.test.js` |
| 2 localPort 变更整只重建 | `tests/web/panes.test.js` |
| 3 探测中途提交向导（冻结快照、迟到结果不改） | `tests/web/setup-mount.test.js`、`tests/web/setup-wizard.test.js` |
| 4 双标签与脏草稿冲突提示；表格自启等非抽屉字段不制造冲突 | `tests/web/drawer.test.js`、`tests/web/mount.test.js` |
| 5 断线与 resyncing 期间禁写，snapshot 后才恢复 | `tests/web/store.test.js`、`tests/web/actions.test.js`、`tests/web/mount.test.js`、`tests/integration/ui-live.test.js` |
| 6 请求超时但后端继续 | `tests/web/store.test.js`（pending 超时只解 loading） |
| 7 手动实例禁 stop/restart，但 degraded 仍可安全重连隧道 | `tests/web/host-rules.test.js`、`tests/web/utils.test.js`、`tests/web/tabbar.test.js`、`tests/web/panes.test.js`、`tests/web/actions.test.js` |
| 8 主机从 ssh config 消失 → orphaned | `tests/store.test.js`（mergeSshHosts）、`tests/web/utils.test.js` |
| C-02 orphaned 远程动作拒绝（start/restart/stop/probe/reconnect/log/settings/Workspace/sync）与本机保留 | `tests/api.test.js`、`tests/web/actions.test.js`、`tests/web/mount.test.js` |
| C-03 清空 orphaned 仅删当前集合、回收 state/隧道并保留 local；确认框与成功/失败 toast | `tests/api.test.js`、`tests/web/actions.test.js`、`tests/web/mount.test.js`、`tests/contract/schemas.js` |
| C-04 reload 重新 loadHosts + mergeSshHosts 并返回 orphaned | `tests/api.test.js`、`tests/contract/schemas.js`、`tests/demo-contract.test.js` |
| 9 主机名特殊字符（dataset + encodeURIComponent） | `tests/web/router.test.js` |
| 10 SSE 乱序 / 重复（revision 丢旧） | `tests/web/store.test.js`、`tests/integration/sse.test.js` |
| 11 连续点击同一危险动作 | `tests/web/actions.test.js` |
| 12 degraded 已自愈时不再发重连 | `tests/web/actions.test.js` |
| 13 stop 后当前正显示 iframe | `tests/web/panes.test.js` |
| 14 配置草稿与运行态分离 | `tests/web/drawer.test.js`、`tests/web/form.test.js` |
| 启动目录输入与说明：非法值就地报错且不发请求、空串提交 null、只提交改动键；明确它是进程 CWD / 新会话无显式 Workspace 时的回落目录，不会在保存时自动登记或替换历史 Session | `tests/web/form.test.js`（`parseWorkdir`/`buildHostPatch`）、`tests/web/mount.test.js` |
| dsh Workspace 显式登记：只使用已保存且当前实例已采用的实际 CWD；未配置/未连接/待重启/CWD 不可读/manager 失联均准确禁用，dirty 草稿不越权进入请求；pending 防重入并阻止关闭，主机移除与迟到响应不写旧 DOM/泄漏路径，created 与幂等命中文案分开 | `tests/web/actions.test.js`、`tests/web/mount.test.js`、`tests/integration/workspace.test.js` |
| 远端抽屉说明 dsh web「打开配置文件」发生在目标主机，headless 主机可使用本抽屉的文件编辑器或 dsh Web 结构化设置；本机抽屉隐藏桌面限制说明 | `tests/web/mount.test.js` |
| 「重启后生效」徽标只在运行实例值与已存配置不一致时出现 | `tests/web/drawer.test.js`（`workdirPending`）、`tests/web/mount.test.js` |
| 实际工作目录展示：有值即显示，不可读显示「—」不编造 | `tests/web/mount.test.js`、`tests/integration/flows.test.js`（后端侧 `web.cwd`） |
| 15 patch 路径无效 / 同步失败提示 | `tests/web/form.test.js`、`tests/web/actions.test.js`（错误 detail 展开） |
| 16 事件洪峰 50 条环形缓冲 | `tests/web/store.test.js` |
| 17 前台模式 manager restart 被拒 | `tests/web/actions.test.js`、`tests/web/mount.test.js`（确认后才发请求）、`tests/integration/setup.test.js`（前台只给 restartRequired） |
| 18 setup JSON 手工删字段 | `tests/web/setup-wizard.test.js`、`tests/web/setup-mount.test.js` |
| 19 新端口迁移超时 | `tests/web/setup-mount.test.js`、`tests/web/setup-wizard.test.js` |
| 20 GET 首屏与 SSE 全量交错 | `tests/web/store.test.js`（mergeFetchedHosts） |
| REST/SSE 跨域乱序：hosts 与 config 各自维护 revision 水位；操作响应受请求 guard、单主机 revision 与全量 snapshot epoch 共同约束，迟到响应不得回滚新值或复活已被 reset 删除的主机 | `tests/web/store.test.js`、`tests/web/actions.test.js`、`tests/integration/ui-live.test.js` |
| 首屏即 host 路由（书签 / 刷新 / `dshc open <host>`）：主机集合迟到也不改写地址；到齐后建 iframe | `tests/web/mount.test.js`（用 responder 把 `/api/hosts` 卡住造出迟到）、`scripts/ui-smoke.mjs` S10 |
| 主机真从状态里消失（≠ 尚未同步）→ 回 Hub | `tests/web/mount.test.js`（snapshot 整体替换掉该主机） |
| 切主机时激活标签滚进可视区；同一路由重渲染不再滚（否则用户自己拖的位置会被拽回去） | `tests/web/mount.test.js`（垫片记 `scrollIntoView` 的账）、`scripts/ui-smoke.mjs` S11（真滚了多少像素） |
| 路由反转：`#/hub` 默认起始页、`#/manage` 次级管理页、非法路由回 Hub；根入口只在 lastHost 仍可开且启用时恢复，品牌链接始终直达 Hub | `tests/web/router.test.js`、`tests/web/mount.test.js`、`scripts/ui-smoke.mjs` S1/S10 |
| Hub：五种可开态卡片、不可用/禁用折叠、空态添加本机；ready 卡片复用统一动作，一步提交 start 并进入标签，不乐观改 phase | `tests/web/hub.test.js`、`tests/web/mount.test.js`、`scripts/ui-smoke.mjs` S4h |
| 常驻标签与收纳：enabled 的 ready/starting/running/degraded/crashed 常驻；其余进入 `+N`，可探测或去管理；ready 标签一步拉起 | `tests/web/tabbar.test.js`、`tests/web/mount.test.js`、`tests/web/ui-live.test.js` |
| 管理次级入口：顶栏 `⌂ 管理`、Hub 链接、标签菜单「在管理台查看」并展开抽屉；manage 页头有原生按钮直达 Hub，断线时导航仍可用而全量探测/重载禁用 | `tests/web/mount.test.js`、`tests/web/ui-live.test.js`、`tests/integration/ui-live.test.js`、`scripts/ui-smoke.mjs` S9/S9b |
| 管理布局：页头操作与主机卡内容共用 border+padding token 的 15px 内缘；≤620px 页头动作和双卡区稳定换为单列 | `tests/web/layout.test.js` |
| 标签菜单「在新窗口打开」只消费后端 `mappedUrl`，切断 opener；本机显示徽标且不暴露 SSH/orphan/reconnect 文案 | `tests/web/mount.test.js`、`tests/web/tabbar.test.js` |
| 单一规则源：Hub/Tab 主入口分类、enabled/managed 判据、8 态生命周期动作矩阵、手动实例安全边界 | `tests/web/host-rules.test.js`、`tests/web/hub.test.js`、`tests/web/tabbar.test.js`、`tests/web/utils.test.js`、`tests/web/panes.test.js` |
| 单一展示源：本机/远端状态、诊断提示、dsh 摘要与确认映射在表格、Hub、overflow、抽屉、向导、深链占位一致 | `tests/web/host-presentation.test.js`、`tests/web/mount.test.js`、`tests/web/setup-mount.test.js` |
| `+N` overflow：ArrowDown 打开、上下/Home/End 遍历、Escape 关闭并还焦；按 data-host 只探测选中主机 | `tests/web/mount.test.js` |
| 运行期 autoStart 只有主机表一个编辑入口；抽屉保存其他字段不携带/回滚 autoStart | `tests/web/form.test.js`、`tests/web/drawer.test.js`、`tests/web/mount.test.js` |
| 批量同步原生 dialog：源/目标互斥、最多 200 目标；预览只显字段名、不把 secret 值放进 DOM；apply 原样转发 preview token，源/任一目标变化后的 `CONFIG_STALE` 会就地要求重预览；preview/apply 竞态与迟到响应都以 revision/SSE 为真相，运行实例标明下次重启生效 | `tests/web/actions.test.js`、`tests/web/mount.test.js`、`tests/integration/ui-live.test.js`、`scripts/ui-smoke.mjs` S14 |
| 批量同步失败：pending 释放、旧结果作废、禁止重复应用；本次错误在原生 dialog 内可访问展示且按文本渲染，不会误取并发 toast | `tests/web/actions.test.js`、`tests/web/mount.test.js` |
| 主机抽屉/全局默认保存：字段级三方合并分别认领 workdir 与 inject 子字段，吸收未编辑字段、保留本地已编辑字段，双方等价改动不假冲突；保存只发相对最新 baseline 的用户 diff；`CONFIG_STALE` 保草稿，映射区间下限 1024 | `tests/web/drawer.test.js`、`tests/web/form.test.js`、`tests/web/mount.test.js`、`tests/integration/ui-live.test.js` |
| dsh 配置文件编辑器按按钮惰性加载（打开抽屉不取 secret），只展示后端解析路径；GET/PUT payload 与错误全面脱敏，dirty/保存中/主机配置保存中共同参与关闭保护；CAS stale/unknown 重新加载会保留只读旧草稿供手工合并，成功保存或关闭清除副本 | `tests/web/actions.test.js`、`tests/web/mount.test.js` |
| 抽屉并发与移除：主机配置保存中锁定字段且不可关闭，迟到响应受 revision/reset epoch guard 约束，不覆盖后续输入、不复活已删除主机；强制移除会关闭确认框、把 settings 保存结果安全转为 toast，并将焦点落回仍连接的管理入口 | `tests/web/actions.test.js`、`tests/web/mount.test.js`、`tests/web/a11y.test.js` |
| manager 当前监听端口与 configured port 分离；保存、跨标签更新、重连 snapshot 后「重启生效」提示均按两者真实差异派生 | `tests/web/store.test.js`、`tests/web/actions.test.js`、`tests/web/mount.test.js`、`tests/integration/ui-live.test.js` |
| 抽屉模态期间 toast 留在 aria-live 中但控件退出 Tab 环，确认框仍可操作；抽屉关闭恢复交互，toast 自动/手动关闭与 destroy 都清理定时器 | `tests/web/a11y.test.js`、`tests/web/toast-region.test.js` |
| toast 关闭时序按档位派生：error 不自动关（`null` 表示不关，不再被 `??` 兜成 5 秒）、info/success 5s、warn 8s，调用方显式 `timeoutMs` 优先（issue #114） | `tests/web/toast-region.test.js` |
| toast 区按 id 复用节点：新增一条、同一条重复计数、关掉中间一条都不重建幸存节点，`<details>` 展开状态与焦点留在原处（issue #114；dom-shim 照真浏览器把「移除含焦点的子树」判为焦点回落 body） | `tests/web/toast-region.test.js` |
| iframe 首载：本机/远端 loading 在 `load` 后隐藏，切页 keep-alive 不重置；recreate/reload 重现 loading，后端 phase 遮罩优先且 starting 无 URL 时有可访问占位 | `tests/web/panes.test.js`、`tests/web/a11y.test.js`、`tests/web/ui-live.test.js`、`scripts/ui-smoke.mjs` S4h/S7b |
| 无障碍：键盘链路 / `[hidden]` 不吃焦点 / 状态不只靠颜色 | `tests/web/a11y.test.js`、`tests/web/utils.test.js`；渲染观感见 UI-28 人工清单 |
| 抽屉的 Esc 挂在 document 上（焦点在外也能关）、开着时后景 `inert`、关掉即放开 | `tests/web/a11y.test.js` |
| 重渲染保焦：同控件还在→留在它上面；控件消失或被禁用→退到那一行；更新别人不掀我的焦点 | `tests/web/a11y.test.js`（垫片已如实建模「移除含焦点子树→焦点回 body」） |
| 错误提示随输入更新（碰过的字段才实时报）、离开字段即校验、保存时全量校验 | `tests/web/mount.test.js` |
| setup 收敛：完成与端口迁移精确进入 `#/hub`；异步配置与主机发现重渲染保留用户 raw 草稿、校验 error 与稳定身份焦点，程序化焦点恢复不重新夺取字段 ownership；端口/区间格式不同但语义等价时规范显示且不报冲突 | `tests/web/setup-wizard.test.js`、`tests/web/setup-mount.test.js`、`tests/web/router.test.js` |

`tests/web/*` 喂的是手写 fixture，抓不到「后端改了字段名 / 少一层对象」这类漂移。
`tests/integration/ui-live.test.js` 把 DOM 垫片接到真 manager（真 HTTP + 真 SSE 分帧，
只有 ssh 那一层是假的），补上前后端接缝：

| 接缝 | 覆盖 |
|---|---|
| 首屏三个 GET 全为同源相对路径（无硬编码端口） | `tests/integration/ui-live.test.js`；静态扫描另见 `tests/architecture.test.js` |
| 真 probe 结果渲染成徽章 + 真 revision 不落后于 GET | 同上 |
| 页面点「拉起」→ 真起真隧道 → iframe src 用后端给的 mappedUrl → 「关停」销毁 pane | 同上（UI-28 第 9、12 项的无头部分） |
| 未初始化时后端门禁把页面按到 `#/setup`，且不越权拉主机清单 | 同上（UI-28 第 1 项的后端侧） |
| manager 同端口重启：掉线时写按钮全禁用而返回导航可用；重连 snapshot 后主机与按钮恢复 | 同上（UI-28 第 13 项的无头部分） |
| store+DOM 恢复桥接：断线前 start pending 用真 API 的 running snapshot 结算，忙态解除且 iframe src 等于该 mappedUrl | 同上 |

垫片判不了真样式表、真焦点环、真跨 origin iframe，这三样由 `npm run ui:smoke`
（无头 Chrome + CDP，远端仍是假装置）盯住：

| 真浏览器检查 | 覆盖 |
|---|---|
| 根路由落 Hub，首屏零控制台错误、零 4xx/5xx（含 favicon 声明可取），Hub 不泄露运维写按钮 | `scripts/ui-smoke.mjs` S1；静态侧回归 `tests/integration/static.test.js` |
| ready 标签按 fixture 常驻；徽章「颜色 + 文字 + 形状」三重标识 | S2 |
| 1024 / 1440 宽不横向溢出（附截图） | S3-1024 / S3-1440 |
| 420px 窄屏保持单行薄壳，固定管理入口可见，只有主机标签区横向滚动 | S3-420 |
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
| 批量同步真键盘链路：打开后聚焦源选择，preview/apply 真请求，secret 不进 dialog 的文本、任意 attribute、动态表单 value 或递归可见的 open shadow root（closed shadow 保持浏览器边界）；360px 对话框与主要操作不越界，Escape 关闭并还焦 | S14、`tests/tooling.test.js`（S14 DOM 观测器）、`tests/integration/ui-live.test.js`、`tests/web/mount.test.js` |
| 主机表每行的分隔线连成一条：真浏览器里逐行核对 7 个 `td` 的 `display` 与下边框、行内控件顶边（`display:flex` 写在 `td` 上会让那一格退出行高均衡，把行分隔线劈成错位两段；垫片没有排版引擎，只能守住 CSS 与 DOM 形状） | S16、`tests/web/layout.test.js`、`tests/web/mount.test.js` |
| 60 次 Tab 不落进 `[hidden]` 子树 | S5 |
| 标签页菜单 Shift+F10 / ArrowDown / Esc | S6 |
| 真 iframe 跨 origin 取到远端 dsh web（200 + 帧树） | S7 |
| iframe keep-alive：切 Hub/manage/主机不换 iframe；degraded 往返不 reload、crashed 恢复只 reload 一次 | S7b |
| `prefers-reduced-motion: reduce` 下动画真为 none | S8 |
| 掉线横幅 + 禁写 + 不堆 `/api/events` 连接 | S9 |
| 深链冷启动与刷新都落在主机页（S7 走页内改 hash，抓不到「首屏即 host 路由」那条时序） | S10 |
| 标签栏溢出时激活标签仍在可视区内（视口收窄 + 长名主机撑出溢出，且先断言「不滚就够不着」防空转） | S11 |

## 7.1 Demo、站点与截图

| 交付面 | 覆盖 |
|---|---|
| 浏览器内假 manager 对齐产品路由、HostView.local、`POST /api/hosts/local`、单例约束、setup 身份保持与 SSE；批量同步也真实 preview/apply、校验源/目标变化与 reset 后 token 过期，超过 64 个无关 preview 不驱逐有效 token；settings GET/PUT 对齐固定路由、setup gate、query/尾斜杠、schema/size/UTF-8/CAS/unreachable 顺序且不落 secret；Workspace 登记同样固定空 body、按实际 CWD 幂等且 reset 清会话私有注册表；状态机仍复用产品真身 | `tests/demo-contract.test.js`、`site/demo/demo-manager.js`、`site/demo/demo-routes.js` |
| mock dsh web 提供独立侧栏/工作区轮廓、query 标识与输入保活钩子，供 iframe 的真实加载与 keep-alive 判据使用 | `tests/demo-contract.test.js`、`site/mock-dsh-web/index.html` |
| `site:check` 真浏览器走 Hub 首屏 → ready 一步拉起 → iframe → manage → 返回保活 → 断联/恢复 → setup，并检查资源 2xx 与控制台 | `scripts/site-check.mjs`；纯等待语义由 `tests/site-tooling.test.js` 覆盖 |
| `site:shots` 固定生成 Hub dashboard、manage drawer、真实 mock iframe、远端 degraded 与带本机候选的 setup；图片路径由双语 README 链接检查兜住 | `scripts/site-shots.mjs`、`scripts/site-check.mjs` |
| 双语 README 的本地链接、图片与 `dshc` 命令表同步；二级章节按显式中英映射逐节同序（含支持矩阵），缺失/额外/乱序/重复/改名均 fail closed。ATX H2 抽取忽略合法反引号/波浪号围栏，反引号 info 含反引号不成围栏，关闭符必须同类且不短于开启符，纯 closing markers 归一为空标题；畸形双语内容经导出的真实 `checkDocs` 路径也会返回结构问题 | `npm run site:check` 的 docs 子检查、`scripts/site-check.mjs`、`tests/site-tooling.test.js` |
| landing 页保留 description/favicon，并提供 `index,follow`、canonical、Open Graph 与 Twitter 的完整绝对元数据；分享图是随站点复制的 dashboard 截图 | `site/index.html`、`scripts/build-site.mjs`、`tests/site-tooling.test.js` |
| GitHub Pages 项目子路径固定生成无时间戳的 `robots.txt` / `sitemap.xml`；robots 指向绝对项目 sitemap，sitemap 只列 canonical Pages 根与 `/demo/` 且每条 URL 都有 HTML 产物，不宣称 origin 根自动发现 | `scripts/build-site.mjs`、`tests/site-tooling.test.js` |

## 8. 架构约束（ENG-24）

| 约束 | 覆盖 |
|---|---|
| `src/` 内部依赖图无环 | `tests/architecture.test.js` |
| 分层不倒挂（lib 不依赖上层、前端不依赖后端） | 同上 |
| 前端不碰 node 内置模块 | 同上 |
| 零 npm 依赖（运行时与测试） | 同上 |
| `setup-schema.js` 零 import（双侧共用） | 同上 |
| 覆盖总闸与分档：`src/**` 行覆盖 ≥95%；`src/lib/**` ≥90%、`src/*.js` ≥75%、`src/web/` 非 components ≥80%；components 计入 overall、单独只报告 | 同上（parseLcov / DA 加权 / 94.9% 红与 95% 绿），执行入口 `npm run coverage:gate` |
| lcov 必须包含磁盘上每个 `src/**/*.js`，缺任一文件或整份空报告即红；branch/function 只聚合诊断，不扩大行覆盖门槛 | 同上（sourceJsFiles / missingSourceFiles / coverageVerdict / BRH-BRF / FNH-FNF） |
| lcov 重复 `SF` 与重复 `DA` 按「同一行任一命中即命中」合并；仅在磁盘不存在同名真实文件时剥离运行器附加的 `?query` / `#fragment`，磁盘上真实含 `?` / `#` 的 JS 必须分别计入分母 | `tests/architecture.test.js`（parseLcov 别名合并与真实文件反例） |
| 覆盖率源码扫描 fail-closed：`src` 根、目录或文件为 symlink 都拒绝；轻量 lexer 能区分除法与 regex、字符串/template 与真实注释，按 ECMAScript Unicode 标识符边界识别 inline/trailing/template-expression 中的 Node/c8/istanbul suppression pragma | `tests/architecture.test.js`（sourceJsFiles / findCoverageSuppressions） |
| plugin 例外边界（零依赖底线的唯一例外）：根 package.json 的 dependencies/devDependencies/workspaces 三字段均无；全仓（除 node_modules/.git）package.json 清单逐字等于根 + plugin/ 两份；主体（src/tests/scripts/site 的 .js/.mjs）无任何 import/require 指向 plugin/；根 `files` 无 plugin 前缀条目 | `tests/architecture.test.js`（plugin 例外边界四条） |

## 8.1 工程化工具链（ENG-24 的交付面）

| 约束 | 覆盖 |
|---|---|
| 入口判定认软链（装到 PATH 的 dshc 是软链，判错就静默退 0） | `tests/tooling.test.js`（`isMainEntry` + 真软链跑 `dshc --help`） |
| 安装脚本不覆盖非本仓库的 dshc、PATH 缺失时当场提示 | 同上（`linkPlan` / `prefixInPath` / `pathHint`） |
| 闸门七关顺序固定为 lint → tests → ui → site → perf → pack → cli；关卡选择与摘要、`--only/--skip` 打错字要报错 | 同上（真实 `CHECK_STAGES` / `selectStages` / `summarize`） |
| tests 关内含行为清单对账（覆盖率之后）：行为清单 ↔ §11 登记 ↔ 文件引用三方不一致即红 | `tests/architecture.test.js`（§11.5 判定用例），执行入口 `npm run matrix:gate` |
| perf 关是软闸：墙钟中位数超基线 ×2.5 才判红，`--advisory` 只报不挡；PR CI 一律 advisory、cron 只在 macOS 严格 | `tests/architecture.test.js`（`perfVerdict` / `median` / 噪声地板 / 基线↔场景表同步）、`tests/tooling.test.js`（cron 那步的逐字契约），执行入口 `npm run perf:gate` |
| `scripts/lint.mjs` 固定 oxlint 版本、平台资产与 Release URL；下载归档和缓存二进制均核对固定 SHA-256，tar 只提取指定普通文件 | `tests/tooling.test.js`（`oxlintDigests` / `cachedBinaryIsTrusted` / `extractOxlintFromTar`），执行入口 `npm run check -- --only lint` |
| oxlint 告警完整显示并以当前 84 条基线为上限，新增告警即红；余下 84 条只剩两类有意为之的（顺序 await ×70、防边迭代边改的快照展开 ×14），理由逐类写在 `lint.mjs` | `tests/tooling.test.js`（`OXLINT_MAX_WARNINGS` / `oxlintArgs`） |
| 打包产物：该进的都在，`tests/`、`.local/` 不混进去 | 同上（`verifyPackFiles`），执行入口 `npm run check -- --only pack` |
| Chrome 查找跨平台（显式指定优先，缺了可跳过） | 同上（`findChrome`） |
| 递归扫描 `.github/workflows/**` 根目录与子目录的 `.yml` / `.yaml` active `uses` key：只允许 `actions/*`，且引用必须是 40 位 SHA + 可读版本注释；忽略完整注释与 sequence comment 后，在行内任意位置识别 plain/quoted `uses` mapping key，只有规范 block form 放行；冒号空格/tab、flow mapping、anchor/tag 前缀与通用 prefixed-flow 形态全部 fail closed，规范 key 下的 alias 也无法绕过白名单/pin | `tests/tooling.test.js`（目录/扩展名 fixture + `parseWorkflowUsesLine` block/flow/anchor/tag/quoted/alias fixture + `activeWorkflowUses`） |
| actionlint 固定 1.7.12 与官方 SHA-256；摘要核验早于只提取 `actionlint` 单一成员和执行，检查入口显式收齐顶层 `*.yml` / `*.yaml`；PR 标题只经 `env` 进入 shell，`run` 不直插表达式、变量加引号且 title regex 契约固定 | `tests/tooling.test.js`（actionlint 顺序/成员与 PR 输入边界） |
| 每周一 UTC 03:17 的双平台完整闸门保留手动入口、`contents: read`、顶层并发取消策略，Ubuntu 强制 `--require-browser`；Release 的 bundles 下载 → pinned provenance step → 创建 Release 顺序固定，`with.subject-path` 绑定 `.tar.gz` / `SHA256SUMS` 且 job 具备所需细粒度权限 | `tests/tooling.test.js`（周检与 Release provenance 契约） |

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
| 安装通道识别：git / bundle / npm / 认不出（含 `BUNDLE_INFO.json` 坏掉；npm 判据不抢 bundle/git 优先级） | `tests/updater.test.js`（`resolveInstall`、`collectVersionInfo`） |
| npm 通道口径：`dshc update` 只指路退 1（stderr 给 `npm i -g` 命令）、`dshc version --json` 自证 `channel: npm` 退 0 | `tests/updater.test.js`（真 CLI spawn 于 `node_modules/dsh-center` 落地形态，不 mock） |
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

## 9. 门槛核对结果（最近一次完整 `npm run check`）

最近一次完整通过的 `npm run check -- --require-browser`（2026-08-24，DOC-3 + WEB-5）
为 **1161/1161**，每个 `src/**/*.js` 均有 lcov 记录；真浏览器 Chrome **26/26**
项通过。六关全部通过：lint、测试/覆盖率、真浏览器、站点/文档、打包与 CLI。

本轮定向核对（2026-08-24）：`node --test tests/site-tooling.test.js` **22/22** 通过；
`npm run site:check -- --require-browser` 构建 **46** 个文件，docs 核对 **3** 个 HTML
页面，demo 的 **68** 个请求全为 2xx；独立 lint 关通过。完整闸门首轮通过，未触发预留的
SSH timing flake bounded retry；`git diff --check` 通过。

| 档位 | 行覆盖 | 门槛 | 结果 |
|---|---:|---:|---|
| `src/**`（overall） | 96.27%（15902/16518） | ≥ 95% | 达标 |
| `src/lib/**` | 97.95%（2291/2339） | ≥ 90% | 达标 |
| `src/*.js` | 93.65%（7064/7543） | ≥ 75% | 达标 |
| `src/web/`（不含 components） | 99.30%（2424/2441） | ≥ 80% | 达标 |
| `src/web/components/**` | 98.28%（4123/4195） | 仅报告 | 不单独设卡，仍计入 overall |

全仓 branch 与 function 仅诊断，不参与门槛。

`plugin/` **不计入主体覆盖率分母**（覆盖率源码扫描限定 `src/**`，lint 路径也不含
plugin/）；其测试由 `plugin/tests`（`npm run verify` 内含）+ CI 的 plugin lane
（ci.yml `plugin` job：`npm ci && npm run verify`）承担，门槛在 plugin/ 内自治。

## 10. 功能矩阵口径与豁免

「可自动化功能矩阵 100%」只表示：§§1–8 中每个**已实现且可自动化**的功能行，都映射到
至少一个自动化测试。它不表示源码行、branch 或 function 100%；精确代码覆盖见 §9。
五处仅真机 / 仅人工项显式列在下表，并给出可自动化替身：

| 项 | 原因 | 替身覆盖 |
|---|---|---|
| IT-04 两次拉起失败 | 真机无法让 `--port 0` 也绑定失败 | 假远端 `bind-busy-twice` |
| IT-14 启动目录真机验收（补丁 v0.0.1/01 的 WS-01/WS-10） | 需真远端读取 dsh web 进程 CWD，并在真实浏览器区分「新会话无显式 Workspace 时回落」与「恢复历史 Session」；显式登记不会改变上游目录选择器仍从 HOME 开始的行为 | 我们这侧的 cd/state/HostView/UI/CLI、固定环回代理与官方 `workspace.create` 信封均已全自动化；假远端可证明登记幂等及无旁路状态改动，但不能代替真实 dsh 存储兼容性 |
| IT-10 远端禁止转发 | 需改共享节点 sshd 配置并重启服务 | 假远端 `forward-disabled` |
| IT-12 页面向导 | 需人工点击（UI-28 清单第 1 项） | CLI 侧向导 `tests/setup-wizard.test.js`、挂载测试 `tests/web/setup-mount.test.js`、门禁跳转 `tests/integration/ui-live.test.js` |
| UI 观感（字号/对比度/留白）与灰度可辨 | 好不好看只能人眼判 | `npm run ui:smoke` 出两个宽度的截图供人过目；结构性判据（文字+形状、不溢出）已自动化 |

### 10.1 自动化补充场景

以下是跨章节故障与工程回归的补充索引，均有自动化测试，不属于豁免：

| 场景 | 覆盖 |
|---|---|
| 端口双值 review 回归：重新配置向导预填待重启的 configured port 而非 runtime port；SSE 重连 snapshot 同步断线期间改过的 configured port | `tests/web/setup-mount.test.js`、`tests/web/store.test.js`、`tests/web/mount.test.js`、`tests/integration/ui-live.test.js` |
| schema 保留键 review 回归：`constructor` / `toString` / `__proto__` 都按 own key 判定；声明过的可用，未声明的报 unknown key | `tests/lib/validate.test.js` |
| 覆盖率源码清单 review 回归：`src/` 内文件软链与目录软链都 fail-closed，不能借仓库外目标绕过 overall 总闸 | `tests/architecture.test.js` |
| demo snapshot review 回归：manager snapshot 同时满足 runtime `port` 与 `configuredPort` 契约 | `tests/demo-contract.test.js` |
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
| `manager.log` 封顶：没到顶一个字节不动；到顶原地截断（inode 不变、留尾巴、开头说明丢了多少、切在行边界）；文件不在/读不了都不抛；真进程上起来时截断且之后还能往同一个 fd 写 | `tests/lib/logfile.test.js`、`tests/integration/daemon.test.js` |
| `dshc logs -f` 跟得过那次原地截断：`size < offset` 时 offset 归零，截断后新写的行照样出来、进程不崩（封顶与「跟得住截断」是一对，缺一不算数） | `tests/integration/daemon.test.js` |
| 退避抖动：注入确定随机数时逐档等于 §5.4 上界、全 0 时等于半程；真随机下同一档会给出不同值且始终落在 [半程, 上界] | `tests/tunnel.test.js` |
| 常驻扇出闸 `createGate`：同时在内不超上限、FIFO 不饿死、内部抛错也还名额、`limit<=0` 等于不设闸 | `tests/lib/pool.test.js` |
| 16 条隧道同时断（≈合盖睡醒）：峰值并发不超跳板机额度、**每一台**都在预算内回到 running、重连时刻确实散得开（非挤在 200ms 内） | `tests/integration/wake.test.js` |
| 装置的 MaxStartups 建模：认证窗口一过就还额度（否则常驻隧道 ssh 会把额度占一辈子，伪造出「N 台永不自愈」） | `tests/harness/fake-ssh.js` |
| `--version` / `-V` 与 `version` 子命令同义（退 0、输出逐字相同）；无实例时关停的报错不许拿「手动实例」搪塞，要直说没有 | `tests/integration/cli.test.js`、`tests/integration/flows.test.js` |
| 主机离开配置：reload 后它的隧道被收掉、本机端口不再有人监听；远端实例不许被自动杀、state 留着；日志里点名「远端还在跑 pid=…」；还在配置里的那台隧道一根汗毛不动 | `tests/integration/resilience.test.js` |
| 本机端口并发分配：8 台同时首启拿到 8 个连号且回写与返回一致、同一台并发要两次只分一次也不白占号、区间不够时先到的拿满后到的报 `PORT_EXHAUSTED` | `tests/ports.test.js` |
| 远端输出封顶：留尾不留头（超上限时切在正确位置、账本自身不随吐出量增长、恰好等于上限时一个字节不丢、cap≤0 视为不封顶）；600MB 的 stdout/stderr 都不再崩进程、收上来的量封顶、末尾那行标记还在、丢弃量有记账；截断后错误 detail 与日志正文都说明「丢了多少、这是末尾」 | `tests/lib/capture.test.js`、`tests/lib/ssh.test.js` |
| 有改动时的 Esc：这一记摘掉原生默认动作（否则 CloseWatcher 把刚开的确认框顺手关掉，体感「按了没反应」），框开着时不再插手（否则 Esc 被焊死）；真键盘按下去要「弹框 → 再 Esc 收框 → 草稿还在」 | `tests/web/a11y.test.js`、`scripts/ui-smoke.mjs`（S4g，判据必须带 `keyCode: 27`，否则只惊动 JS、判不出浏览器那半边） |
| 安装器参数：不认识的旗标在 `install.sh` 与 `install.mjs` 两侧都退 3 并点名，且不留下半个安装 | `tests/install-sh.test.js` |
| 装置孤儿看护：假 dsh web 在拥有者进程消失后自行退出（运行被 Ctrl-C/SIGKILL 掐断、或收尾里断言抛错都兜住），拥有者健在期间不误杀。判据只认「垫片最后没了」，不预设拉起先成功——看护 500ms 一查，慢机上会赶在 VERIFY 前收走（issue #102） | `tests/harness/harness.test.js` |
| 装置状态原子落盘：写者狂写时锁外读到的永远是完整状态（残缺会被 `catch` 吞成空状态，伪造出 VERIFY 的「进程已消失」）| `tests/harness/harness.test.js` |
| 扇出闸：同时在飞不超上限、上限≥任务数/为 0/为负都退化成全并发、结果按入参序、单个抛错不牵连其余且空出的格子接着排、同步抛出也算 rejected；24 台共用跳板机（额度 10）时全量探测不许把好主机探成不可达 | `tests/lib/pool.test.js`、`tests/integration/scale.test.js` |
| 磁盘写不进：state 落盘失败不抛（定时器里抛 = 进程死）、报一条人话且同因只报一次、内存照旧可用、恢复可写后自己补上并报一声；退出路径 flush 失败也只记不抛且不留半个文件；`dshc up` 遇 pidfile/manager.log 打不开时给人话与常见成因、不吐 Node 栈 | `tests/store.test.js`、`tests/integration/daemon.test.js` |
| 等待中被 Ctrl-C：真进程 + 真 SIGINT，退 130 而非被信号掐掉、留下「不等了 / 仍在继续 / 去哪儿看」三要素，且那趟拉起确实继续跑到 running（按状态而非按时长下手，starting 窗口约 700ms）；退出码表不许撞号 | `tests/integration/cli.test.js`、`tests/cli.test.js` |
| 重绘合帧：同一拍内 500 次触发只排一个帧回调、画完能再排上（否则从此不再刷新）、没有 rAF 的环境退化成定时器；真浏览器里 1500 条事件只引起百位数的 DOM 变更且最长任务 < 1.2s（摘掉合帧即 14.7 万次），判据先自证页面拿得到帧、面板过滤已归零，避免空转 | `tests/web/utils.test.js`、`scripts/ui-smoke.mjs`（S12） |
| 单调钟：墙钟被换成 0 / 回拨一小时都不倒退、量的是真实流逝；`dshc down` 的宽限期遇墙钟回拨 6s 仍在 1s 上界内补 SIGKILL（此前被拖成 7.3s）；页面上后到的快照时刻不因跳变判反先后；静态闸门：后端源码里 `Date.now()` 只许留在就地标注「墙钟」的展示位 | `tests/lib/clock.test.js`、`tests/integration/daemon.test.js`、`tests/web/store.test.js`、`tests/architecture.test.js` |
| 请求体超限：超一点点先读完再回 400（人话 + VALIDATION，值一个字节都不落盘）、灌超大体时掐链但 manager 照常服务；目录穿越的多种编码形态（`..%2f`、`%2e%2e`、`.%2e`、`....//`、后缀式）一律 403/404 且不漏内容 | `tests/integration/security.test.js`、`tests/integration/static.test.js` |
| 标签栏方向键：落点纯函数（左右环绕、Home/End、焦点不在环上时从头算、空标签栏不算、ArrowDown/Enter 不许被抢）；挂载后左右真移焦点且不切页、Tab 落点收成一个并跟着选中标签走、没有游荡在 tablist 之外的 `role="tab"`；真浏览器里原生按键真派到焦点标签上、Enter 才切页（摘掉方向键即红） | `tests/web/tabbar.test.js`、`tests/web/a11y.test.js`、`scripts/ui-smoke.mjs`（S13） |
| 收尾兜底：到点仍有句柄就报出句柄名（同名不重复念）并带原退出码硬退、保险自身已 unref（不许拖慢干净的收场）、问不出句柄名也照样退；CDP 应答到手即清超时定时器（不清则收尾空等 20s） | `tests/tooling.test.js` |

### 10.2 可执行旅程锚点

§§1–8 的功能行由 `scripts/acceptance-journeys.mjs` 定义旅程，再由下表保存
可审计的章节锚点；`npm run journey:check` 会同时核对旅程和这些链接。

| 功能章节 | 旅程 |
|---|---|
| §1 | `JOURNEY:center-first-run` |
| §2 | `JOURNEY:remote-host-closed-loop` |
| §3 | `JOURNEY:remote-resilience` |
| §4 | `JOURNEY:configuration-and-safety` |
| §5 | `JOURNEY:management-and-reload` |
| §6–§8 | `JOURNEY:safe-failure-surfaces` |

## 11. 行为清单登记（机器核对）

上面的章节是给人读的；这一节连同 §1 的 `FSM:` 与 §4 的 `SCN:` 是给机器对账的。
`scripts/lib/inventory.mjs` 不看这份文档，直接从源码算出七个面的行为清单
（`API` 路由表、`FSM` 迁移表、`SCN` 场景表、`EXIT` 远端退出码、`ERR` 错误码、
`CLI` 命令表、`CLI_EXIT` CLI 退出码契约），`npm run matrix:gate` 三方对账：

- 清单里有、这里没登记 → 红「新增行为未登记」（加了路由/场景/退出码却忘了写矩阵）；
- 这里登记了、清单里没有 → 红「死行为」（代码删了，矩阵还留着）；
- 引用的 `tests/` `scripts/` `src/` `site/` 路径不存在 → 红「矩阵引用悬空」。

自动化确实覆盖不了的，同一行写 `EXEMPT(真机)：理由` 一类标记（理由必填，否则也红），
豁免清单另见 §10。

### 11.1 REST 路由（`API:`）

| ID | 覆盖 |
|---|---|
| `API:GET /api/hosts` | `tests/api.test.js`、`tests/integration/flows.test.js`、`tests/contract/schemas.test.js` |
| `API:GET /api/config` | `tests/api.test.js`、`tests/integration/flows.test.js` |
| `API:GET /api/manager/info` | `tests/api.test.js`、`tests/integration/daemon.test.js` |
| `API:GET /api/events` | `tests/api.test.js`、`tests/integration/sse.test.js` |
| `API:GET /api/hosts/:name/log` | `tests/api.test.js`、`tests/integration/flows.test.js`、`tests/integration/cli.test.js` |
| `API:GET /api/hosts/:name/dsh-settings` | `tests/api.test.js`、`tests/integration/settings.test.js`、`tests/settings-file.test.js` |
| `API:PUT /api/hosts/:name/dsh-settings` | `tests/api.test.js`、`tests/integration/settings.test.js`、`tests/settings-file.test.js` |
| `API:POST /api/hosts/:name/dsh-workspace` | `tests/api.test.js`、`tests/dsh-workspace.test.js`、`tests/integration/workspace.test.js` |
| `API:POST /api/hosts/local` | `tests/api.test.js`、`tests/demo-contract.test.js` |
| `API:POST /api/hosts/sync-config` | `tests/api.test.js`、`tests/config-sync.test.js`、`tests/integration/ui-live.test.js` |
| `API:POST /api/hosts/clear-orphaned` | `tests/api.test.js`、`tests/demo-contract.test.js`、`tests/web/actions.test.js` |
| `API:POST /api/hosts/clear-blocked` | `tests/integration/flows.test.js`、`tests/demo-contract.test.js`、`tests/web/actions.test.js` |
| `API:PUT /api/hosts/:name/config` | `tests/api.test.js`、`tests/integration/flows.test.js`、`tests/integration/cli.test.js` |
| `API:PUT /api/config/defaults` | `tests/integration/flows.test.js`、`tests/integration/setup.test.js` |
| `API:POST /api/reload` | `tests/integration/flows.test.js`、`tests/integration/resilience.test.js` |
| `API:POST /api/setup` | `tests/api.test.js`、`tests/integration/setup.test.js` |
| `API:POST /api/manager/restart` | `tests/integration/daemon.test.js`、`tests/web/actions.test.js` |
| `API:POST /api/manager/shutdown` | `tests/integration/daemon.test.js`（`dshc down` 走的就是它）、`tests/demo-contract.test.js` |
| `API:POST /api/hosts/probe` | `tests/api.test.js`、`tests/integration/flows.test.js`、`tests/integration/scale.test.js` |
| `API:POST /api/hosts/:name/probe` | `tests/api.test.js`、`tests/integration/flows.test.js` |
| `API:POST /api/hosts/:name/start` | `tests/integration/flows.test.js`、`tests/integration/loop.test.js` |
| `API:POST /api/hosts/:name/stop` | `tests/integration/flows.test.js`、`tests/integration/resilience.test.js` |
| `API:POST /api/hosts/:name/restart` | `tests/api.test.js`、`tests/integration/flows.test.js` |
| `API:POST /api/hosts/:name/reconnect` | `tests/integration/resilience.test.js`、`tests/integration/flows.test.js` |

### 11.2 远端脚本退出码（`EXIT:`）

改协议模板新增分支时，先来这张表确认没撞号（AGENTS.md「退出码占用表」）。

| ID | 语义 | 覆盖 |
|---|---|---|
| `EXIT:1` | settings 能力不满足 / 读取失败的通用失败 | `tests/lib/proto.test.js`、`tests/integration/settings.test.js` |
| `EXIT:8` | LAUNCH 的 workdir 进不去（`ERR=workdir`） | `tests/lib/proto.test.js`、`tests/harness/harness.test.js` |
| `EXIT:9` | patches 目录 mkdir 失败（LAUNCH 与 CLEAN 共用） | `tests/lib/proto.test.js`、`tests/launcher.test.js` |
| `EXIT:10` | settings 超过 512 KiB | `tests/lib/proto.test.js`、`tests/integration/settings.test.js` |
| `EXIT:11` | settings CAS 基线陈旧 | `tests/lib/proto.test.js`、`tests/integration/settings.test.js` |
| `EXIT:12` | settings 写失败 | `tests/lib/proto.test.js`、`tests/integration/settings.test.js` |

### 11.3 错误码（`ERR:`）

| ID | 覆盖 |
|---|---|
| `ERR:VALIDATION` | `tests/api.test.js`、`tests/lib/validate.test.js`、`tests/integration/cli.test.js` |
| `ERR:NOT_FOUND` | `tests/api.test.js`、`tests/integration/flows.test.js` |
| `ERR:SETUP_REQUIRED` | `tests/integration/setup.test.js`、`tests/api.test.js` |
| `ERR:PHASE_CONFLICT` | `tests/api.test.js`、`tests/integration/flows.test.js` |
| `ERR:NOT_ALLOWED` | `tests/api.test.js`、`tests/integration/flows.test.js` |
| `ERR:FORBIDDEN_ORIGIN` | `tests/lib/origin-guard.test.js`、`tests/integration/security.test.js` |
| `ERR:FORBIDDEN_HOST` | `tests/lib/origin-guard.test.js`、`tests/integration/security.test.js` |
| `ERR:PORT_EXHAUSTED` | `tests/ports.test.js`、`tests/integration/loop.test.js` |
| `ERR:SSH_UNREACHABLE` | `tests/lib/ssh.test.js`、`tests/harness/harness.test.js` |
| `ERR:SSH_TIMEOUT` | `tests/lib/ssh.test.js`、`tests/harness/harness.test.js` |
| `ERR:LOCAL_TIMEOUT` | `tests/lib/ssh.test.js`、`tests/harness/local-flow.test.js` |
| `ERR:LOCAL_EXEC_FAILED` | `tests/lib/ssh.test.js`、`tests/settings-file.test.js` |
| `ERR:LOCAL_COPY_FAILED` | `tests/lib/ssh.test.js`、`tests/patchsync.test.js` |
| `ERR:LOCAL_HOST_EXISTS` | `tests/api.test.js` |
| `ERR:LOCAL_NAME_CONFLICT` | `tests/api.test.js` |
| `ERR:PROTO_PARSE` | `tests/lib/proto.test.js`、`tests/monitor.test.js` |
| `ERR:SETTINGS_TOO_LARGE` | `tests/settings-file.test.js`、`tests/integration/settings.test.js` |
| `ERR:SETTINGS_BUSY` | `tests/settings-file.test.js`、`tests/integration/settings.test.js` |
| `ERR:SETTINGS_STALE` | `tests/settings-file.test.js`、`tests/integration/settings.test.js` |
| `ERR:SETTINGS_WRITE_FAILED` | `tests/settings-file.test.js`、`tests/integration/settings.test.js` |
| `ERR:SETTINGS_READ_FAILED` | `tests/settings-file.test.js`、`tests/integration/settings.test.js` |
| `ERR:SETTINGS_UNSUPPORTED` | `tests/settings-file.test.js`、`tests/integration/settings.test.js` |
| `ERR:SETTINGS_INVALID_UTF8` | `tests/settings-file.test.js`、`tests/integration/settings.test.js` |
| `ERR:WORKSPACE_BUSY` | `tests/dsh-workspace.test.js` |
| `ERR:WORKSPACE_WORKDIR_REQUIRED` | `tests/dsh-workspace.test.js`、`tests/integration/workspace.test.js` |
| `ERR:WORKSPACE_CWD_UNAVAILABLE` | `tests/dsh-workspace.test.js` |
| `ERR:WORKSPACE_INVALID_PATH` | `tests/dsh-workspace.test.js` |
| `ERR:WORKSPACE_REGISTER_FAILED` | `tests/dsh-workspace.test.js` |
| `ERR:WORKSPACE_REGISTER_TIMEOUT` | `tests/dsh-workspace.test.js` |
| `ERR:LAUNCH_FAILED` | `tests/harness/harness.test.js`、`tests/integration/flows.test.js` |
| `ERR:KILL_REFUSED` | `tests/integration/flows.test.js`、`tests/harness/local-flow.test.js`、`tests/adversarial/fingerprint.test.js` |
| `ERR:TUNNEL_FORWARD_DISABLED` | `tests/tunnel.test.js`（`SUSPEND_REASONS` 分类）、`tests/integration/resilience.test.js`（`SCN:forward-disabled` 挂起不退避） |
| `ERR:TUNNEL_PORT_BUSY` | `tests/tunnel.test.js`、`tests/ports.test.js` |
| `ERR:STATE_ILLEGAL_TRANSITION` | `tests/lib/machine.test.js`、`tests/store.test.js` |
| `ERR:CONFIG_WRITE_FAILED` | `tests/store.test.js` |
| `ERR:CONFIG_STALE` | `tests/store.test.js`、`tests/config-sync.test.js`、`tests/integration/cli.test.js` |
| `ERR:PIDFILE_WRITE_FAILED` | `tests/integration/daemon.test.js`（pidfile 写不进给人话、不吐栈） |
| `ERR:LOGFILE_OPEN_FAILED` | `tests/integration/daemon.test.js`（manager.log 开不出来给人话、不吐栈） |
| `ERR:INTERNAL` | `tests/cli.test.js`（`exitCodeFor` 兜底映射）、`tests/patchsync.test.js` |

### 11.4 CLI 命令（`CLI:`）

| ID | 覆盖 |
|---|---|
| `CLI:init` | `tests/setup-wizard.test.js`、`tests/integration/cli.test.js` |
| `CLI:up` | `tests/integration/daemon.test.js`、`tests/cli.test.js` |
| `CLI:down` | `tests/integration/daemon.test.js` |
| `CLI:restart` | `tests/integration/daemon.test.js`、`tests/integration/cli.test.js` |
| `CLI:status` | `tests/integration/daemon.test.js`、`tests/integration/cli.test.js` |
| `CLI:logs` | `tests/integration/daemon.test.js` |
| `CLI:service` | `tests/integration/daemon.test.js`（launchd plist 快照） |
| `CLI:version` | `tests/updater.test.js`、`tests/integration/cli.test.js` |
| `CLI:update` | `tests/updater.test.js` |
| `CLI:ls` | `tests/integration/cli.test.js` |
| `CLI:probe` | `tests/integration/cli.test.js` |
| `CLI:start` | `tests/integration/cli.test.js`、`tests/cli.test.js` |
| `CLI:stop` | `tests/integration/cli.test.js`、`tests/cli.test.js` |
| `CLI:reconnect` | `tests/integration/cli.test.js`、`tests/cli.test.js` |
| `CLI:log` | `tests/integration/cli.test.js` |
| `CLI:open` | `tests/integration/cli.test.js`（假 `open` 记账） |
| `CLI:config` | `tests/cli.test.js`、`tests/integration/cli.test.js` |

### 11.4.1 CLI 退出码契约（`CLI_EXIT:`）

CLI 退出码与远端协议 `EXIT:` 分开登记，避免共享 `1` 造成行为碰撞。

| ID | 语义 | 覆盖 |
|---|---|---|
| `CLI_EXIT:0` | 操作成功 | `tests/integration/cli.test.js` |
| `CLI_EXIT:1` | 操作失败 | `tests/integration/cli.test.js` |
| `CLI_EXIT:2` | 超时或通信失败 | `tests/integration/cli.test.js` |
| `CLI_EXIT:3` | 用法错误 | `tests/cli.test.js`、`tests/integration/cli.test.js` |
| `CLI_EXIT:130` | 等待期间被 Ctrl-C 打断 | `tests/integration/cli.test.js` |

### 11.5 harness 体系自身

闸门自己也是代码，一样要有人盯（与 `scripts/coverage-gate.mjs` 同款待遇：判定逻辑
内嵌在架构护栏用例里）。

| 面 | 覆盖 |
|---|---|
| 行为清单提取：路由表正则转可读路径、远端/CLI 退出码静态抽取、`COMMANDS` 顶层键、`TRANSITIONS`/`SCENARIOS` 直读 | `tests/architecture.test.js`（`apiRoutesFrom` / `protoExitCodesFrom` / `cliExitCodesFrom` / `cliCommandsFrom` / `collectInventory`） |
| 三方对账判定：未登记、死行为、引用悬空、豁免没写理由各自判红；glob 形态引用只要有一个命中就算落地 | `tests/architecture.test.js`（`matrixVerdict` / `parseRegistrations` / `parseFileRefs` / `globHasMatch`） |
| 攻击语料库形状：id 唯一、surface 已知、payload 带 canary、expect 与 origin 必填 | `tests/adversarial/corpus.test.js` |
| 金丝雀 oracle：canary 只许落在单引号词内，成为独立词/命令位/选项位都判逃逸；oracle 自身有正反算例 | `tests/adversarial/oracle.test.js` |
| 注入面回放：config→LAUNCH 的 env/extraArgs/workdir/patch 名/Host 名、STOP 指纹边界、本机 HTTP 副作用面 | `tests/adversarial/launch-argv.test.js`、`tests/adversarial/fingerprint.test.js`、`tests/adversarial/http.test.js` |
| 运输账本：每次调用记 begin/end 两行、id 成对、行序即跨进程全序；`inFlightStats` 的峰值/未收尾算法 | `tests/harness/harness.test.js`（账本落账 + `inFlightStats` 正反算例） |
| 确定性性能不变量（硬闸）：30 台探测 ssh 次数 == N 且在飞峰值 ≤ 6（逐字 6，出厂表一改就红）、`mapPool` 峰值恒等于 limit、重连闸 16 挤 6 且 FIFO、退避上界 `2^n` 封顶 30s、`monitor.tick` 不叠加、单主机深核恒 1 次 VERIFY、同主机 `hostQueue` 严格串行、state.json 落盘有 debounce | `tests/perf/invariants.test.js` |
| 墙钟软基线：三路径（探测扇出 / 复核风暴 / 一拍巡检）+ 四微基准（模板构建、schema 校验、协议解析、lcov 解析），k=5 取中位数、丢弃预热样本 | `tests/perf/scenarios.js` + `scripts/perf-gate.mjs`（判定逻辑单测在 `tests/architecture.test.js`） |
| 种子化 fuzz 五目标：转义往返（`unshq` / 真 `sh` / 校验器后果）、协议构建↔派发↔解析往返、schema 变异必被拒、状态机随机游走、HTTP body | `tests/fuzz/shq.test.js`、`tests/fuzz/proto.test.js`、`tests/fuzz/validate.test.js`、`tests/fuzz/machine.test.js`、`tests/fuzz/http.test.js` |
| fuzz 骨架自身：PRNG 逐位可复现（含逐字快照）、种子分离、预算解析、触发签名去重、语料形状与 ID 号段、沉淀管道的去重与注入类转写 | `tests/fuzz/plumbing.test.js`（`prng.js` / `runner.js` / `corpus.js` / `scripts/fuzz-sink.mjs` 的纯判定） |
| 变异算子：只改代码区（`=>`/`>>>`/`0x`/浮点/BigInt/字符串里的一律不动）、单行守卫子句可删、变异体 id 与行号无关而与那一行内容有关 | `tests/architecture.test.js`（`scanJs` / `isCodeSpan` / `enumerateMutants` / `applyMutant`） |
| 变异闸门判定：新幸存者判红、已登记的放行、复活的要报、语法不合法不进分母、超时算杀死、只报告档不影响退出码、悬空豁免与 `--only`/`--op` 缩范围的交互 | `tests/architecture.test.js`（`mutationVerdict` / `parseAllowed` / `interleaveByFile` / `testSetResolver`），执行入口 `npm run mutation:gate` |
| 变异闸门自检：未变异的沙盒必须先全绿，否则整轮作废——挡的是「沙盒本来就红导致每个变异体都被判成杀死、kill 率虚假接近 100%」这种假杀 | `scripts/mutation-gate.mjs` 开跑前的自检步（日志里逐轮可见），演练记录见 §11.6 |
| 变异豁免基线：每条都写清理由（占位符判红）、都指向真实存在的变异体、设卡档每个文件都有用例能到达 | `tests/mutation/ALLOWED_SURVIVORS.json` + `tests/architecture.test.js` |
| 测试卫生：每个用例文件至少一处断言；`tests/adversarial/**`、`tests/perf/**`、`tests/fuzz/**` 只依赖 node 内置与本仓 src/tests/scripts；`scripts/lib/inventory.mjs` 不被 `src/` 引用 | `tests/architecture.test.js` |
| 真机验收地基：每轮重扫 SSH 配置并互斥；结果写脱敏 JSON/Markdown；旧 PASS→新失败自动列为回归；旅程规格与生成清单必须一致 | `scripts/lib/acceptance.mjs`、`scripts/acceptance-journeys.mjs`、`scripts/journey-gate.mjs`、`tests/lib/acceptance.test.js`、`tests/journey-gate.test.js` |
| 操作员 bootstrap 的 shell 语法、帮助和「只装 zstd/用户态 Sidecar」边界 | `scripts/bootstrap-remote.sh`、`tests/bootstrap-remote.test.js` |

### 11.6 可红性演练记录

一个从没红过的闸门等于没有闸门——它可能一直在空转，而没人看得出来。下面每条都是**真的
把缺陷注入进去跑过一遍**，记的是当时的实际输出；产品代码随后逐字复原（`git diff` 为空）。
改了任一支柱的判据，照这张表重跑一遍。

| 支柱 | 注入的缺陷 | 实际观察到的红 |
|---|---|---|
| 行为清单 | 从 §11.1 删掉 `API:GET /api/config` 一行 | `matrix-gate` 判红：「行为清单：139 项，矩阵登记 138 项」+「新增行为未登记 1 项：`API:GET /api/config`」；补回后退出码 0 |
| 攻击语料 | `shq` 放开单引号转义（`'${s}'`，不再做关引-转义引-开引） | `tests/adversarial/` 52 例中 3 红。金丝雀 oracle 指名道姓：`AV-ARGV-006 金丝雀逃逸：偏移 169 落在 bare（词：/tmp/dshc-canary-QUOTEBREAK）`，并打印出注入后的整条远端命令；STOP 指纹那组同时红 |
| 性能不变量 | `src/defaults.js` 的 `SSH_FANOUT_LIMIT` 由 6 改 7 | `tests/perf/invariants.test.js` 9 例中 3 红：「扇出上限就是 6」逐字闸报 `7 !== 6`，`probeAll` 那条报「在飞峰值 7 超过扇出闸 6」并附在飞序列 `…5,6,7,6,5…` |
| 种子化 fuzz | `shq` 的 `split/join` 换成 `s.replace("'", …)`——只转义**第一个**单引号（经典历史 bug 形态） | 固定种子 `20260825` 第 6 例即被逮住，触发词是含**两个**单引号的 `'.[')a@!&>!![…`（固定语料里原本缺这个形态）。日志给出的单例重放命令逐字可复现；`fuzz-sink.mjs --write` 去重后沉淀为 `FZ-SHQ-002`，复原实现后该语料回放转绿 |
| 变异测试 | 删掉 `tests/lib/semver.test.js` 里 `isPrerelease('1.0.0-rc')` 那条断言 | 变异闸门报出新幸存者 `src/lib/semver.js:46 [num-plus-1] parsed.prerelease.length > 0`（把 `> 0` 改成 `> 1` 没人管），并给出可直接抄的豁免骨架；补回断言后该档 kill 率回到 100% |
