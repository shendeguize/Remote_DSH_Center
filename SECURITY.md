# 安全政策 / Security Policy

## 支持版本 / Supported Versions

| 版本线 | 安全支持 |
|---|---|
| 最新稳定版 GitHub Release | 支持 |
| 最新预发布版 GitHub Release（如有） | 支持，供选择预发布通道的用户使用 |
| 已被更新版本取代的稳定版或预发布版 | 不支持，请先升级到对应通道的最新版 |

安全修复在 `main` 上开发和验证，但 `main` 快照不是面向用户的已发布支持通道。
最低运行时版本的变化会写入 `CHANGELOG.md` 与对应 Release notes。

## 私密报告漏洞 / Private Reporting

请使用 GitHub 的
[Private vulnerability reporting](https://github.com/shendeguize/Remote_DSH_Center/security/advisories/new)
私下报告安全问题，**不要创建公开 issue、discussion 或 PR**。

报告中请尽量包括：

- 受影响的版本或 commit、安装通道、操作系统 / 架构与 Node 版本；
- 本机或远端场景、必要配置与可重复的步骤或最小 PoC；
- 可观察影响、攻击前提，以及你判断的严重程度；
- 已脱敏的相关日志、截图或建议修复方向。

不要附上私钥、完整 SSH 配置、访问令牌、真实主机名或其他凭据。

维护者会在可行时确认、复现并沟通修复与披露安排，但不承诺固定响应或修复时限。
在补丁、GitHub Security Advisory 或双方约定的披露时间发布前，请保持细节私密；
是否署名由报告者决定。

## 本地安全边界 / Local Security Boundaries

DSH Center 按受信网络内的单用户桌面工具设计：

- 它在本机读取 `~/.ssh/config` 及受支持的 Include 引用，以发现主机并调用系统 SSH；
  项目解析器只覆盖其支持的引用形式与递归范围，不等同于完整 OpenSSH Include 语法。
  SSH 配置文件内容不会上传到远端、GitHub 或其他服务。
- manager 只监听 `127.0.0.1`，且没有用户鉴权。任何能在本机执行代码或控制该浏览器
  会话的主体都应视为能够操作 manager；不要把端口暴露或转发到公网。
- 远端探测、启动、巡检与停止均通过单条一次性 SSH 命令完成，不安装远端 agent。
  除用户显式保存 dsh settings 外，运行落地物只进入目标账户的
  `~/.dsh_center_remote/`；保存 settings 只会更新受限的 dsh 配置路径。
- 停止进程前会把 `ps -o args=` 结果与记录的命令行指纹逐字比较；不一致时拒绝发送
  kill，而不会猜测进程归属。
- `~/.dsh_center/config.json`、manager 日志以及远端日志可能包含主机名、用户名、
  路径、命令行或诊断信息。请限制文件与备份的访问权限，并在分享前脱敏。
