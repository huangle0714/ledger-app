# 账务管家 iPhone UI 原型

这是根据 `开发系统管理.pdf` 中的桌面版业务流程制作的移动端 PWA 原型，当前用纯 HTML/CSS/JavaScript 实现，便于先确认信息架构和交互。

项目接手、数据规则、UI 要求和发布注意事项见 `CLAUDE.md`。

## 预览

在本目录运行：

```powershell
python -m http.server 4180
```

然后打开 `http://localhost:4180`。界面包含总览、卡片搜索和筛选、还款日历、卡片详情、添加/编辑/删除卡片和设置页。

卡片数据默认保存在当前浏览器的本地存储中，不会发送到服务器；刷新页面后仍会保留。设置页提供 JSON 导出和导入，可用于手动备份和恢复。第一次打开页面并完成缓存后，即使断网，也可以继续打开页面和添加、修改数据。

在 iPhone 上使用时，需要先把这些静态文件部署到一个 HTTPS 地址，然后用 Safari 打开，选择“分享”→“添加到主屏幕”。这里的托管只负责提供网页文件，不保存你的卡片数据，也不需要后端数据库。添加到主屏幕后，首次打开并缓存完成，之后可断网使用。

电脑本地试用：

```powershell
cd F:\iPhone
# 如果电脑已配置 Python：
python -m http.server 4180
```

如果没有 Python，也可以使用任意静态文件服务器；当前 Codex 预览地址是 `http://localhost:4180/`。

## 同一 Wi-Fi 在 iPhone 上试用

电脑和 iPhone 连接同一个 Wi-Fi 后，在 iPhone Safari 打开：

```text
http://192.168.2.220:4180/
```

也可以双击目录里的 `启动账务管家.cmd` 启动局域网服务。电脑窗口需要保持开启，电脑休眠或关机后 iPhone 无法访问。

局域网地址适合先试用和录入数据。由于普通 `http` 局域网地址不是 HTTPS，iPhone Safari 可能不会启用 Service Worker，因此“完全关闭页面后断网重新打开”需要改用 HTTPS 静态托管；页面已经打开时，新增和修改仍然会写入 iPhone 本地存储。

## 原生 iOS 版本

原生 SwiftUI 代码位于 `ios/LedgerApp`，使用 SwiftData 保存本地数据。`project.yml` 由 XcodeGen 生成 Xcode 工程，`.github/workflows/ios-build.yml` 会在 GitHub 的 macOS Runner 上自动生成工程并执行无签名编译检查。

## 下一步转成原生 iPhone 应用

确认 UI 后，可以将页面逐个映射到 SwiftUI：`TabView` 对应底部导航，`NavigationStack` 对应详情页，`sheet` 对应弹窗，数据模型对应卡片和账单结构。真正安装到 iPhone 仍需要在 Mac 上用 Xcode 编译和签名。
