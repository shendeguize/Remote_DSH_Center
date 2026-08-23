# AGENTS.md — DSH Center

本机 manager + CLI，把散在多台远端主机上的 `dsh web` 经 `ssh -L` 隧道收进同一个页面。
背景读 [README.md](README.md)，流程规矩读 [CONTRIBUTING.md](CONTRIBUTING.md)。
本文只放**改代码前必须知道的硬约束**。

## 四条不可破的底线

1. **零 npm 依赖**——运行时与测试都只用 Node ≥ 22 内置能力。不许出现
   `dependencies` / `devDependencies`，不许 import 裸包名，不许引入构建链
   （前端是原生 ESM，浏览器直接吃）。
2. **不误杀**——关停远端进程前逐字比对 `ps -o args=` 命令行指纹，对不上就拒杀。
   动 kill 判据 = 改契约，必须先写设计文档。新增的诊断信息（如 VERIFY 回读的
   `CWD=`）只许用于展示，绝不进判据。
3. **单一配置源**——一切运行参数只认 `~/.dsh_center/config.json`；代码里只有
   `src/defaults.js` 一张出厂默认表（它自身零依赖）。前端**不许**抄第二份端口常量，
   一律读后端下发值（`tests/architecture.test.js` 会搜出硬编码）。
4. **远端零常驻、零安装**——一切经单条一次性 `ssh` 命令完成；远端落地物只许进
   `~/.dsh_center_remote/`（日志与可选 patch）。

## 分层与依赖方向

```
src/lib/**        纯内核（转义/协议模板/ssh 执行器/状态机/校验器），只许依赖 lib 与 defaults.js
src/*.js          模块层（store/ports/prober/launcher/tunnel/monitor/api/server/cli/daemon）
src/web/**        原生 ESM 前端，只许依赖 src/web/**，不许碰 node: 内置
src/defaults.js   第 0 层：零依赖出厂常量表
```

依赖图必须无环、分层不许倒挂——`tests/architecture.test.js` 是硬闸门。
`src/web/setup-schema.js` 是 CLI 与页面共用的纯模块，必须保持零 import。

## 改协议模板要当心

远端脚本模板都在 `src/lib/proto.js`：LAUNCH / POLL / VERIFY / STOP / LOG（+ patch 清理）。
改任一模板，必须核对：

- 五个模板的**兼容性全链**（落地物路径都是 `$HOME/.dsh_center_remote/...` 绝对形态，
  别引入相对路径假设）；
- **退出码占用表**：`8` = workdir 进不去，`9` = mkdir 失败。新增分支别撞号；
- 模板文本有逐字快照用例（`tests/lib/proto.test.js`），改了要同步更新并说明理由。

## 错误与退出码

- 抛错统一用 `src/lib/errors.js` 的 `DshError`（`code` + 一句话人话 message +
  可选 `detail` 放长文本）。文案面向用户，**说人话**，别把 stack 当 message。
- CLI 退出码：`0` 成功 / `1` 操作失败 / `2` 超时或通信失败 / `3` 用法错误 /
  `130` 等待被 Ctrl-C 打断（操作仍在 manager 那边继续）。

## 改完必做

```bash
npm run check          # 六关：lint → 测试/覆盖率 → 浏览器 → 站点/文档 → 打包 → CLI
```

- lint 告警必须可见且不超过当前 107 条基线；工具细则见 CONTRIBUTING。
- 新代码路径要有用例；修复类**先写红的回归用例再修**。
- 覆盖率三档门槛：`src/lib/**` ≥ 90%、`src/*.js` ≥ 75%、`src/web/`（非 components）
  ≥ 80%。碰了哪条路径，回写 `tests/COVERAGE_MATRIX.md`。
- 外部可观察的变更（config schema / 协议语义 / CLI 表面 / 退出码 / 页面行为）
  写进 `CHANGELOG.md` 的 `[Unreleased]`。
- 测试不许碰真机：`tests/harness/` 是假 ssh/scp/dsh-web 垫片 + 状态引擎 + 故障场景。

## 提交前

分支 `<type>/<slug>`、PR 标题 `<type>(<scope>): <一句话>`、squash 合入、
review 走 CONTRIBUTING 的 RV-1…9 清单。设计语料与验收记录留在本机 `.local/`，
**不入库**。细则一律以 [CONTRIBUTING.md](CONTRIBUTING.md) 为准。
