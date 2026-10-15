# 复用现有 TSim 浏览器登录

1. 在项目根目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File native/browser-bridge/build.ps1`，然后运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-browser-bridge.ps1`。只注册当前 Windows 用户的 Chrome / Edge 本机宿主，无需管理员权限。
2. 在已登录 TSim 的同一个 Chrome 或 Edge 浏览器配置文件里打开扩展管理页，开启开发者模式，选择“加载已解压的扩展”，选择本目录。固定扩展 ID 应为 `iiepfpjonkacmepbnhgacllpipibhphh`。manifest 中只有公钥，没有私钥。
3. 保持一个 `https://csagent.tsim.tech` 页面打开。启动旅游商家助手；约 4 秒内自动同步账号。登录按钮仅激活现有官方页面，或打开官方 `/login`。不会创建本地登录网页。
4. 仅在一个浏览器配置文件安装此桥；多个浏览器同时连接时，最后连接者生效，旧连接的预览立即失效。不要同时运行本项目的多个开发实例。

宿主发布产物位于 `native/browser-bridge/bin/publish/TravelMerchant.BrowserBridge.exe`，为独立 Windows x64 程序。安装脚本将其复制到 `%LOCALAPPDATA%/TravelMerchantCompanion/browser-bridge` 并注册 HKCU 的 Chrome / Edge NativeMessagingHosts。卸载注册运行相同脚本加 `-Uninstall`；在浏览器扩展管理页移除扩展即可。

扩展仅在精确官方页面 MAIN world 读取 `agent_token`，在页面内部调用固定 `/agent/profile` 和 `/agent/translate`。离开页面的只有令牌 SHA-256 会话指纹、身份投影和翻译结果；没有令牌、密码或完整 profile。每次翻译核对账号、权限、令牌指纹、请求 ID 与草稿版本，20 秒页面超时，30 秒伴随工具超时。退出连接仅断开助手，不注销网页。

本机宿主不开放 HTTP、调试端口或任意 URL / 脚本操作；只接受固定扩展来源、固定动作与有界 JSON 帧。Electron 每次启动生成新的命名管道和随机能力值，发现文件目录 ACL 只允许当前 Windows 用户访问。本机同用户进程仍属于同一信任边界。

订单窗口为扩展自己创建、追踪并关闭的 popup，只嵌入官方 `/embed/operator`。窗口标题含随机 UUID，供桌面层精确收养；不会关闭用户已有 TSim 标签页，也不会结束共享浏览器进程。若服务端禁止扩展 iframe（CSP / X-Frame-Options / 第三方存储策略），订单嵌入需要服务端配置许可；该限制不能由桥接绕过。
