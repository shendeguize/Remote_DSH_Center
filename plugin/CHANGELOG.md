# Changelog — dsh-center-hub

本文件记录 dsh-center-hub 插件包的全部外部可观察变更（独立于仓库根
CHANGELOG.md 的主体版本线，见设计 ADR-6）。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 「DSH Center」Tab（`conversation.view` 环）：探活通过后以 iframe 整页内嵌
  本机 manager 的 Hub 页，Hub 全部既有能力（主机全景、进入各主机 dsh web、
  管理台、setup 向导）原样可用，零 UI 复制。
- manager 端口发现（host 半区）：插件配置 `managerUrl` →
  `$DSHC_HOME/config.json` → 出厂候选探测 三级优先级，一律以
  `/api/manager/info` 指纹回读为判定，经同源只读路由
  `/plugins/dsh-center-hub/api/info` 下发发现结果。
- info 路由守卫：loopback-only、Host 校验、Origin 校验（含
  `sec-fetch-site: cross-site` 拒绝）、POST Content-Type 门（预留分支）；
  无任何写端点。
- browser 侧探活与降级：favicon 弱指纹 Image 探活（5s 超时）、失败后
  5s→10s→20s→40s→60s 有界退避、up 态每 30s 低频保活、页面不可见暂停且
  恢复可见立即补探；三态降级卡（未发现 / 候选探活失败 / 远端撞车明示）
  与手动「重试」。
- 侧栏 footer「DSH Center」状态徽标：绿（探活通过）/ 灰（无候选）/
  红（候选存在但探活失败）圆点，点击浮层显示发现详情（候选地址 / 来源 /
  指纹验证）与打开 Tab 的指引。
- 递归守卫：处于任何 iframe 中的 dsh web 页面静默不注册插件 UI，阻断
  「dsh web → Hub → dsh web → Hub…」嵌套环。
