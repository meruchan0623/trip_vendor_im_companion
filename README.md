> 2026-10-16 Electron 桌面入口更新：首次“请求登录”后，TSim 会话使用系统安全存储加密保存，启动时自动恢复和校验，不再依赖读取 Edge/Chrome 数据目录。主动退出会清除本机登录态；服务端令牌过期且无法续期时仍需重新登录。订单 iframe 会话独立。详见 [持久登录说明](docs/host-integration.md)。下文旧轻量宿主的浏览器接入说明不适用于这一新入口。

# trip_vendor_im_companion

## macOS 直接注入官方 App

Mac 不再构建 PKG，改为从未修改的官方 DMG 或 App 构建并直接安装注入版本。助手随客户端启动，客户端退出时助手结束。

在 Apple Silicon Mac 的仓库根目录执行：

```bash
npm ci
npm run inject:mac -- --official '/path/to/official-apple.dmg'
# 完全退出客户端后，安装刚构建的版本
npm run inject:mac -- --install-built
```

不传 `--official` 时读取 `work/mac-arm64/official-apple.dmg`。也可用 `--official '/path/to/旅游商家桌面版.app'`，必须是未修改的官方原包。构建阶段核验官方签名、版本和文件指纹，输出 `work/mac-inject/旅游商家桌面版.app`；安装目标为 `/Applications/旅游商家桌面版.app`。安装会替换现有 App，请保留官方原包用于恢复；用户数据目录不在替换范围。目标属于其他用户时会要求管理员授权。

当前助手面向 macOS 13 及以上的 Apple Silicon；支持官方 1.2.12，以及内置 ares 1.2.15 或已核验的热更新 ares 1.2.16。直接注入脚本会检查本机用户目录中的热更新版本和页面文件指纹，将选定页面路径同时编译进后台助手与页面运行时；未知热更新版本或文件被修改时停止构建。官方客户端为 Intel 程序，仍需要 Rosetta；助手为 ARM64。注入后使用本机临时签名，未进行 Apple 公证。厂商更新后须重新核验兼容性并重新注入。

安装并核验后运行 `npm run clean:mac`，清除编译目录、PKG 和注入构建副本，保留已安装 App、官方原包、依赖和验收记录。清理后再次安装需重新构建。

Windows 构建与本机验收见 [Windows 注入包构建说明](docs/Windows注入包构建说明-2026-10-16.md)。Windows 产物须在 Windows 上编译。

调试连接仅监听本机。日志位于 `~/Library/Logs/trip_vendor_im_companion/`。

以下为保留的独立助手与 Windows 轻量宿主说明。

翻译预览、草稿替换和订单查询直接显示在旅游商家桌面版的客服页面中，使用原客户端 Chromium BrowserView。订单面板通过 iframe 显示 TSim_CS 的 `/embed/operator` 页面。Windows 后台助手保留托盘及按需打开的连接设置；macOS 助手隐藏 Dock 和菜单栏图标。

0.4.0 原型将后台 Electron 替换为 **Node.js 24 + C# / .NET 原生托盘宿主**，不包含 Electron 或 WebView。页面内嵌功能继续使用原客户端 Chromium。0.3.2 Electron 包保留作为回退版本；性能、真实客户端操作及未完成的验收项目以[轻量宿主真实验收](docs/轻量宿主真实验收-2026-10-15.md)为准，原型发布不代表全部验收通过。

## 使用

1. 先退出旧版助手，将 0.4.0 发布包完整解压，双击 `release/TravelMerchantCompanion-0.4.0-lightweight-win-x64/TravelMerchant.Resident.exe`。必须保留同目录的 `runtime/`、`host/` 及其他发布文件，**不能只复制一个 EXE**；发布包自带 Node 和 .NET 运行时，无需另装。在 Chrome / Edge 登录 TSim 客服系统并连接会话，用于助手翻译认证。订单 iframe 使用原客户端中的独立登录会话，首次打开可能需要登录；Chrome / Edge 的翻译认证成功不等于 iframe 已登录。
2. 客户端需要本机调试连接。已有受支持连接可直接附加；没有连接时，可自行退出原客户端，再在助手连接设置中启动。助手不会修改厂商安装文件。
3. 打开消息页，默认「自动跟随客户语言」：只根据当前聊天中标记为客人的最近五条原文识别，排除商家同事和平台译文。没有可靠样本时显示待识别并暂停自动翻译；中文客户无需出站翻译。也可在工具条手动选择语言，或切回自动。切换会话会重新识别，不沿用上一位客户的选择。
   在原回复框输入中文草稿，停止输入后生成译文预览。语言识别采用本地保守规则，不将聊天原文发送到识别服务；短句、混合语言或不支持的语言可能需要手动选择。
4. 核对译文后点击「替换原文」。替换只修改草稿；最终发送由用户在原客户端完成。助手没有发送客户消息的功能。
5. 订单快捷按钮优先读取右侧「用户信息」中的「订单ID」，不会拆分或截取聊天标题里拼接的长数字。详情加载、不可读或存在多个不同订单时隐藏快捷按钮；仍可手动输入明确标识后点击「查询标识」。点击明确订单或手动提交标识后，才打开 TSim_CS iframe 并查询，识别到号码本身不会自动查询。订单窗口与普通客服系统查询窗口一致：默认居中、约占视口 90%，可在客户端页面范围内拖动标题栏、拖拽边角调整大小（尺寸由 TSim 记住），窗口外的原页面仍可正常操作；加载或登录期间顶部保留「关闭订单」。关闭订单面板、按 Esc 或切换客户会话时移除 iframe。
6. 托盘菜单可打开连接设置或退出助手；关闭设置窗口仍在后台常驻。退出会移除自有面板并释放连接，原客户端保持运行。升级前先退出旧版助手。

回退时先从托盘退出 0.4.0，再启动已保存的 `TravelMerchantCompanion-0.3.2-win-x64.exe`。两种宿主不要同时运行，避免争用同一页面的挂载租约。

## 运行与打包

0.4.0 轻量宿主需要在 Windows 上使用 Node.js 24 构建；原生宿主构建需要 .NET 10 SDK。以下命令构建无 Electron 发布目录并核验文件清单、哈希及运行时依赖：

```powershell
npm install
npm test
npm run package:lightweight
node scripts/verify-lightweight.mjs
```

默认输出目录：`release/TravelMerchantCompanion-0.4.0-lightweight-win-x64/`；入口为其中的 `TravelMerchant.Resident.exe`。单独构建可运行 `npm run build:lightweight`。校验成功只能证明包内容与构建一致，不能替代原客户端的注入、翻译、订单登录和性能验收。

以下命令仍用于保留的 0.3.2 Electron 回退入口，`npm start` 不会启动轻量宿主：

```powershell
npm install
npm run build:native
npm run build
npm start
npm test
npm run package:win
node scripts/verify-portable-content.mjs
node scripts/smoke-portable.mjs
```

Electron 回退便携包输出：`release/TravelMerchantCompanion-0.3.2-win-x64.exe`。

`npm run smoke:shell` 使用隔离配置，只检查托盘和退出清理，不读取登录凭据或访问业务服务。真实客户端验收另行记录，不能由单元测试或壳层冒烟替代。

## macOS 独立助手（保留模式）

macOS 保留 0.3.2 Electron 后台组件（Apple Silicon arm64），用于内嵌构建；当前代码隐藏 Dock 和菜单栏图标，设置窗口也不因启动、激活或重复启动而弹出。0.4.0 轻量宿主（`host-node/`、`native/resident/`）仅支持 Windows。

构建需要 Node.js 24 和 Xcode Command Line Tools（`swiftc`、`lipo`、`codesign`）：

```bash
npm ci
npm run package:mac:app
```

Electron 44 的 npm 包没有安装脚本，`npm ci` 不会下载 Electron 本体。`package:mac:app` 依次构建 macOS 窗口辅助程序（`native/macos/build.sh`）、执行类型检查和生产构建，再用 `install-electron` 按本机平台和架构把 Electron 下载到 `node_modules/electron/dist`（已有同版本同平台时直接跳过，`node_modules` 从 Windows 复制来时会重新下载），最后由 electron-builder 使用其中的 `Electron.app` 输出。首次执行 `npm start` 或 `npx electron` 同样会下载 Electron。输出：

- `release/mac-arm64/旅游商家助手.app`
- `release/TravelMerchantCompanion-0.3.2-mac-arm64.zip`

使用时优先采用上文“macOS 直接注入官方 App”，正常打开官方客户端即可启动后台助手，退出官方客户端后助手结束。不要再按旧说明寻找菜单栏托盘或从托盘启动客户端。单独构建的助手 App 用于开发与诊断，不能同时与包内助手运行。

手动诊断时，官方客户端需完全退出后，才能用 `open -a "/Applications/旅游商家桌面版.app" --args --remote-debugging-port=<端口>` 启动；端口范围为 1024–65534，仅限回环地址。已运行时 `open -a` 不会重新传入参数。翻译认证使用助手自己的登录页和加密会话，订单 iframe 仍单独登录。

已核对的 Mac 客户端指纹：旅游商家桌面版 1.2.12（CFBundleVersion 1.2.12，ares 1.2.15），页面从 `.app` 内的 `app.asar.unpacked` 加载。SHA256 见 `runtime/build-manifest.ts` 的 `MACOS_RUNTIME_BUILD`。

限制：

- 只做了 ad-hoc 签名，没有 Apple 公证。从 zip 解压的副本首次打开被拦截后，在「系统设置 → 隐私与安全性」中点「仍要打开」（macOS 15 起 Finder 右键「打开」不再绕过 Gatekeeper），或者对解压出的副本执行 `xattr -dr com.apple.quarantine "/Applications/旅游商家助手.app"`。本机构建的 `release/mac-arm64/旅游商家助手.app` 没有隔离属性，可直接打开。
- 厂商客户端更新后指纹不再匹配，助手会停止连接，需要补充新指纹后重新构建。如果厂商热更新目录 `~/Library/Application Support/vbk-electron/dist` 比安装包新，页面哈希核验同样会失败并停止。
- 轻量宿主仅支持 Windows。Mac 真实客户端验收另行记录，单元测试不能替代；首次消息页白屏的最新实测仍未通过，详见 Windows 构建说明中的已知问题。

## 实现边界

- `native/macos/`：0.3.2 macOS 版的窗口辅助程序（Swift），与 Windows 辅助程序共用 stdio JSON 协议 1.0，见[平台薄适配](docs/native-adapters.md)。
- `native/resident/`：0.4.0 原生托盘、设置、窗口监测及 Node 子进程生命周期；`host-node/`：无 Electron 的业务宿主，通过父子进程私有管道与原生宿主交换固定协议。
- `electron/main.ts`：保留的 Electron 回退入口；`electron/companion-service.ts`：两种宿主复用的翻译状态及竞态处理。业务源码位于 `electron/` 目录不代表轻量发布包依赖 Electron。
- `electron/browser-profile-session.ts`：复用本机 TSim 会话、核验翻译认证。历史订单查询 API 及内部状态暂时保留，生产页面桥不再调用该 API，也不向页面发布订单字段。
- `electron/embedded-host.ts`：固定动作及状态投影；`runtime/driver.ts`：目标身份核验、隔离世界与租约。
- `runtime/page/*`：原客服页面内的 Shadow DOM 面板；订单入口嵌入 TSim_CS `/embed/operator`，由该页面提供订单界面和登录流程，登录会话与宿主的翻译会话独立（轻量包使用 Chrome / Edge，Electron 包使用自有加密会话）。
- `runtime/native-composer.ts`：通过已核验的 Tiptap 编辑器公共接口替换，并校验会话、草稿、IME、焦点和写后状态。
- 厂商资源不匹配、目标不唯一或编辑器条件不满足时停止操作。当前支持的客户端指纹见 `runtime/build-manifest.ts`；不能假设客户端更新后仍兼容。
- 常规构建将浏览器脚本内联到生产主进程并记录 hash。运行和打包不依赖 `work/` 临时文件。
- `host/` 及旧独立浮层保留作历史参考，不属于当前生产入口。

## 文档与验收

- 0.4.0 原型的真实客户端验收、内存和 CPU 对比、独立审查及限制见[轻量宿主真实验收](docs/轻量宿主真实验收-2026-10-15.md)。以下历史记录不能替代新宿主验收。
- 当前 iframe 方案的验证范围见[订单 iframe 验收](docs/订单iframe验收-2026-10-15.md)。旧版字段查询的成功记录不能作为 0.3.2 iframe 登录或真实订单内容的验收证据。
- 以下为 0.3.1 历史记录，对应[重构计划](docs/Chromium内嵌重构计划-2026-10-15.md)和[独立对抗性审查](docs/Chromium内嵌独立审查-2026-10-15.md)，其中字段查询方案已被当前 iframe 方案替代。
- 历史 0.3.1 验证：41 个测试文件、561 项测试通过；typecheck、生产构建、便携包生成和包内容哈希核对通过。独立审查发现的订单加载时序及共享文字体系误识别已修复并复核。
- 历史 0.3.1 真实客户端已验证：无客户原文时待识别，英语客户原文自动选择英语且排除平台译文，手动选语言，跨会话清空旧语言并更新订单，正确订单真实查询返回，中文草稿自动生成英语预览，替换及撤销，测试后恢复空草稿。未发送客户消息。
- 停止测试助手后，页面自有面板及租约自动清除。核对厂商 ASAR、客服 HTML、客服主 bundle 的前后 SHA256 均未改变。
- 便携启动器冒烟退出码为 0；它没有转发应用控制台，因此另对打包应用运行壳层冒烟，得到 `smoke_complete`。多账号、全语种识别、真实 IME 与长时间性能未作完整验收。
- 本轮日志与本地只读取证位于 `work/customer-context/` 和 `work/embedded-acceptance/live-host.log`；便携包内容校验见 `work/portable-0.3.1-content-check.json`。

TSim_CS 是认证、翻译和订单查询后端；历史代码中的 PSIM 命名为兼容标识。
