# 登录、翻译与订单接入

## 默认会话链路

Windows Electron 与轻量宿主使用 `CompanionService → BrowserProfileSessionService → chromium-tsim-storage`，只读 Edge/Chrome 默认数据目录中精确官方 origin 的 `agent_token`，通过固定 `https://csapi.tsim.tech/agent/profile` 接口核验身份及权限。支持 `Default`、`Profile N`，拒绝隐身、自定义目录及不稳定或不支持的存储格式。

令牌只保留在宿主内存，不进入客服页面、IPC 状态、日志或新持久文件。首次扫描选中可核验的配置后保持绑定；该配置失效不会静默改用其他账号。网页撤销、令牌轮转、身份或权限变化会作废旧译文和待发送动作。网络、目录权限和格式错误单独显示，不冒充未登录。

出站翻译发出前的两处会话核验（`CompanionService` 预检与 `BrowserProfileSessionService.translate()`）复用 3 秒内开始、同一认证代次的成功核验，低于 4 秒后台轮询间隔；核验进行中则等待其完成，失败、撤销、断开或收到 401/403/422/423 后不复用。译文返回后仍复读令牌并比对认证代次，401/423 仍立即作废会话。

「登录 TSim」先恢复已有会话，确实没有登录才打开官方登录页。「打开浏览器 TSim_CS」使用已绑定配置；「断开助手会话」只停止复用，重启后仍可再次恢复浏览器登录。

macOS 默认使用独立持久会话，实现位于 `owned-session.ts`、`secure-session-store.ts` 和 `host/auth-server.ts`。登录表单在助手独立窗口内展示，使用随机能力及 CSRF 保护；凭据不进入商家页面。会话以系统加密能力持久化，退出时清除。macOS 不创建外部浏览器配置绑定，订单使用已验证的只读接口在助手面板展示。

## 翻译与草稿授权

出站请求使用固定 `/agent/translate` JSON 契约：`text`、`source_lang: zh`、`target_lang`、`purpose: outbound`、`draft_request_id`、`composer_content_version`。响应必须成功、译文非空且草稿标识精确回显。输入最多 20,000 字符，请求超时 20 秒。

停笔约 500 毫秒后自动翻译，输入法组合期间停止调度。同一草稿在请求进行中继续编辑时，已交给会话的请求不中止（尚未发出的直接丢弃），结果按版本判定丢弃；只保留最新一版待处理，等在途请求结束且最新版停笔满 500 毫秒后立即发送，不排队。切换客户或编辑器、账号变化、清空草稿、失去前台、暂停及改目标语言仍立即中止。客户语言只来自当前客户原文，本地模型结果须满足证据及多数规则。未知或不支持的语言使用已配置兜底，并明确标注不是识别结果；会话切换重新采集。

读取、替换与发送核对客户、编辑器、草稿版本、文档代次、认证代次及前台状态。网络等待不持有编辑器锁。替换后读回，草稿或授权变化废弃旧响应。默认 Enter 可预约当前草稿的译文发送；替换模式和替换快捷键只写回，发送预约通过独立代次撤销，避免迟到事件触发旧发送。

## 订单窗口

两端都在旅游商家客户端的客服页面内，以 iframe 打开 TSim_CS 官方 `/embed/operator`（`source=travel-merchant-companion&session=handoff`），不再创建外部浏览器或助手窗口。iframe 铺满页面视口，裁剪层按页面上报的卡片边界只显示查询卡片，其余区域仍可操作原页面。

查询页加载后向父页面发送 `TSIM_OPERATOR_NEEDS_SESSION`（只含订单标识和 requestId）。页面经 `operatorSession` 动作把 `OrderWindowIntent` 交给宿主；宿主核对消息页在前台、当前客户会话与账号认证代次后，返回已核验的 agent 令牌（mac 为助手自有会话，Windows 为绑定浏览器配置中的令牌）。令牌只经 CDP 送入自有隔离环境，再以固定 TSim origin 投递给本次 requestId 的 iframe，不进入面板状态和日志。拒绝时页面发送 `TSIM_OPERATOR_SESSION_UNAVAILABLE`，查询页回退到自身登录页。

TSim_CS 查询页只接受直接父页面（`file://` 不透明 origin）对同一 requestId 的令牌，经 `/agent/profile` 核验后保存为查询页登录态；同一 agent 只更新令牌，不同账号先结束旧会话。令牌以明文保存在商家客户端为该 iframe 分配的 localStorage 中。助手未登录时点击订单先打开助手登录；换客户或关闭订单时只隐藏查询页，助手账号未就绪（失效、退出、重连）时销毁查询页。mac 退出助手账号会撤销服务端会话，查询页中的副本随之失效。

查询页与客服页面共用商家客户端的渲染进程（已在 macOS 客户端核实其关闭站点隔离、HTTP/2 与 GPU），每次重新加载 TSim 页面都要数秒，因此两端都在首次查询后保留该 iframe。宿主对 `operatorSession` 的每种结果都必须应答页面（令牌或 `TSIM_OPERATOR_SESSION_UNAVAILABLE`），否则查询页会空等自身超时。之后的查询先照常经 `operatorSession` 取宿主授权：返回的令牌与该 iframe 接管的令牌相同，才向它发送 `TSIM_OPERATOR_SET_IDENTIFIER`（v2，含新 requestId）和 `TSIM_OPERATOR_REQUEST_BOUNDS` 切换订单，并在页面为新标识上报边界或结果前保持 iframe 不可见；令牌不同或被拒、页面回退登录、自行重新加载或 4 秒内未响应时，销毁并按上文流程重建。


Windows bootstrap 在原主入口前启用本机调试监听、启动自有助手，随后继续运行原入口。助手根据实际安装目录加载受保护清单，核验资源和当前用户进程，再建立唯一回环连接。

macOS 安装器仅支持固定的官方应用程序路径，且只保留启动助手所需的入口集成；不再修改消息页节流或重挂载官方 BrowserView。页面兼容性在启动时按当前用户检查，不把构建机器的用户目录写入发行包。

后台消息页等待可见后挂载；页面重建时释放旧句柄，在同一仍有效的连接上重新验证。旧客户上下文、登录动作和发送意图不能跨重连继续。

运行日志仅保留状态投影、固定错误码、阶段和耗时。完整原客户端冷启动、真实登录及业务操作结果必须独立确认，不能从文件状态或构建结果推断。
