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

真实Mac/Xcode command-line tools上运行`bash native/macos/build.sh`。CGWindow枚举仅bundle `com.ctrip.vbooking`，id包含pid、launchDate及CGWindowID，坐标是top-left screen points，壳不能当Windows物理像素转换。已具AX权限时用AXObserver监听位置/大小/窗口生命周期，另有250ms回退；不在贴边时默认申请Accessibility或Screen Recording。AX探针不读正文，权限拒绝/撤销明确禁用业务能力。

本机Windows不能编译/运行Swift/AppKit。Mac真实客户端样本、窗口/DPI/隐藏/全屏、多窗口、AX拒绝/撤销、签名、公证、arm64/x64分发和升级均待分别验收。此源码不是已验证Mac发布物。

## 2026-10-14 Windows实测

项目内.NET SDK10.0.402从官方release metadata校验SHA512后使用，digest `AE4FD528CB7E9F6AF6AAF7DE36715A69F761F183744F1BB3025D19F5A92447090EC561410E46266C1D10A63781ED6F3DE771760BC76C876D87DAABC367B898CD`。发布成功，helper exe164,815,776字节并附WPF native依赖DLL；未为减体积改变安全能力。

只读probe找到唯一既有旅游商家主窗口（PID23436、hwnd527234），绑定成功，DWM物理边界x388/y212/width2198/height1416，dpi144，visible=true/minimized=false/foreground=false。UIA结构探针在2.5秒上层限时返回`probe_timeout`，没有业务节点可用证据，四项业务能力全部false。随后stop退出辅助进程；没有发送消息、改写草稿、重启原客户端或开启CDP。完整移动/多屏/DPI/最小化/丢失联动由壳验收另记，不能用一次位置快照替代。
