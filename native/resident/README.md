# 轻量原生常驻宿主

保留的 Windows x64 / .NET 10 WinForms 宿主，用 Node 运行共享业务服务。资源注入版日常使用原客户端入口；本目录用于独立轻量宿主构建。

```powershell
npm run package:lightweight
```

发布目录包含根 EXE、`runtime/node.exe` 与 `host/main.cjs`，应整体分发。原生组件单独构建命令为 `powershell -File native/resident/build.ps1`。

托盘提供设置、登录、连接客户端及退出。设置窗口按需创建，关闭即销毁。Node 服务复用浏览器已有 TSim_CS 登录，共享翻译、语言兜底与订单窗口逻辑。

## 协议与生命周期

私有 stdio JSONL 使用 `protocolVersion: 1.0`，请求通过 `requestId` 关联。原生层只接收状态投影和设置指令，不接收草稿、译文、账号或凭据；没有对外 localhost HTTP 服务。

当前用户 SID mutex 和 CurrentUserOnly 命名管道维持单实例。第二次启动只打开设置，不抢占已有连接。

写端使用容量 64 的异步队列，每条写入超时 3 秒；读端最多排队 128 条 UI 消息。退出先停止写入，最多等待 writer 1 秒和 Node 10 秒；必要时仅结束自有 Node，不结束其官方客户端或浏览器后代。

Node 异常退出最多重试三次，延迟为 1、4、9 秒。EOF 和父 PID watchdog 处理异常死亡。正常退出应通过托盘或设置页的退出助手操作。

默认 Node 新生代参数为 `--max-semi-space-size=4`，仅影响部分 V8 堆容量，不是进程总内存限制。`--default-heap` 用于诊断回退，与 `--compact-heap` 不能同时使用。
