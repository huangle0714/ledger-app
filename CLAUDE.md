# 账务管家项目移交说明

## 项目目标

这是一个面向 iPhone 的本地账务管理 PWA。用户希望长期通过 GitHub Pages 使用，数据不上传服务器，断网时仍能查看、添加和修改记录。下一阶段主要工作是继续调整移动端 UI，并发布到 GitHub Pages。

## 当前地址

- GitHub 仓库：`https://github.com/huangle0714/ledger-app`
- 正式页面：`https://huangle0714.github.io/ledger-app/`
- 发布分支：`main`
- Pages 目录：仓库根目录 `/`
- GitHub Actions：`.github/workflows/ios-build.yml`

## 技术结构

- `index.html`：PWA 页面结构和 Service Worker 注册。
- `styles.css`：主要移动端样式。
- `pwa-overrides.css`：新增、编辑和删除卡片控件的补充样式。
- `app.js`：卡片列表、统计、筛选、弹窗、本地保存及 JSON 导入导出。
- `sw.js`：离线缓存，修改静态资源后必须递增 `CACHE_NAME`。
- `manifest.webmanifest`：PWA 名称、启动方式和图标。
- `server.js`、`启动账务管家.cmd`：Windows 局域网预览工具。
- `ios/LedgerApp`、`project.yml`：原生 SwiftUI 试验版本，不是当前主要交付物。

## 数据规则

- 卡片数据保存在浏览器 `localStorage`，同时尝试写入 `IndexedDB`。
- GitHub Pages 只托管静态文件，不保存用户账务数据。
- 不要加入远程数据库、登录、统计 SDK 或网络同步，除非用户明确要求。
- 清除 Safari 网站数据、删除 PWA 或换手机可能丢失数据，应保留 JSON 导入导出功能。
- 改数据结构时必须兼容已有本地数据，不能无提示重置。

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

## 离线与发布

- Service Worker 当前采用应用外壳预缓存和导航缓存回退。
- 每次修改 `index.html`、CSS、JavaScript 或 manifest 后，将 `sw.js` 中缓存名从例如 `ledger-pwa-v5` 升级到新版本。
- 发布后在线打开正式页面并刷新，等待 Service Worker 安装，再测试飞行模式。
- iOS 若保留旧缓存，可删除主屏幕图标及对应 Safari 网站数据后重新添加；执行前提醒用户本地数据风险。

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
