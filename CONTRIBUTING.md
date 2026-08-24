# 参与开发

本文是流程规矩的**唯一正文**：分支、提交、PR、CI、发版、修复、review 都在这里定死。
agent 的一屏速查见 [AGENTS.md](AGENTS.md)（那边只放指针，不复制规则——两处写同一件事
迟早对不上）。

## 分支模型

两条长期分支，各司其职，都受保护（[§GitHub 侧配置](#github-侧配置settings-as-code)）：

| 分支 | 角色 | 怎么变 |
|---|---|---|
| `main` | 开发主干，恒绿、恒可发布 | 只经 PR squash 合入 |
| `release` | 稳定发布指针 | 只在发版时从 main **快进**（`--ff-only`），永不产生独有提交 |

`release` 上每个提交都同时在 `main` 上——tag 与 GitHub Release 锚在 `release` HEAD，
回滚（`git checkout v0.1.0`）与追溯都不用绕。

工作分支短命，合入即删：`feat/` `fix/` `docs/` `test/` `chore/` `refactor/` `ci/` +
`<slug>`。不设 develop（main 已承担集成职责），不设 hotfix 通道（修复走同一模型）。

**合入权限仅 owner**：不添加任何 write collaborator——「谁能推」由权限面管；
「怎么推才合法」由 rulesets 管。两面都齐，规矩才不是自觉。

## 提交与 PR

- **合入策略 = squash only**（仓库设置已禁掉 merge commit 与 rebase merge）。
  PR 标题即最终提交信息，历史线性、一 PR 一提交；分支内过程提交不受格式约束。
- PR 标题格式 `<type>(<scope>): <一句话>`，type ∈ `feat` `fix` `docs` `test`
  `chore` `refactor` `ci`，scope 可省。例：`feat(launcher): 支持远端 workdir`。
- PR 正文按 [模板](.github/pull_request_template.md) 四段填全：变更摘要 /
  动机与影响面 / 测试证据 / 文档回写。
- 尺寸纪律：一 PR 一意图。「功能 + 顺手重构」拆开提。

开 PR 前本地先过闸门：

```bash
npm run check          # 六关：lint → 测试/覆盖率 → 真浏览器 → 站点/文档 → 打包 → CLI
```

第一关由 `scripts/lint.mjs` 下载脚本内固定版本的 oxlint 单文件二进制；下载物与
`.local/tools/` 中的缓存均核对固定 SHA-256 后才使用。告警完整显示，当前 107 条基线
就是上限，新增一条即红。oxlint 不进入 `package.json` 依赖，开发与 CI 都不用
`npm install`。

CI 跑的是同一条命令，但按事件分平台（成本管控——同一套闸门 × 两平台 × 「PR 一次 +
合入 main 又一次」= 每个 PR 四遍，其中最贵的 macOS 两遍）：

| 触发 | 平台 | 理由 |
|---|---|---|
| `pull_request` | ubuntu | 镜像自带 Chrome，真浏览器关只有这儿能真跑，也最便宜 |
| `push`（合入 main） | macOS | launchd / `dshc service` 是 mac 语义，产品也只发 mac |
| 手动 `workflow_dispatch` | 两个都跑 | 合入前想自己确认双平台时用 |

**required check 只有 `check (ubuntu-latest)`**，红了合不进去。mac 侧的最终兜底在
tag 上：`release.yml` 的 verify 段会在 arm64 与 intel 两台真 mac 上解包实跑，
mac 问题出不了 Release。

改 `ci.yml` 的 os 矩阵，就必须同步改 `.github/rulesets/main.json` 的
`required_status_checks`——只改一边的后果不是 CI 变红，而是 PR 永久卡在等一个
永不到来的检查。`tests/tooling.test.js` 有一条用例把这对耦合钉死。

插件另有独立 lane：`ci.yml` 的 `plugin` job（ubuntu，PR 与合入 main 都跑）在
plugin/ 内跑 `npm ci && npm run verify`。它**不进 required checks**——required
名单与 ruleset 强耦合有用例钉死，plugin lane 稳定一个里程碑后再议是否升 required。

## CHANGELOG 纪律

外部可观察的变更（config schema、远端协议语义、CLI 表面、退出码、页面行为）
在 PR 内同步写进 [CHANGELOG.md](CHANGELOG.md) 的 `## [Unreleased]`；纯内部重构
与测试可免。条目写**用户能观察到的行为**，不写实现细节。

`package.json` 的版本号必须在 CHANGELOG 里有对应 `## [x.y.z]` 小节——
`tests/tooling.test.js` 有用例盯着，每次 `npm run check` 都核，想脱节都难。

## 版本语义

- **版本唯一源 = `package.json` 的 `version`**；tag 形态 `v<version>`。
- 0.y.z 期间：**MINOR** = 新功能，或任何外部可观察契约变化；**PATCH** = 纯修复 /
  文档 / 内部重构（外部行为不变）。1.0.0 后转标准 SemVer（破坏性 → MAJOR）。
- **预发布**：`X.Y.Z-rc.N`（如 `0.2.0-rc.1`），拿给人试的版本。语义由
  `src/lib/semver.js` 定死，构建、更新、守卫共用这一份，不许各写一条正则：
  预发布**小于**同核心号的正式版（`0.2.0-rc.1 < 0.2.0`），所以 `dshc update`
  默认看不见它，`--pre` 才看得见。
- `configVersion`（config.json 迁移用）与软件版本**独立演进**：schema 变了才升，
  升了必须带迁移路径，并在 CHANGELOG 该版本条目里显式标注。

## 发版四步

```bash
# 1. 发版 PR：bump 版本号 + CHANGELOG 搬运（Unreleased → 版本号 + 日期），
#    标题 chore(release): vX.Y.Z，走正常 PR 流程合入 main。不夹带功能。

# 2. release 快进到该合入提交
git fetch --all
git checkout release && git merge --ff-only origin/main && git push

# 3. 在 release HEAD 打 tag
git tag vX.Y.Z && git push origin vX.Y.Z

# 4. 等 .github/workflows/release.yml：
#    build（三守卫 → 复跑闸门 → 组装双架构发布包）
#    → verify（macos-latest / macos-15-intel 各自解包，用包内自带 node 真跑一遍）
#    → 之后两条车道并行：release（挂 3 个附件建 GitHub Release）与
#      publish → npm-smoke（发 npm 包：正式版发 latest、rc 发 next dist-tag，
#      再真从 registry 装回来冒烟）。GitHub Release 不依赖 npm 车道成败。
```

第 2 步 `--ff-only` 失败 = `release` 出现过独有提交（不该发生），先查清再动，别用
merge 糊过去。

**发预发布（rc）时只有一处不同：跳过第 2 步**——`release` 分支不动，稳定指针继续
指着上一个正式版，tag 直接打在 main 的合入提交上。理由是 rc 不该改变「稳定用户
装到什么」；守卫据此对 rc 豁免「必须在 release HEAD」那一条（其余照旧）。
Release 会自动标成 Pre-release（判定同样出自 semver，不在 shell 里另猜一次）。

**守卫**（release.yml 的 build 段，任一红则不出 Release）：tag 名必须等于
`v${package.json version}`；CHANGELOG 有对应小节且正文非空；tag 提交必须包含于
`main`，**正式版**还必须正是 `release` HEAD。

**verify 段**（不过就不建 Release，不留半个发版）：核对 `SHA256SUMS`、断言 runner
架构与被验产物一致（镜像哪天悄悄换架构，会变成「同一个包验两遍」看着全绿），
再用 `env -i` 清空环境、PATH 只留 `/usr/bin:/bin` 跑 `dshc version --json`——
系统 node 就此不可见，跑通即证明「没装 node 的机器上也能用」。

## 插件发版（plugin/ 子包）

`plugin/` 子包（dsh 插件 `dsh-center-hub`）独立发版：**版本唯一源 =
`plugin/package.json` 的 `version`**，tag 形态 `plugin-v<version>`——与主体的 `v*`
触发器互不匹配，release.yml 零改动。变更记录在 `plugin/CHANGELOG.md`
（根 CHANGELOG 只在插件首发时记一条，此后的插件版本演进不回写）。

```bash
# 1. 发版 PR：bump plugin/package.json 版本号 + plugin/CHANGELOG.md 搬运
#    （Unreleased → 版本号 + 日期），标题 chore(release): plugin-vX.Y.Z，
#    走正常 PR 流程合入 main。不夹带功能。

# 2. 直接在 main 的合入提交上打 tag（没有 release 快进步，见下）
git tag plugin-vX.Y.Z && git push origin plugin-vX.Y.Z

# 3. 等 .github/workflows/plugin-publish.yml：
#    publish（三守卫 → 插件自测 → npm publish --provenance）
#    → smoke（发后安装冒烟）→ release（GitHub Release，rc 自动标 Pre-release）
```

**守卫**（plugin-publish.yml 的 publish 段，任一红则不发布）：tag 名必须等于
`plugin-v${plugin/package.json version}`；`plugin/CHANGELOG.md` 有对应小节且正文非空；
tag 提交必须包含于 `main`。**与主体守卫的偏离**：不要求「正式版必须是 `release`
HEAD」——`release` 分支的语义是主体 standalone 发布的稳定指针，插件版本独立演进且
不产出 standalone 包，绑定 release HEAD 会把两套发版节奏强耦合。主体四步在这里
因此收成三步：没有 release 快进步。

## 修复

- main 上的缺陷：`fix/<slug>` → PR（**附回归用例，先红后绿**）→ 合入。
  影响使用的缺陷合入后**立即**发 PATCH 版；纯内部问题可攒到下个版本。
- 发版守卫红了（tag 推了但 workflow 拒绝）：删远端 tag → 修复 → 重打。
  tag 未成 Release 前可安全重来。tag ruleset 已禁删改，这条需走紧急通道。

## Review

每个 PR 合入前过一遍下表，**在 PR 评论里逐条留痕**——「看过了」不算证据，
逐条勾选算。docs-only PR 只需 RV-7 / RV-8。

| # | 检查项 |
|---|---|
| RV-1 | 不误杀契约未被削弱：kill 判据仍是 `ps` 命令行指纹逐字全等；新增信息（如 CWD 回读）只展示、不判杀 |
| RV-2 | 零依赖未破（plugin/ 除外）：主体无裸包名 import、根 package.json 无 dependencies/devDependencies 且无 workspaces、无构建链混入主体；plugin/ 依赖不外溢（主体无一处 import plugin/） |
| RV-3 | 分层未倒挂：lib 纯内核、web 不碰 `node:`、`defaults.js` 是唯一出厂表、config.json 是唯一配置源 |
| RV-4 | 远端零常驻未破：新远端行为仍是一次性 ssh，落地物只进 `~/.dsh_center_remote/` |
| RV-5 | 协议模板变更核对过 LAUNCH/POLL/VERIFY/STOP/LOG 全链兼容性与退出码占用表 |
| RV-6 | 新代码路径有用例、修复类先红后绿、`tests/COVERAGE_MATRIX.md` 已回写；`src/**` 行覆盖 ≥95%，分档下限达标，且每个 `src/**/*.js` 都有 lcov 记录（branch/function 仅诊断） |
| RV-7 | 外部可观察变更进了 CHANGELOG `[Unreleased]`；README 与设计文档回写完成 |
| RV-8 | 提交卫生：一 PR 一意图、标题合约定、无 `.local` 与密钥泄漏 |
| RV-9 | 退出码语义（0 成功 / 1 操作失败 / 2 超时或通信失败 / 3 用法错误 / 130 等待被 Ctrl-C 打断）与错误文案「说人话」标准未破 |

## GitHub 侧配置（settings-as-code）

保护规则用 **Rulesets**，规则体是 JSON 且入库 [.github/rulesets/](.github/rulesets/)——
配置本身进版本管控，改保护走 PR。**只走 `gh api` 应用，不在网页 UI 手点**：
UI 改动不落 JSON，就是配置漂移的开始。

About 元数据与安全开关这类 online-only Settings 不能完整落成仓库文件，也仍按
settings-as-code 管理：本文记录逐字取值与可审计、可重放的命令，线上值另用只读命令核验。
文档中的命令是配置契约，不代表它们已自动执行。

```bash
# 首次创建（三份各跑一次）
gh api -X POST repos/:owner/:repo/rulesets --input .github/rulesets/main.json
gh api -X POST repos/:owner/:repo/rulesets --input .github/rulesets/release.json
gh api -X POST repos/:owner/:repo/rulesets --input .github/rulesets/tags.json

# 改了 JSON 之后更新（先查 id）
gh api repos/:owner/:repo/rulesets --jq '.[] | "\(.id)\t\(.name)"'
gh api -X PUT repos/:owner/:repo/rulesets/<id> --input .github/rulesets/main.json
```

> **变更记录（2026-08-24）**：`.github/rulesets/tags.json` 的 include 增列
> `refs/tags/plugin-v*`——插件发版 tag 与 `v*` 同享禁删改保护。按上面的
> `gh api -X PUT` 契约应用，并在对应 PR 留痕。

`bypass_actors` 恒空——规则对本人同样生效，防的就是自己的顺手误操作。确实需要
绕过时把该 ruleset 的 `enforcement` 临时改 `disabled`，用完立刻恢复 `active`，
并在相关 PR / issue 里留一句记录：

```bash
gh api -X PUT repos/:owner/:repo/rulesets/<id> -f enforcement=disabled
gh api -X PUT repos/:owner/:repo/rulesets/<id> -f enforcement=active
```

**两个坑**：required check 的名字（`check (ubuntu-latest)`）与 `ci.yml` 的 job 名 +
matrix 值耦合，改名必须同步 JSON（有用例钉，见上文 CI 一节）；required checks 只能
引用已有运行记录的 check，新仓库得先让 CI 跑过一次。

仓库 About 元数据使用以下逐字值；重复执行可安全收敛 description、homepage，并确保
四个约定 topic 存在（`dsh-plugin` 是 awesome 收录门槛，随 plugin/ 子包加入）：

```bash
gh repo edit shendeguize/Remote_DSH_Center \
  --description 'One-page local manager and CLI for local and remote dsh web instances, with SSH tunnels for remote hosts.' \
  --homepage 'https://shendeguize.github.io/Remote_DSH_Center/' \
  --add-topic dsh \
  --add-topic ssh-tunnel \
  --add-topic dashboard \
  --add-topic dsh-plugin

# 只读核验：不得修改线上设置
gh repo view shendeguize/Remote_DSH_Center \
  --json description,homepageUrl,repositoryTopics \
  --jq '{description, homepage: .homepageUrl, topics: ((.repositoryTopics // []) | map(.name) | sort)}'
```

安全开关使用各自受支持的 API；下面的应用命令只提交列出的字段，可重复执行，
不会顺带打开其他付费或实验功能。只读核验命令不修改线上设置：

```bash
# SEC-5：应用 secret scanning 与 push protection
gh api -X PATCH repos/:owner/:repo \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  -F 'security_and_analysis[secret_scanning][status]=enabled' \
  -F 'security_and_analysis[secret_scanning_push_protection][status]=enabled' \
  --silent

# SEC-5：只读核验
gh api repos/:owner/:repo \
  --jq '{secret_scanning: .security_and_analysis.secret_scanning.status, push_protection: .security_and_analysis.secret_scanning_push_protection.status}'

# SEC-6：应用 private vulnerability reporting
gh api -X PUT repos/:owner/:repo/private-vulnerability-reporting --silent

# SEC-6：只读核验
gh api repos/:owner/:repo/private-vulnerability-reporting --jq '{enabled}'

# SEC-4：应用 CodeQL default setup（JavaScript/TypeScript，default query suite）
gh api -X PATCH repos/:owner/:repo/code-scanning/default-setup \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  -f 'state=configured' \
  -f 'query_suite=default' \
  -f 'languages[]=javascript-typescript' \
  --silent

# SEC-4：只读核验
gh api repos/:owner/:repo/code-scanning/default-setup \
  --jq '{state, languages, query_suite, updated_at, schedule}'
```

> **2026-08-24 线上核验（时点记录）**：description 为
> `One-page local manager and CLI for local and remote dsh web instances, with SSH tunnels for remote hosts.`，
> homepage 为 `https://shendeguize.github.io/Remote_DSH_Center/`，topics 为
> `dashboard`、`dsh`、`ssh-tunnel`；secret scanning 与 push protection 均为
> `enabled`，private vulnerability reporting 为 `enabled`；CodeQL default setup
> 为 `configured`、`query_suite=default`、`schedule=weekly`，API 返回的 languages
> 为 `javascript`、`javascript-typescript`、`typescript`，首次 setup run 已
> `success`。这是当日只读核验结果，不会随线上设置自动更新；判断当前状态必须重跑上面的
> 只读核验命令。

其余 online-only 仓库设置的期望状态如下（应用时使用
`gh api -X PATCH repos/:owner/:repo` 或对应端点）：

| 项 | 取值 | 为什么 |
|---|---|---|
| 合并方式 | 仅 squash（关 merge commit / rebase） | 把 squash-only 从约定变成机制 |
| squash 提交信息 | PR 标题 + 正文 | 标题即提交信息的约定落到机制 |
| 合入后删 head 分支 | 开 | 「合入即删」机制化 |
| auto-merge | 开 | checks 全绿自动合入，省一次回访 |
| wiki / projects | 关 | 文档单一来源是仓库内 markdown 与 `.local/tasks` |
| Actions 允许范围 | 仅 GitHub 官方（`actions/*`） | 零依赖哲学在 CI 侧的延伸 |
| GITHUB_TOKEN 默认权限 | 只读 | release.yml 在 workflow 级显式声明 `contents: write` |
| fork PR 跑 workflow | 需批准 | public 仓库防算力白嫖与 secrets 探测 |
| secret scanning + push protection | 开 | [SECURITY.md](SECURITY.md) 要求保护并脱敏本机配置、日志与 SSH 数据 |
| private vulnerability reporting | 开 | 提供 [SECURITY.md](SECURITY.md) 指定的私密漏洞报告通道 |
| CodeQL default setup | JavaScript/TypeScript，default query suite | 不另加 workflow，以 GitHub 托管的默认配置持续扫描入库代码，补足 [SECURITY.md](SECURITY.md) 的报告与处置通道 |

**npm Trusted Publishing（一次性配置，待用户）**：插件包 `dsh-center-hub` 经
plugin-publish.yml 以 OIDC 发布（`npm publish --provenance`，免长期 token）。需要
npm 账号所有者在 npmjs.com 的包设置里一次性登记本仓库与 workflow 文件名
（Trusted Publishing）——该操作只能在 npm 网页端完成，无法落成仓库文件；完成前
publish 步骤会因鉴权失败而红。配置受阻时降级 `NPM_TOKEN` secret，并回来在此留痕。
主体包 `dsh-center` 经 release.yml 的 publish job 走同一套双路径认证，与插件
共用同一 `NPM_TOKEN` secret。

## 本地环境

Node ≥ 22，**零 npm 依赖**（`npm install` 都不用跑）。常用命令见
[README 的开发节](README.md#开发)。真机验收（`npm run acceptance:real`）要连真远端，
不进 CI，由人挑时机跑。
