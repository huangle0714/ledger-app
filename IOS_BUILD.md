# SwiftUI 与 GitHub Actions

`ios/LedgerApp` 是原生 SwiftUI 版本，数据通过 SwiftData 保存在 iPhone 本地，不联网。

GitHub Actions 使用 macOS Runner：

1. 安装 XcodeGen。
2. 根据 `project.yml` 生成 `LedgerApp.xcodeproj`。
3. 使用 Xcode 编译 iOS Simulator 版本。

这个工作流只做无签名编译检查，不会生成可安装到真实 iPhone 的 IPA。真实设备安装还需要 Apple Developer 账号、签名证书和后续的 TestFlight 配置。
