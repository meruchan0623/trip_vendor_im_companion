# 轻量原生常驻宿主

Windows x64 / .NET 10 WinForms `WinExe`，不引用 Electron、WPF、WebView 或 UI Automation。发布命令：`powershell -File native/resident/build.ps1`。产物 `bin/publish/TravelMerchant.Resident.exe`。

生产目录固定为根目录 EXE、`runtime/node.exe`、`host/main.cjs`。不依赖当前工作目录。开发调试支持 `--development-root <目录>`；正常启动不接受任意命令或脚本参数。

托盘提供设置、登录、启动客户端及退出。设置提供连接、暂停/恢复、目标语言、恢复自动跟随客户语言、自动翻译及替换快捷键开关；设置窗口关闭即销毁。原生程序只传递设置指令，不读取聊天、翻译文本或客户身份，不写入客户编辑器。

## 协议与进程生命周期

- 私有父子 stdio JSONL，`protocolVersion: "1.0"`；原生窗口身份保留 PID、启动时间和 HWND。没有 localhost HTTP 服务。
- 原生发出的 `hostAction` 使用严格四字段帧；只有 `updateSettings` 包含 `options`。
- Node stdout 增量读取上限 65,536 个 UTF-16 字符（更严格于 262,144 字节协议上限），stderr 不显示原始内容。
- 登录仅允许固定 `https://csagent.tsim.tech/login`；没有接受任意 URL 或 shell 命令的入口。
- 当前用户 SID 命名的 mutex，命名管道 `CurrentUserOnly`；第二次启动只能发送 `OPEN_SETTINGS`。管道读取有 32 字节及 1.5 秒上限。
- 正常退出先发送 quit 并关闭 stdin，最多等待 10 秒，然后只终止持有的 Node 进程。不得使用 `Kill(true)`，因为 Node 可以按显式指令启动厂商客户端。
- 不使用包含 Node 所有后代的 kill-on-close Job，以免结束厂商或浏览器进程。Node EOF 与父 PID watchdog 处理宿主异常死亡。
- Node 异常退出最多重试三次（1、4、9 秒）；立即清除旧绑定。退出事件在启动前注册且幂等。
- 检测到旧旅游商家助手时只显示提示，不终止或抢占旧版。开发版只检查本项目 Electron 路径。

## 安全集成验证

`TravelMerchant.Resident.exe --smoke-test <包含runtime/node.exe与host/main.cjs的目录>` 向 Node 透传 smoke 开关，禁用会话读取和自动客户端连接。原生发送 status 与 updateSettings(autoTranslate=false)，核对成功响应和投影状态后写 `native-node-smoke.json`，随后正常退出。不会启动或操作客户端，不发送客户消息。

`--self-test` 只是静态契约检查，不能替代上述 C#→Node 集成测试，更不能替代真实客户端和原生设置 UI 验收。

## 背压故障验证

生产写端使用容量 64 的异步队列；UI 不执行同步管道写入，每条写入 3 秒超时。读端最多排队 128 条 UI 消息，溢出终止自有后台连接。退出先置停止标记，最多等待 writer 1 秒和 Node 10 秒，直接关闭管道基础流，不调用可能同步 flush 的 StreamWriter.Close。

`powershell -File native/resident/backpressure-test.ps1` 使用自有 fake Node：只产生 capabilities 请求且从不消费 stdin。测试不读取客服页面、不启动厂商进程。2026-10-15 实测 12.94 秒退出码 0；结果 `work/resident-backpressure-fixture/result.json`。随后真实 C#→Node smoke 再次通过，结果更新时间 19:56:17。

`--acceptance` 将白名单状态枚举和错误码写入 `%LOCALAPPDATA%/TravelMerchantResident/logs/acceptance.jsonl`，512 KiB 轮转一份；不记录草稿、译文、订单正文、账号或令牌。

## 新生代配置与诊断回退

设置顶部“退出助手”按钮直接执行与托盘相同的有界 `Shutdown`，点击后禁用，避免重复退出。它退出整个助手，不是只结束 Node 后触发监督重启。

0.4.0 原型默认在 Node 入口参数之前添加固定 `--max-semi-space-size=4`。`--compact-heap` 保留为显式兼容参数；`--default-heap` 仅用于诊断回退，省略这一 Node 参数、使用 V8 自身默认值。两个参数同时指定时拒绝启动（现有实例不受影响）。不修改全局 `NODE_OPTIONS`、old-space 上限或厂商 Chromium。

该参数只控制 V8 新生代相关容量，不是助手总内存上限，仍可能增加 GC 次数与延迟。前期现场 A/B 中，V8 默认参数的 10 分钟私有提交 p95 约 210 MiB、峰值 264 MiB；4 MiB 配置的两轮 p95 约 144 / 148.48 MiB、峰值约 152 / 151.77 MiB，第二轮有效 CPU 均值约 0.474%。最终含分块复读优化的包另做了600秒现场采样：助手私有提交p95 156.219MiB，整机CPU时间加权均值0.430296%。仍未达到120MiB及0.3%预算；单轮结果也不代表长期稳定性。详见项目 docs 中的轻量宿主真实验收与追加测试记录。
