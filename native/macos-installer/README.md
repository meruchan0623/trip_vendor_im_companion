# macOS 一次性注入安装器

本目录是原生 AppKit 一次性 GUI 与独立事务引擎。安装器不常驻，不结束客户端进程；客户端必须由用户手动完全退出。本版助手的目标路径固定为 `/Applications/旅游商家桌面版.app`，安装器会拒绝其它路径。

安装包不再固定某一份官方文件树，而是携带组件（`TripVendorLauncher`、动态运行时构建的 `旅游商家助手.app`、入口 bootstrap），在用户点击安装时于本机基于检测到的官方客户端现场适配：复制到私有暂存区，修补 `app.asar` 入口并更新 `ElectronAsarIntegrity`，插入启动器与助手，写入 `Contents/Resources/companion/vendor-runtime-manifest.json`，再整体 ad-hoc 重签。支持 1.2.11 及以上；打包时用 `--official` 提供的每个官方版本都会做试注入验收，并作为“已验证版本”写入清单，其它版本按结构兼容规则（入口契约、页面结构与功能关键字）适配。助手运行时只信任安装时写入的清单，并按厂商 `isUserPath` 规则选择内置或用户目录页面。

打包（只读取官方源，不会启动、安装或修改 `/Applications` 中的应用）：

```sh
node scripts/package-macos-injector.mjs --official work/mac-arm64/official-apple.dmg [--official <其它官方 .dmg|.app>] --version 0.7.0
```

产物为 `work/mac-installer/旅游商家助手安装器.app` 与 `release/旅游商家助手-<版本>-macOS一次性注入安装器-arm64.zip`。这是临时签名（ad hoc）产物，未公证；分发仍需配置 Developer ID 签名与 Apple 公证。

状态识别：

- 官方客户端（签名通过，或签名未通过时给出提示）且版本 ≥1.2.11：可安装，官方原件完整备份到同目录 `.tsim-injector-<路径 SHA 前 20 位>` 私有目录。
- 已安装：可用新安装包基于官方原件备份重新适配，或卸载恢复。
- 官方重新安装或官方更新覆盖了注入：不再报错停止；安装会先在事务日志保护下清理旧备份，再基于当前官方客户端注入；卸载只清理旧备份。
- 注入版文件与收据不一致：可基于完整官方备份重新注入，或恢复该官方原版。
- 已注入但无备份、备份损坏且客户端非官方、Bundle ID 不符或版本过旧：给出明确指引（通常是从官方 DMG 覆盖安装后再检查）。

0.6.x 的收据与中断事务日志仍可识别和恢复。不要手动删除备份目录。

隔离验证（仅临时目录，不操作已安装客户端）：

```sh
mkdir -p work/mac-installer
xcrun swiftc -D INSTALLER_TESTING -swift-version 5 -framework CryptoKit native/macos-installer/Engine.swift native/macos-installer/Injection.swift native/macos-installer/SelfTest.swift -o work/mac-installer/self-test
work/mac-installer/self-test
node tests/run-macos-dynamic-runtime.mjs
```

引擎与 GUI 共用一个二进制。只检查安装包自身、完全不读取已安装客户端：

```sh
'work/mac-installer/旅游商家助手安装器.app/Contents/MacOS/TripVendorInstaller' --verify-package
```

试注入只把适配结果写入一个新的临时目录，不修改源客户端，可用于现场诊断兼容性：

```sh
'work/mac-installer/旅游商家助手安装器.app/Contents/MacOS/TripVendorInstaller' --dry-run --source /Applications/旅游商家桌面版.app --output "$(mktemp -d)/dry-run"
```

引擎 CLI 支持 `--engine check|install|restore --target /Applications/旅游商家桌面版.app`。`install` 和 `restore` 会修改客户端；不要运行，除非用户明确选择通过本安装器执行安装或恢复。可写目录无需提权；受保护目录及管理员拥有的收据按需请求 macOS 管理员授权。CLI 不自动提权。仅隔离测试编译使用 `INSTALLER_TESTING`，分发构建不包含目标路径绕过。
