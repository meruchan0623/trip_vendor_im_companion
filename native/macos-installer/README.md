# macOS 一次性注入安装器

本目录是原生 AppKit 一次性 GUI 与独立事务引擎。安装器不常驻，不结束客户端进程；客户端必须由用户手动完全退出。本版助手的目标路径固定为 `/Applications/旅游商家桌面版.app`，安装器会拒绝其它路径。

构建前先完成 `node scripts/inject-macos-official.mjs --official <官方 .app 或 .dmg>`，然后执行：

```sh
node scripts/package-macos-injector.mjs --official work/mac-arm64/official-apple.dmg
```

打包脚本只读取官方源和已构建载荷，不会启动、安装或修改 `/Applications` 中的应用。产物为 `work/mac-installer/旅游商家助手安装器.app` 与 `release/旅游商家助手-0.6.0-macOS一次性注入安装器-arm64.zip`。这是临时签名（ad hoc）产物，未公证；分发仍需配置 Developer ID 签名与 Apple 公证。

安装包固定经过完整树校验的一个官方版本和构建。官方签名必须属于 `com.ctrip.vbooking`、Team ID `RPQ7NNQCK8`；未知版本或官方更新不会被覆盖。原始应用完整备份、收据、事务日志存放在所选应用同目录的 `.tsim-injector-<路径 SHA 前 20 位>` 私有目录。更新始终保留第一份官方原件。卸载恢复原件并保留账号与客户数据。文件漂移、备份变化、权限不匹配或恢复冲突会停止，并保留待恢复事务。不要手动删除备份目录。

隔离验证（仅临时目录，不操作已安装客户端）：

```sh
mkdir -p work/mac-installer
xcrun swiftc -D INSTALLER_TESTING -swift-version 5 -framework CryptoKit native/macos-installer/Engine.swift native/macos-installer/SelfTest.swift -o work/mac-installer/self-test
work/mac-installer/self-test
```

引擎与 GUI 共用一个二进制。只检查安装包自身、完全不读取已安装客户端：

```sh
'work/mac-installer/旅游商家助手安装器.app/Contents/MacOS/TripVendorInstaller' --verify-package
```

引擎 CLI 支持 `--engine check|install|restore --target /Applications/旅游商家桌面版.app`。`install` 和 `restore` 会修改客户端；不要运行，除非用户明确选择通过本安装器执行安装或恢复。可写目录无需提权；受保护目录及管理员拥有的收据按需请求 macOS 管理员授权。CLI 不自动提权。仅隔离测试编译使用 `INSTALLER_TESTING`，分发构建不包含目标路径绕过。
