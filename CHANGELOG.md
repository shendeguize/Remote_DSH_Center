# 变更记录

本文件记录**用户能观察到的变化**（配置字段、远端协议语义、CLI 表面、退出码、页面行为），
不记实现细节。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本语义见 [CONTRIBUTING.md](CONTRIBUTING.md#版本语义)。

## [Unreleased]

### 修复

- 事件面板的「按主机过滤」下拉现在也认单条到达的新主机。此前它只在整份快照时重建，
  以 `host-changed` 单帧出现的主机（ssh config 里多出一台、向导收尾解门禁都走这条）
  在下拉里缺席，事件看得见却筛不出来，要等 SSE 重连或刷新才补上。

- 主机行里的按钮与开关，用键盘按 Enter/Space 现在真按得动。行本身也接 Enter/Space
  （用来开配置抽屉），而它的 `preventDefault` 连带取消了行内控件的原生激活——键盘用户
  按「探测」「拉起」「关停」只会开抽屉，请求一个都发不出去；鼠标点却一切正常，因为那条
  路上控件各自 `stopPropagation`，压根到不了行。现在行只认落在自己身上的按键。

- 直接打开或刷新某台主机的页面，不再被踢回管理台。书签、浏览器刷新、
  `dshc open <host>` 走的都是「首屏就带主机路由」这条路；此前主机集合还没同步到，
  页面把「查不到这台」当成「标签已消失」，静默把地址改回管理台，深链因此永远落不下来。
  现在等主机集合到过一次再判；真的从配置里消失的主机，照旧回管理台。
- 安装脚本的输出接到 `head` 之类会提前关掉管道的命令时，不再刷一屏 Node 栈。
  软链本来就在报错前建好了，那屏栈只会让人误以为装坏了；现在安静收场并把活干完。
- 一键安装收尾的「下一步」不再印两遍（`install.sh` 与 `scripts/install.mjs` 各一份，
  说法还不完全一致）。直接跑 `scripts/install.mjs` 的人照旧看到它自己那份。
- manager 没起时，所有命令给同一句人话（`manager 未在 127.0.0.1:<端口> 运行。先执行 dshc up。`）
  并退 2。此前 `dshc open` 与 `dshc config set` 会把 `ECONNREFUSED` 和内部错误码
  `(INTERNAL)` 原样甩出来，同一件事两套说法。
- `dshc open` 在 manager 没起时不再打开浏览器：以前它退 0 还真拉起一个必定打不开的
  页面，让人去怀疑浏览器和端口。首启引导模式下照旧放行——那个页面就是向导本身。
- 主机多、名字长把标签栏撑过一屏时，切到靠后的那台会自动把激活标签滚进可视区。
  此前标签栏从不跟着走，切过去只看到一排没有高亮的标签，得自己横向拖回来
  （macOS 上滚动条是隐形的，不一定看得出能拖）。
- `dshc up --port` 越界（不在 1024–65535）当场报用法错误并退 3。此前会真去拉起一个
  必然绑不上端口的 manager，等满 10 秒健康检查，最后报「未确认健康」，
  把人往权限和 launchd 的方向带。
- 主机抽屉开着时，Esc 在任何焦点位置都能关掉它。此前 Esc 只在焦点还在抽屉里时管用，
  而抽屉是可以被 Tab 出去的——纯键盘用户一旦 Tab 到外面，就只能一路 Shift+Tab 摸回去
  或找那个 `×`。
- 抽屉开着时后面的页面不再吃键盘焦点。遮罩本来就挡住了鼠标，键盘却能一路 Tab 到被它
  压住的按钮上，焦点环画在灰蒙蒙的遮罩底下（`aria-modal` 还声称自己非模态，
  读屏用户拿到的是相反的信息）。现在按「有遮罩即模态」统一：后景 inert，
  `aria-modal="true"`。
- 主机表的状态更新不再把键盘焦点扔回文档顶端。这张表在任何写操作与任何主机变更时都会
  整片/整行重建，旧节点带着焦点被移除，浏览器只好把焦点交回 `body`——按下「拉起」的
  那一刻就失去位置，启动要走 5 拍每拍都重建，既跟不到变化也回不去；连「更新的是另一台」
  都会把当前这台的焦点掀掉。现在同一控件还在就留在它上面，控件因状态变化消失或在忙碌态
  被禁用，就退到它所在的那一行。
- 抽屉表单的错误提示现在跟着输入走：离开某个字段就报它自己的校验结果，改对了红字
  立刻灭。此前提示只在点保存时算一次、之后再没人碰——把端口改回合法值，红字和
  `aria-invalid` 还挂在那儿（读屏用户听到的仍是「无效」）；反过来，没点过保存之前
  填 `abc`、`0`、`70000` 一律没有任何提示。打字过程中不报——刚敲下一个 `0` 就红一次
  是纯噪声。

### 文档

- PR 标题格式的 CI 校验（CONTRIBUTING 已定约定，尚未机制化）留作待办。
- `operation-done` 事件帧尚未携带错误码，因此经 SSE 结算的动作失败一律是退出码 1，
  即使根因是远端超时。补了 `code` 之后 CLI 才能把这类失败映射成 2。

## [0.2.0-rc.3] - 2026-08-21

**预发布**。内容同 `v0.2.0-rc.2`，外加一处真机验收挖出来的修复。

### 修复

- 探测远端时不再把**探测自己**记成手动实例。远端 `ps` 里执行探测脚本的那层 `sh -c`，
  命令行中同时含有 `dsh` 与 `web` 字样，会被脚本自己的 `grep` 命中，于是每探一次就凭空
  多出一条「手动实例」（页面主机表恒显「另有 1 个手动实例」，连没装 dsh 的主机也显示）。
  真实的手动实例检测不变，关停判据从未受影响（它只认自管 pid + 逐字指纹）。

## [0.2.0-rc.2] - 2026-08-21

**预发布**，拿给人试装的版本：把「构建产物 / 一键安装 / 更新 / tag 自动构建」四件缺失
能力补齐。稳定用户 `dshc update` 更新不到它（`--pre` 才看得见）。

内容与未能出炉的 `v0.2.0-rc.1` 相同，外加一处发版流水线自身的修复：`rc.1` 的构建与
双架构验证全绿，最后一步建 Release 时 `gh` 因所在 job 没有 `.git` 而认不出仓库，
于是那个 tag 没有对应的 Release（仓库里能看到这个空 tag，属预期）。

### 新增

- **`dshc version`**：一条命令说清「装的是哪个版本、怎么装的、用的哪个 Node」——
  软件版本、安装通道（git 提交 / bundle 版本与架构）、Node 运行时版本与路径、
  安装位置。`--json` 给脚本读。
- **`dshc update`**：按安装通道自更新。git 安装走 `origin/release` **只快进**
  （工作区脏、或目标不是当前提交的后代，都拒绝并说清原因，不用 merge 糊过去）；
  发布包安装从 GitHub Releases 取版本，**SHA256 校验通过才落盘**，换目录是
  「解包到 `.new` → 原子改名」，上一版留在 `<安装目录>.prev` 可手动换回。
  `--pre` 才看得见预发布版本，`--ref <分支|tag>` 点名目标，`--restart` 顺带重启
  manager（默认只提示——重启会瞬断所有隧道页签，时机该由人挑）。
- **双架构发布包**（`npm run build:bundle`）：mac arm64 与 x64 各一份 tar.gz，
  **自带官方 Node 运行时**（下载时逐字节核对 nodejs.org 的 SHASUMS256.txt）。
  包内是 `bin/dshc` 启动器 + `runtime/` + `app/` + `BUNDLE_INFO.json`；`app/` 的内容
  就是打包白名单（`PACK_RULES`），不另立一份。
- **`install.sh` 新增 standalone 通道**：没装 node（或版本过低）的 mac 上**自动降级**
  到发布包安装，一条 curl 即可，全程不碰本机的 node；`--standalone` / `--git` 可强制，
  `--pre` 允许预发布，`--version <tag>` 钉死某个 Release。下载物 SHA256 校验不过就拒装。
  Linux 仍要求自带 Node ≥ 22（不发 Linux 包）。

### 变更

- `scripts/install.mjs` 认得出发布包安装：软链指向包内 `bin/dshc` 启动器而非
  `app/src/cli.js`（装的人可能压根没装 node，直接跑 cli.js 会找不到解释器），
  `--service` 也经启动器执行，好让 launchd plist 写上**自带**运行时的路径。
  通道判据与 `dshc update` 共用一份实现，不各写一遍。
- 打包白名单新增 `scripts/install.mjs`（发布包里要靠它摘链与装服务）。
- **打 tag 即出双架构产物**：发版流水线改成 build → verify → release 三段。产物必须先在
  Apple Silicon 与 Intel 两种真机上、用包内自带的 node 跑通 `dshc version` 才配挂到
  Release 上；verify 不过就不建 Release，不留半个发版。Release 附件是 2 个 tar.gz +
  `SHA256SUMS`。
- **发版 tag 支持预发布形态**（`v0.2.0-rc.1`）：守卫对 rc 只要求「出自 main」，不要求
  打在 `release` HEAD 上——rc 不动稳定指针；Release 自动标 Pre-release，因此
  `dshc update` 默认更新不到它，`--pre` 才看得见。正式版口径一字未改。

## [0.1.0] - 2026-08-21

首个版本。本机 manager + `dshc` CLI，把散在多台远端主机上的 `dsh web`
经 `ssh -L` 隧道收进同一个管理台页面。

### 新增

- **主机纳管**：主机清单来自 `~/.ssh/config`（`DSHC_SSH_CONFIG` 可换文件）；
  逐台探测分三类（可拉起 / 未装 dsh 或缺 web profile / 连不上），不装的主机
  明确标注原因而不是假装能用。
- **生命周期命令**：`dshc init / up / down / restart / status / logs /
  service install|uninstall|status`；主机操作 `dshc ls / probe / start / stop /
  reconnect / log / open / config`。退出码 `0` 成功、`1` 操作失败、
  `2` 超时或通信失败、`3` 用法错误。
- **单入口管理台**：每台在跑的主机占一个标签页，内容是真实的远端 dsh web；
  切标签只改显隐、不重载 iframe，页面内会话状态不丢。首启四步引导。
- **断联自愈**：隧道断开按 1/2/4/8/16/30s 退避重连；30s 一轮巡检先在本机对转发
  通道探活（要求真收到字节），不通才经 ssh 深复核远端，真死了才标 `crashed`。
  远端明确禁止转发（`AllowTcpForwarding=no`）时挂起，不进无意义的退避环。
- **manager 重启不重拉远端**：复核指纹接管原进程，只重建隧道。
- **每主机启动目录**：`hosts.<主机>.workdir` 指定远端 `dsh web` 的进程工作目录
  （即 dsh 的默认 workspace 根与 `AGENTS.md` 加载位置）。只收绝对路径或 `~`、
  `~/…`；留空即远端家目录；目录进不去时拉起明确失败，不悄悄退回家目录。
- **每主机注入项**：环境变量、追加参数、patch 文件同步。改动一律**下次拉起生效**，
  不动正在跑的实例。
- **一键安装**：`curl … | bash` 引导脚本（检查 git 与 node ≥ 22 → clone 到
  `~/.dsh_center/app` → 软链 `dshc` 进 `~/.local/bin`），重跑即升级；
  `--service` 顺带装 launchd 自启，`--prefix` 换软链落点。
- **项目主页与在线 demo**：GitHub Pages 站点，demo 跑的是产品前端本体，
  后端换成浏览器内的假 manager（状态迁移复用 `src/lib/machine.js`）。

### 变更

- 退出码 `2` 现在名副实：除了「连不上 manager」，远端 ssh 超时与不可达
  （`SSH_TIMEOUT` / `SSH_UNREACHABLE`）也归 `2`（此前落到 `1`）。动作被受理后
  失败（校验不过、相位冲突、拒杀、端口用尽、拉起失败）仍是 `1`。
- 一键安装默认装 `release` 分支（只有发过版的提交）。跟主干用 `DSHC_REF=main`，
  钉死版本用 `DSHC_REF=v0.1.0`。

### 安全

- **不误杀**：关停远端进程前逐字比对 `ps` 命令行指纹，对不上一律拒杀——
  别人手动起的实例只读不写，最坏情况是「该关的没关掉」而非「关错了别人的」。
- manager 只绑 `127.0.0.1` 且**无鉴权**，按内网单人桌面工具使用；注入的环境变量
  与追加参数在远端 `ps` 里可见，别往里放密钥。安全边界详见 README。
- **远端零常驻、零安装**：探测、拉起、关停全靠单条一次性 `ssh` 命令，远端只留
  `~/.dsh_center_remote/` 下的日志与可选 patch 文件。

### 文档

- 中英双语 README，界面截图由 `npm run site:shots` 自动生成，跟着代码走。
- `CONTRIBUTING.md`（分支 / PR / CI / 发版 / 修复 / review 全流程规矩）、
  `AGENTS.md`（改代码前的硬约束速查）、本变更记录。

[Unreleased]: https://github.com/shendeguize/Remote_DSH_Center/compare/v0.2.0-rc.3...HEAD
[0.2.0-rc.3]: https://github.com/shendeguize/Remote_DSH_Center/releases/tag/v0.2.0-rc.3
[0.2.0-rc.2]: https://github.com/shendeguize/Remote_DSH_Center/releases/tag/v0.2.0-rc.2
[0.1.0]: https://github.com/shendeguize/Remote_DSH_Center/releases/tag/v0.1.0
