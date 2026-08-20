# 变更记录

本文件记录**用户能观察到的变化**（配置字段、远端协议语义、CLI 表面、退出码、页面行为），
不记实现细节。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本语义见 [CONTRIBUTING.md](CONTRIBUTING.md#版本语义)。

## [Unreleased]

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

### 文档

- PR 标题格式的 CI 校验（CONTRIBUTING 已定约定，尚未机制化）留作待办。
- `operation-done` 事件帧尚未携带错误码，因此经 SSE 结算的动作失败一律是退出码 1，
  即使根因是远端超时。补了 `code` 之后 CLI 才能把这类失败映射成 2。

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

[Unreleased]: https://github.com/shendeguize/Remote_DSH_Center/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shendeguize/Remote_DSH_Center/releases/tag/v0.1.0
