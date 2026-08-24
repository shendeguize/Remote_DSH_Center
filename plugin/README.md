# dsh-center-hub

在 dsh web 里打开 DSH Center：`conversation.view` 环新增「DSH Center」Tab，
以 iframe 整页内嵌本机 manager 的 Hub 页（薄形态，设计 ADR-1）。

## 安装

```bash
dsh plugin add dsh-center-hub
```

npm 包自带预构建 `lib/`，免 `allowBuilds` 构建授权。源码路径安装
（`dsh plugin add ./plugin`）需先自行 `npm install && npm run build`
（`lib/` 不入库，ADR-8）。

## 远端安装

插件装进**远端** dsh 的 profile（在远端机器执行 `dsh plugin add
dsh-center-hub`）时，host 半区运行在远端机器上——它读到的 `config.json`、
探到的 7788 都属于**远端机器自己的 loopback**，对你本机的 manager 永远不可达
（设计 §2.1/§6.3）。因此：

- 请在该 profile 的插件配置里显式写 `managerUrl`，语义 = 「**浏览器可达**的
  manager 地址」，通常 `http://127.0.0.1:7788`（一次性配置，语义明确）。
- browser 半区**不做**出厂端口盲探（设计 §6.2）：未配 `managerUrl` 且 host
  未发现候选时，Tab 显示降级卡①「未发现 DSH Center」，并按「浏览器所在机器」
  措辞给出 `dshc up` 指引。
- **撞车场景**：远端机器自己也跑 Center 时，host 半区会「发现」远端 manager
  （`verified: true`），但 iframe 与探活的 `127.0.0.1` 解析于**浏览器所在
  机器**——探活失败时降级卡③明示「dsh 主机上发现的 Center 不是你本机的
  Center（或不可达）」（设计 §6.3）。
- 浏览器不在 manager 所在机器（从第三台设备打开 dsh web）时，一切候选探活
  失败，同样落到降级卡①/③——按文案在浏览器所在机器运行 `dshc up`。

发现状态可随时在侧栏 footer 的「DSH Center」徽标浮层查看
（candidateUrl / 来源 / 指纹验证）。

## 递归守卫副作用

处于任何 iframe 中的 dsh web 页面（`window.self !== window.top`）一律静默
不注册本插件 UI——这挡住了「dsh web → Hub → dsh web → Hub…」嵌套环
（设计 §5.3），副作用是 dsh web 被其他工具 iframe 内嵌时本插件 Tab 也不出现。
该取舍已接受。

## 实现笔记 / 偏离登记（M1）

与设计定稿或构建蓝本（dsh-web-ui `shared/tsdown.client.ts`）的全部偏离都记
在这里：

1. **蓝本裁剪（tsdown.client.ts）**：闭包工厂三件套（banner/footer/intro）、
   平台冻结表 external（7 项）、noExternal 反向内联、bundle 纯度门均逐字复刻；
   裁掉了 M1 无关的部件——CSS Modules 内联管线（本包暂无样式表）、纯度门的
   INLINE_SAFE/GENERATED_REMOTE 放行分支（本包不引 wire 层值导入）、
   `dsh-client-runtime/client` store 豁免 external（本包对它只有 type-only
   import，构建期即被擦除）、sourcemap 路径重写（lib/ 不入库，无跨机 churn
   问题）、DSH_BUILD_FACE 双阶段开关（单包单趟构建）。
2. **verify 顺序**：`typecheck → build → test → pack`，与设计 §3 示例的
   `typecheck → test → build → pack` 相比把 build 提到 test 前——使
   `tests/artifact.test.ts` 的 lazy-CJS banner 断言在 verify 中必然执行
   （否则 CI 全新 checkout 首跑会静默 skip）。四关内容不变。
3. **host 半区类型产物**：`lib/index.d.ts` 由 tsdown `dts: true` 平铺产出
   （与设计 §3 exports 示例的 `./lib/index.d.ts` 路径一致）；范例仓
   task-board/multi-chat 用独立 `tsc -b` 出 `lib/types/`，本包不需要该形态。
4. **package.json 增补**：`license: MIT`（随仓库根 LICENSE；设计 §3 示例
   未列此字段，发布免警告）。
5. **`dsh.client.inject` 语义未证**（设计风险 7）：M1 按设计示例列
   runtime + ui-slots 两包，真机 `dsh plugin add` 冒烟（M1 验收 ③，仓库级
   任务）如遇 connection 包缺失再按 task-board 先例补列。
6. **`.npmrc`（registry pin + legacy-peer-deps）**：本包锁定
   `registry.npmjs.org`（与 `publishConfig.registry` 一致，锁文件解析地址
   以官方源为准）；dsh 官方包的 rc peer 森林含互斥 pin
   （`dsh-agent → dsh-invariants ^0.1.1-rc.2` 与
   `dsh-client-runtime → dsh-invariants ^0.0.1-rc.1`），npm 10 自动 peer
   安装在 arborist 内直接崩溃（`edgesOut` null）而非报 ERESOLVE——
   `legacy-peer-deps=true` 跳过自动 peer 安装；运行时 peers 本就由 dsh
   profile 树解析，dev 环境无需装出整片森林。
7. **`@deepseek-ai/dsh-client-runtime` 不可安装 → 本地类型 shim**：
   registry 上的 0.0.1-rc.1 其 dependencies 引用了未发布的
   `@deepseek-ai/dsh-compact`（404），整包装不上。M1 只需要 `ClientContext`
   编译期类型（浏览器侧 import 是 type-only，构建即擦除）——以
   `src/client/dsh-client-runtime.d.ts` 局部 declare module 补齐，类型主体
   落在**可安装**的 `@deepseek-ai/dsh-client-ui-slots` 真实 `SlotCore` 契约
   上；`conversation.view` 的 SlotMap 声明（属未发布的 ui-conversation 包）
   也在 `src/client/index.ts` 局部 merge 重述（list kind / session scope，
   r2 §2.3 证据）。可安装的 runtime SDK 发布后应移除两处 shim。
8. **banner 排版**：tsdown 0.22 会把 banner/footer 与 chunk 一起重排版
   （多行 + tab 缩进）——与蓝本仓自己入库的 `lib/client.js` 产物逐字同款，
   语义与加载行为不变；`tests/artifact.test.ts` 按结构断言而非逐字节前缀。

## 实现笔记 / 偏离登记（M2 browser 半区）

9. **`sidebar.footer.action` 按 agent-relay 先例注册成功，未触发降级**：
   注册面与 conversation.view 同款 `slots.inject`/`register`（list kind，
   id/order/label），组件收 owner 侧 `wide` 布尔（rail/row 形态）——均取自
   dsh-agent-relay 构建产物 `lib/client-ui.js` 的实证注册代码。该 slot 的
   SlotMap 声明属未发布的宿主包，与 conversation.view 一样在
   `src/client/index.ts` 局部 merge 重述（list kind / root scope /
   owner `{ wide }`；scope 取 root 是推断——footer 在会话上下文之外）；
   真机如报 scope 或 owner 形状不符，只需改这一处声明。
10. **up 态保活——已在 round 2 解决（up 态 30s 保活）**：M2 验收②
    「manager 停掉 ≤60s 内徽标转红」与设计 §5.4「此后不再有任何插件级网络
    活动」措辞冲突，收敛轮裁决按验收标准修——进入 up 后每 30s 重跑一次
    favicon 弱指纹探活（可见性门控：不可见暂停、恢复可见立即补探一次），
    连续 1 次失败即转 down 走既有退避重探路径，恢复则重新 up（iframe 重
    渲染，manager 重启本就丢会话态）。30s 间隔 + 5s 探活超时 ≤ 60s 满足
    验收②；保活与退避共用单一定时器槽、随 stop() 清理，绝不泄漏。设计
    §5.4 已加勘误注（『无插件级网络活动』指不代理任何 manager 数据面）。
11. **手动「重试」走 store 级重跑**：降级卡与徽标共享的 retry 在重置探活
    退避（§5.2 的 probe 级 retry 语义）之外还重新 fetch 一次 info——覆盖
    「无候选 → 用户刚跑起 manager / 刚改配置」的恢复路径；比设计字面多一次
    只读请求，且仅由用户显式触发。
12. **down 态自动重探不回跳 probing**：退避重探期间 UI 保持降级卡不闪
    加载态；仅首次探测呈现「正在探测」。设计对此未置语，按防闪烁取舍。
13. **样式全内联**：取设计 §5.1「内联或极简 style 注入」的前者，未注入任何
    `<style>` 节点；徽标浮层背景用系统色 `Canvas`/`CanvasText` 自适应明暗
    主题（agent-relay 蓝本为 CSS 字符串注入，本包不需要）。
14. **classify everUp 修复（round 3 真机冒烟 finding）**：真机冒烟实证——
    manager 停掉后降级卡误显示情形③「发现的 Center 不是你本机的 Center」
    而非验收②的情形②，根因是 store 沿用停机前 info 的 `verified: true`，
    probe 失败后被 classify 判成 mismatch。修复：store 为当前 candidateUrl
    记录会话内 `everUp` 标志（该候选是否曾探活成功；候选变更即重置），
    classify 在 probe 失败时优先按 everUp 判②（曾经可达 = 本机 manager
    挂了，给 `dshc up` 启动指引），仅「从未 up 且 verified:true」才判③
    撞车文案。
