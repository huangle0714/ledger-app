# 账务管家项目移交说明

## 项目目标

这是一个面向 iPhone 的本地账务管理网页。用户决定长期通过 GitHub Pages 使用普通联网网页，不再依赖 Service Worker 离线缓存；数据仍保存在设备本地，不上传账务内容。下一阶段主要工作是继续调整移动端 UI，并发布到 GitHub Pages。

## 当前地址

- GitHub 仓库：`https://github.com/huangle0714/ledger-app`
- 正式页面：`https://huangle0714.github.io/ledger-app/`
- 发布分支：`main`
- Pages 目录：仓库根目录 `/`
- GitHub Actions：`.github/workflows/ios-build.yml`

## 技术结构

- `index.html`：PWA 页面结构和 Service Worker 注册。
- `styles.css`：主要移动端样式。
- `pwa-overrides.css`：新增、编辑和删除卡片控件，以及分期模块的补充样式。
- `app.js`：卡片列表、统计、筛选、弹窗、分期、本地保存及 JSON 导入导出。
- `sw.js`：离线缓存，修改静态资源后必须递增 `CACHE_NAME`。
- `manifest.webmanifest`：PWA 名称、启动方式和图标。
- `server.js`、`启动账务管家.cmd`：Windows 局域网预览工具。
- `ios/LedgerApp`、`project.yml`：原生 SwiftUI 试验版本，不是当前主要交付物。

## 数据规则

- 业务数据用 sql.js（浏览器内 SQLite）保存，整个数据库二进制写入 `IndexedDB`（键名 `sqlite`）。
- `localStorage` 只存口令哈希、GitHub 备份配置和同步标记，不存账务数据。
- 表结构：`cards`、`transactions`、`annual_fees`、`installments`。
- GitHub Pages 只托管静态文件，不保存用户账务数据。
- 不要加入远程数据库、登录、统计 SDK 或网络同步，除非用户明确要求。
- 清除 Safari 网站数据、删除 PWA 或换手机可能丢失数据，应保留 JSON 导入导出功能。
- 改数据结构时必须兼容已有本地数据，不能无提示重置。

## 分期机制（2026-08-24 落地）

- 两种分期只差 `installments.occupyLimit` 一位：不占额度型每期扣「本金＋手续费」，占用额度型本金早被银行扣掉，每期只扣手续费。
- 每期入账金额记在 `transactions.amount`，真正影响可用额度的金额记在 `transactions.limitAmount`（为空表示按全额扣）。
- `available` 永远等于银行 APP 显示值，分期剩余本金不参与任何加减，只在卡片详情里做拆解展示。
- 网页没有后台进程，`catchUpInstallments()` 在打开页面时把所有已过入账日的期数一次补齐，按 `(cardId, instId, instPeriod)` 幂等，重复打开不会重复入账。
- 已入账期数是派生量 `max(postedBase, MAX(instPeriod))`，不落库；删掉最后一期会自动回退一期可重新补记。
- 年化利率用 IRR 二分法每次现算，不入库。不要手算，等本等息真实年化约为名义值的 `2n/(n+1)` 倍。
- `installments` 表和 `transactions` 的新增列由 `migrate()` 用 `PRAGMA table_info` 探测后补齐，老库和老备份都能直接升级。

## 两种计息方式（2026-08-24 追加，与 `occupyLimit` 那一位互相独立）

- `installments.feeMode` 取 `flat`（等本等息）或 `declining`（等额本金），空值一律按 `flat` 处理，老数据行为、金额、年化一个数都不变。
- 等本等息：每期手续费恒定，一直按**总本金**收，录入时填「每期手续费」。
- 等额本金：每期本金固定 `round(本金/期数,2)`、末期吞尾差，利息 = **期初剩余本金 × 固定月利率**（不按天），录入时填**年化利率**，程序 ÷1200 存进 `monthRate`（存的是月利率小数）。
- **录入必须填年化利率**，不要走「填首期利息反推」那条路：反推的月利率数学上等价，但 `money2` 之后 36 期里有 7 期各差 1 分。
- 自校验判据：等额本金的 IRR **恰好等于**名义年化；等本等息的 IRR ≈ 名义 × `2n/(n+1)`。算出来不符就是代码错了。
- 剩余利息必须**逐期求和**，不能 `perFee × 剩余期数`（那只对 flat 成立），银行自己也是逐期加的。
- `instInfo(n)` 返回 `plan[]` 逐期计划数组（`{date, p, f, pay}`），逐期计划弹层 `openInstPlan()` 和补记都吃它，保证界面与入账走同一套算法。
- 混合卡的摘要行措辞统一说「利息」，不分计息方式（用户拍板）。

## 用户确认的交互方向

- 流水页面不放全局“记一笔”按钮。
- 用户应从具体卡片内直接记录流水。
- 设置页需要提供添加卡片和删除卡片入口。
- 需要支持按指定日期查看流水。
- 需要展示年费信息。
- UI 改动前先提供设计稿，用户确认后再修改正式页面。
- 设置页不需要“帮助与反馈”和“关于账务管家”。

## UI 约束

- 优先适配 iPhone 13 和 iOS 18 Safari。
- 这是高频使用的账务工具，界面应紧凑、清楚、便于扫描，不要做营销落地页。
- 保持底部导航、卡片详情弹层和本地数据工作流。
- 修改 HTML 时保持 UTF-8，之前通过网页编辑曾发生中文乱码。
- 不要用 PowerShell `Get-Content` 的默认编码结果覆盖 UTF-8 文件；读取时显式指定 UTF-8。

## 发布与缓存

- 当前正式网页不再注册 Service Worker，也不保证断网打开。
- `index.html` 中保留了一次性清理旧 Service Worker 和 Cache Storage 的代码，发布后在线打开一次即可清理旧缓存。
- 修改页面后，手机若显示旧版本，使用带查询参数的地址强制刷新，例如 `https://huangle0714.github.io/ledger-app/?v=1adeae9`。
- 若仍显示旧内容，可清除 Safari 中该网站数据；清除前应先导出本地 JSON/DB 备份。

## 开发与验证

Windows 本地预览：

```powershell
cd F:\iPhone
node server.js
```

浏览器访问 `http://localhost:4180/`。同一 Wi-Fi 下可以使用终端显示的局域网地址，但普通 HTTP 不保证 iPhone Service Worker 生效。

提交前至少执行：

```powershell
node --check app.js
node --check sw.js
git status
```

推送到 `main` 后，GitHub Pages 会自动更新；同时检查 Actions 中 `iOS Build Check`，避免原生试验代码编译回归。

## Git 交接状态

交接提交完成后，本地 `main` 与 `origin/main` 应指向同一提交，`git status` 应为空。后续修改建议使用中文提交信息，并直接推送到 `main` 发布。
