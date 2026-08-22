# 账务管家 iPhone UI 原型

这是根据 `开发系统管理.pdf` 中的桌面版业务流程制作的移动端 PWA 原型，当前用纯 HTML/CSS/JavaScript 实现，便于先确认信息架构和交互。

## 预览

在本目录运行：

```powershell
python -m http.server 4180
```

然后打开 `http://localhost:4180`。界面包含总览、卡片搜索和筛选、还款日历、卡片详情、添加卡片弹窗和设置页。首次打开后，页面资源会由 Service Worker 缓存，之后可以离线打开。

在 iPhone 上使用时，需要把页面部署到 HTTPS 地址，然后用 Safari 打开，选择“分享”→“添加到主屏幕”。

## 原生 iOS 版本

原生 SwiftUI 代码位于 `ios/LedgerApp`，使用 SwiftData 保存本地数据。`project.yml` 由 XcodeGen 生成 Xcode 工程，`.github/workflows/ios-build.yml` 会在 GitHub 的 macOS Runner 上自动生成工程并执行无签名编译检查。

## 下一步转成原生 iPhone 应用

确认 UI 后，可以将页面逐个映射到 SwiftUI：`TabView` 对应底部导航，`NavigationStack` 对应详情页，`sheet` 对应弹窗，数据模型对应卡片和账单结构。真正安装到 iPhone 仍需要在 Mac 上用 Xcode 编译和签名。
