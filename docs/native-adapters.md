# 原生窗口适配

原生助手提供窗口发现、绑定、几何事件和自有浏览器窗口租约，业务翻译与授权由宿主负责。

## Windows

`native/windows` 使用 .NET 10、WinForms、WinEvent 和有限 UI Automation。构建命令为 `npm run build:native`，产物是 `native/windows/bin/publish/TravelMerchant.WindowHelper.exe`。

窗口身份包含 PID、进程创建时间及 HWND。注入模式由 `NativeTargetBinding` 从助手所在安装目录绑定官方 EXE，核对父进程及 owner 参数，拒绝重定向路径；不假设固定安装盘符。

浏览器窗口按随机启动标识、进程与原生窗口引用认领。关闭只作用于持有租约的自有窗口；进程或窗口身份变化、关闭无法确认时反馈固定错误。

## macOS

`native/macos/WindowHelper.swift` 使用 AppKit、CoreGraphics 与 Accessibility。构建命令为 `npm run build:native:mac`，需要 macOS 的 Swift 工具链及匹配 SDK。

官方客户端通过 bundle ID、PID、启动时间和窗口号定位。浏览器配置与可执行文件须匹配当前用户的 Edge/Chrome；窗口租约绑定原始 AX 引用。用户需在系统设置中为助手或原生组件授予辅助功能权限。

## 协议与生命周期

宿主与原生组件通过私有 stdio JSONL 通信，`protocolVersion: 1.0`，请求使用唯一 `requestId` 关联。帧大小有界，能力、错误和窗口状态使用明确字段，原始异常不直接传入界面。

位置事件合并更新，目标改变、最小化、隐藏和丢失仍及时通知。宿主只关闭自己持有的组件和窗口，不对官方客户端或共享浏览器执行进程树终止。

Windows 的 PowerShell 检查会话复用系统查询类型，身份通过只读 Win32 句柄核验映像、创建时间和当前用户 SID。句柄在结束时释放；请求超时、输出协议异常或进程失败时停止该会话，下次检查重新创建。
