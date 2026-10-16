# 平台薄适配与安全能力

辅助进程仅stdio逐行JSON，不开放监听端口。C#/.NET 10 Windows与Swift/macOS共用`protocolVersion:'1.0'`、requestId、eventId、targetInstanceId、generation、accountScope:'unknown'。无客户消息发送、原编辑器写入、原进程注入、CDP、剪贴板持续读取或第三方窗口重挂。

## 请求/响应

请求：`{protocolVersion:'1.0',requestId,type,payload}`，type仅`listWindows/bindWindow/unbindWindow/probeCapabilities/stop`。逐行最大16KiB、requestId最大128字符，未知命令/字段拒绝；stdout仅JSON，stderr保留诊断。`listWindows`返回type `windows`，payload `{windows:[{targetInstanceId,handle,processId,displayName}]}`。绑定必须提交当前实例id，不按同标题自动绑定。

Windows仅候选实际进程路径`Program Files\vbk-electron\旅游商家桌面版.exe`，id包含pid、进程启动UTC ticks及hwnd，不把PID当永久身份。窗口状态通过DWM extended frame bounds，失败明确回退GetWindowRect；进程采用per-monitor DPI awareness，返回物理像素。WinEvent监听前台、最小化、对象/位置事件，250ms轮询补漏；变更才发送。壳负责物理像素到Electron DIP转换、工作区边界、解锁模式和showInactive。

窗口丢失报告`windowState.payload:{bound:false,targetLost:true,reason:'target_lost'}`并失效generation，壳转独立模式，不换绑另一窗口。最小化报告`minimized:true`；窗口跟随不能推定业务会话、账号或草稿可读。

`probeCapabilities`默认只报告逐项禁用原因；显式`businessProbe:true`在当前目标统计UIA节点数量与ControlType，最多200节点/1.5秒预算、2.5秒上层超时。它不读取Name、Value、Text等业务正文；未完成的UIA调用不并发重复探测。readMessage/readOrder/readDraft/writeDraft全部false，reason `identity_and_revision_unverified`，因为树结构不证明原文/会话/revision/IME可观测。

## Windows 构建与只读探测

```powershell
& .\native\windows\build.ps1
& .\native\windows\probe.ps1
& .\native\windows\probe.ps1 -BindFirst
```

需要.NET10 SDK。build发布win-x64 self-contained单文件到`native/windows/bin/publish/TravelMerchant.WindowHelper.exe`，无需用户机器另装.NET runtime。若SDK在项目work内，`build.ps1 -Dotnet <完整dotnet.exe路径>`。probe逐条显示脱敏输入和实际输出，BindFirst只在候选唯一时绑定，最后stop与退出。

## Mac 构建与门槛

`npm run build:native:mac`（即`bash native/macos/build.sh`）需Xcode Command Line Tools：分别以`arm64-apple-macos12`与`x86_64-apple-macos12`编译，lipo合并为universal二进制，再`codesign --force -s -`做ad-hoc签名，输出`native/macos/bin/TravelMerchant.WindowHelper`（gitignore，不入库）。`npm run package:mac:app`把它放入`旅游商家助手.app/Contents/Resources/native/macos/TravelMerchant.WindowHelper`；开发模式从`native/macos/bin/`启动。

候选窗口仅限CGWindowList中owner bundle为`com.ctrip.vbooking`、layer 0、alpha>0、至少400×300 points的窗口，排除提示框与通知弹窗。顺序：激活应用的窗口优先，其次面积较大者，再按CGWindowList前后次序；壳的自动绑定按此顺序取第一个能绑定的窗口，绑定后直到丢失才换绑。

id为`<pid>:<启动时间epoch毫秒整数>:<CGWindowID>`，与Windows共用壳侧校验`/^\d+:\d+:\d+$/`。启动时间取NSRunningApplication.launchDate，未经LaunchServices启动、缺launchDate时改用内核`p_starttime`。每次状态更新都重新核对pid的bundle、启动时间及窗口归属，PID复用不会静默换绑；不一致即报告`target_lost`。

windowState的bounds为CGWindow top-left screen points（`coordinateSpace:'screen-points-top-left'`），visible取onscreen，minimized为其反值（最小化、隐藏或位于其他Space的窗口仍保持绑定，只有窗口销毁才报告`target_lost`），foreground/groupForeground取应用是否激活，dpi为窗口主要所在显示器的像素/点比×72（Retina为144）。壳不能把这些坐标当Windows物理像素转换。

未绑定时250ms轮询候选；候选由无到有时发送一次`targetAvailable`（空payload），壳据此提前触发自动绑定。它只是提示，`bindWindow`仍重新枚举并核对id。已绑定时250ms轮询窗口状态，另在已有Accessibility权限时用AXObserver监听位置/大小/窗口生命周期；不主动申请Accessibility或Screen Recording。AX探针不读正文，四项业务能力全部false。`setCompanionWindows`为Windows专属，Mac辅助进程不实现，壳只在win32调用。

Electron 壳在 Windows 保留托盘；darwin 使用后台模式，隐藏 Dock（`LSUIElement`）且不创建菜单栏托盘，不自动显示设置窗。助手启动辅助进程并自动绑定。macOS 当前优先直接注入官方 App，由启动器带起并随官方进程退出；旧独立启动诊断链路经 LaunchServices 执行`/usr/bin/open -a /Applications/旅游商家桌面版.app --args --remote-debugging-port=<端口>`，系统权限仍归属原客户端，再按参数恰好含该端口的主进程识别pid。

尚待真实Mac分别验收：窗口跟随、多显示器/DPI、隐藏/全屏、多窗口、AX拒绝/撤销、x64主机分发、厂商升级。辅助程序与`.app`仅ad-hoc签名，未公证。

## 2026-10-16 Mac 早期实测（历史状态）

以下为当天较早构建的记录；后续已增加热更新 ares 1.2.16 支持、先挂载后认证等待、Electron 自有加密登录及界面修复。Chrome/Edge 登录要求只适用于当时的旧认证入口。首次消息页白屏的后续实测仍未通过，完整现状见 [Windows 构建与优化说明](Windows注入包构建说明-2026-10-16.md)。

环境：Apple Silicon、macOS 27.0，旅游商家桌面版1.2.12（x86_64，Electron 27.3.11 / Chrome 118.0.5993.159，ares 1.2.15）。热更新目录`~/Library/Application Support/vbk-electron/dist`为ares 1.2.5，旧于安装包，页面实际从`.app`内`app.asar.unpacked`加载。

- 只读`inspectReadOnly`：指纹四项SHA256与`MACOS_RUNTIME_BUILD`一致，1个主进程、22个客户端进程、0个安装器。
- 经用户同意以⌘Q等价方式退出客户端后，`launchFromExplicitUserAction`经LaunchServices启动成功（约4.1秒），主进程参数仅`--remote-debugging-port=<端口>`，lsof确认唯一监听`127.0.0.1:<端口>`且归属该主进程；`/json/version`为`Chrome/118.0.5993.159`，imPlus与main页面URL与清单一致。
- 打包后的`旅游商家助手.app`（arm64，ad-hoc签名`codesign --verify --deep --strict`通过，LSUIElement）：`--smoke-test`输出`shell_started`→`smoke_complete`，退出码0、无残留辅助进程。`--acceptance`下辅助程序自动绑定客户端窗口，CDP附加、HTML/渲染脚本哈希核验、隔离世界与原生编辑器端口安装均通过。
- 当时消息页没有任何会话（会话列表为空、`.chat_area`不存在），面板找不到输入区锚点，挂载以`OWNED_FRAME_BOUNDARY_FAILED`→`RUNTIME_MOUNT_FAILED`失败并按既有逻辑定时重试，与Windows行为一致。客户端窗口被遮挡时Chromium报告`visibilityState=hidden`，助手进入`runtime-waiting-visible`等待，不报错。
- 静态核对：注入代码依赖的本地选择器（`.im_detail.inform-con > .chat_area`、`.chat_area-input`、`.tiptap.ProseMirror.chat-editor`、`.chat_list_content li.normal-message-item`、`.menu-item-wrapper.cur .menu-text`、`.customer_info iframe.customer_order-detail`等）在Mac 1.2.15前端资源中均存在；`.im_info_basic_list*`属于vbooking远程订单页，不在本地包内。
- 本机Chrome/Edge Default配置中没有`csagent.tsim.tech`本地存储，翻译认证为`needs_login`，属预期；需用户自行在浏览器登录。
- 助手退出后客户端页面无`data-tsim-runtime-lease`、无自有节点、无`tsimRuntimeFactory`残留。全程未发送客户消息、未改写草稿、未修改厂商文件。

未验收：打开会话后的面板显示、中文草稿译文预览、替换/撤销、订单iframe登录与查询、真实IME。需在浏览器登录TSim并有进行中的客户会话后补测。

## 2026-10-14 Windows实测

项目内.NET SDK10.0.402从官方release metadata校验SHA512后使用，digest `AE4FD528CB7E9F6AF6AAF7DE36715A69F761F183744F1BB3025D19F5A92447090EC561410E46266C1D10A63781ED6F3DE771760BC76C876D87DAABC367B898CD`。发布成功，helper exe164,815,776字节并附WPF native依赖DLL；未为减体积改变安全能力。

只读probe找到唯一既有旅游商家主窗口（PID23436、hwnd527234），绑定成功，DWM物理边界x388/y212/width2198/height1416，dpi144，visible=true/minimized=false/foreground=false。UIA结构探针在2.5秒上层限时返回`probe_timeout`，没有业务节点可用证据，四项业务能力全部false。随后stop退出辅助进程；没有发送消息、改写草稿、重启原客户端或开启CDP。完整移动/多屏/DPI/最小化/丢失联动由壳验收另记，不能用一次位置快照替代。
