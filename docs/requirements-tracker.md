# 阶段与验收追踪

> 2026-10-14 后续重做：本文记录旧内嵌与注入路线。默认程序已改为窗口外挂，当前架构、验收与限制见 `standalone-rebuild.md` 和根目录 README；下表不能作为新入口的完成声明。

本文件对应原始方案 `docs/旅游商家客户端扩展开发方案.md`。实现状态、自动测试、真实客户端验收、部署是不同证据层级。2026-10-14 未部署、未上线；不发送客户消息、不重启或补丁原客户端、不开启CDP。

| 阶段 | 已实现 | 启用条件与缺失证据 | 回退 |
|---|---|---|---|
| 0 契约与样本 | 只读核对认证、同步翻译字段、iframe v2、权限、延迟spec；完整host适配源码与迁移清单；平台能力探针 | 未确认Ctrip/Trip订单映射；现有Edge登录不是独立Electron分区认证；只读账号后端拒绝写入未测；真实HTTPS宿主未部署 | 手动输入明确TSim标识；查询门槛不足禁用 |
| 1 Windows手动闭环 | Electron侧栏、手动导入/候选、原译对照、草稿预览、版本守卫、取消、暂停、复制；C# helper编译、唯一既有窗口绑定与DWM/144 DPI快照通过；生产翻译缓存因缺少可信配置revision禁用 | Windows主进程与helper完整融合、移动/最小化/多屏/DPI、不抢焦点、IME、剪贴板与账号隔离逐项验收；真实翻译需独立tsim_cs登录。UIA结构探针超时，业务自动能力全部关闭 | 窗口丢失转独立面板；人工复制粘贴发送 |
| 2 查询订单联动 | host真实iframe、source/origin/v2/requestId/generation隔离，同标识重试重建；受控认证和API client适配；最新develop隔离集成完整TSim构建、46相关自动测试、React Doctor100分通过 | HTTPS路由部署；CSP、登录过期、真实权限拒绝写入、脱敏订单识别验收；映射确认前自动联动禁用 | 复制确认的订单标识并独立查询 |
| 3 自动捕获与安全回填 | readMessage/readOrder/readDraft/writeDraft逐项能力字段、探针与禁用原因、目标实例及generation框架 | 可靠原会话/账号/messageId+revision/senderRole/sourceKind/撤回序列，原文与客户端译文区分，草稿修订与IME可观测；compare-and-set写后校验；语言检测依据；厂商入口或AX/UIA可靠业务节点。当前仅结构探针不能启用 | 立即停止自动操作，保留手动原文和草稿；不静默猜会话 |
| 4 Mac验证与发布 | Swift/AppKit/CGWindow/AXObserver薄适配源码，同stdio协议、权限不自动申请、构建说明 | 无Mac样本/构建机器，不能用Windows替代Swift编译、真实AX、签名、公证、安装及升级验收 | 独立面板与手动输入 |
| 可选模块 | 现有翻译用途严格白名单，没有back绕路 | 中文回译需正式用途/额度契约；安装卡片需授权真实数据；持久缓存需范围/容量/过期；均不得虚构能力 | 单项关闭 |

最终目标始终包含自动原文读取与翻译、订单联动、原编辑器随动预览和安全回填。当前业务节点、会话身份和IME能力不满足，自动能力关闭是阶段门槛，不把最终目标改成剪贴板工具。

## 浏览器验收阻塞

已读取 ego-browser SKILL 与安装文档；PowerShell stdin最小 `listTaskSpaces()` 调用在CLI启动前失败：`ego-browser`命令不存在，未创建task space、未访问网页。安装脚本仅支持macOS，Windows需官方安装与GUI初始化。没有换用其他浏览器工具，没有读取/复制Edge凭据。原Edge已有登录态能否被ego任务空间继承、独立Electron分区如何登录均未确认。

ego可用后验收：新宿主路由、登录返回、iframe READY→SET→BASIC/LOADED、同订单重开旧事件、跨origin/source伪造、快速切客户/账号/语种、401/403/423、取消与真实超时，以及只读账号对每个写操作的服务端拒绝。测试不发送出站消息，不执行退款/取消等生产写入。
