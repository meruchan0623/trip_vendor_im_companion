# TSim_CS 浏览器会话接入

当前默认方案（2026-10-15）不要求额外浏览器扩展，也不提供 localhost 登录页。TSim_CS 与参照插件 respondio_message_translate 源码未被修改。

## 会话与翻译

调用链为 `main.ts → companion-service.ts → browser-profile-session.ts → chromium-tsim-storage.ts`。只读系统默认 Edge/Chrome 配置目录中精确 origin `https://csagent.tsim.tech` 的 localStorage `agent_token`，不读取 Cookies、密码或复制整个 profile。解析 CURRENT/MANIFEST 活跃文件、WAL/SST 序号和 tombstone，读取不稳定或不支持的数据格式时停止复用。

令牌只保留在主进程内存，直接用于固定官方端点 `GET https://csapi.tsim.tech/agent/profile` 与 `POST https://csapi.tsim.tech/agent/translate`。主进程核验 active、账号及权限；渲染器只接收身份投影和译文。默认按 Edge、Chrome 和 Default 优先寻找可用会话；选中后失效不会自动切换其他 profile。退出连接只暂停助手，显式重新连接才解除绑定。

每 4 秒检查会话，翻译前、核验响应后及翻译返回后重新读取；替换原文本框前再次核验认证代次。磁盘读取无法观测浏览器尚未提交的内存变更，因此不声称网页退出和助手撤销瞬时同步。服务端拒绝、已落盘删除或读取错误会使会话失效。

翻译正文保持现有插件契约：`text`、`source_lang: zh`、`target_lang`、`purpose: outbound`、`draft_request_id` 和 `composer_content_version`。要求响应成功、非空译文和两个草稿字段精确回显。原文上限 20,000 字符，固定请求超时 20 秒，完整 JSON 返回；当前手动选择目标语言，无流式输出。

替换前核验客户会话、编辑器、草稿版本、中文输入状态和认证代次，写后读回。原客户端使用已验证的 Tiptap 公共接口；助手没有发送客户消息的操作。

## 查询窗口

`profile-browser.ts` 使用认证对应的现有浏览器配置打开系统 app 窗口。短暂 loopback bootstrap 仅提供随机标题用于识别本次新 HWND，不接收或提供凭据，不代理远端内容。精确认领后，同一顶层页面跳转 `https://csagent.tsim.tech/embed/operator`，浏览器自然复用该 profile 的第一方登录态。

原生层限制官方浏览器路径、Default/Profile N 及已存在配置目录；通过 HWND、进程身份和窗口属性租约定位、裁去边框和关闭。不会结束共享浏览器进程。订单参数沿用现有 identifier、identifierType、requestId、source 契约。

## 跟随与验证

几何事件与业务状态更新分离，纯拖动只更新窗口位置；原生位置事件按约 16ms 合并，减少重复 resize、show 和 repaint。测试中的连续 120 次位置变化不是实测帧率。

用户已确认主控件浮层正常；最新拖动优化尚未用户复验。2026-10-15 对真实浏览器会话执行官方 profile 核验成功，仅记录 authReady/profileSelected 布尔值，不输出凭据或账号内容。出站翻译、原框替换和新查询窗口的真实验收单独记录。

旧 browser-extension/native messaging 和 WebView/host 方案仅作历史参考，已从默认打包链移除。shell smoke 使用 enabled:false，完全隔离真实浏览器会话和账户请求。


## 独立窗口出站翻译交互

主进程 `CompanionService` 统一调度，默认 `autoTranslate: true`；原编辑器 input、Tiptap update 与输入法组合事件及时通知主进程，使旧译文失效并重新计时，同时保留 500ms 轮询作为观察后备。已核验编辑器、有效登录和窗口组前台状态全部满足时，非空草稿停止变化 1500ms 后自动翻译；输入法组合期间不调度。去重包含编辑器、会话、revision、文档/作用域/认证代次、原文及目标语言；即使文字改回原样，旧代次响应也不能恢复预览。

IPC 新增 `setTranslationOptions({language?, autoTranslate?, shortcutEnabled?})`、`cancelTranslation()`、`resumeTranslation()`；选项中的开关只接受布尔值。`shortcutEnabled` 默认开启，并通过共享状态同步设置与预览窗口。语言变更、草稿/会话变化、认证撤销会取消并作废旧请求。翻译网络等待不占用编辑器访问锁，轮询持续观察；读取与替换按独占锁串行，旧请求即使忽略 AbortSignal 也不会阻塞新语言和取消操作。失败不按轮询自动重试，同一输入可由用户手动重试。离开前台暂停调度，返回时可恢复中断请求；已就绪的预览保留，但替换仍要求前台及最终核验。

`waiting` 与 `replacing` 阶段分别用于停止输入等待和原框写入。取消只暂停当前会话，恢复按钮或真实会话切换解除暂停。替换保留原有精确编辑器/session/revision 比较、最终新鲜 `psim.sync()` 授权和文本读回校验；从不发送消息。成功插入文本记录为抑制签名，常规轮询不会把刚插入的译文再次翻译。

预览在已核验工具条空白横向范围上方向消息区展开 190 CSS px，底部原工具条位置不变；不足 120px 的上方空间时使用精简入口，`openTranslation()` 打开完整翻译面板。精简窗至少 44px，额外高度向上预留，避免 Windows 最小窗高把覆盖窗延伸进编辑区。坐标仍经 viewport/DPR 与 Win32 clientRect 校验，沿用移动、DPI 和订单测量未就绪保护。打开订单浮层时隐藏预览。

复制通过 `copyTranslation()` 的受信 IPC 执行主进程系统剪贴板写入，只接受当前已登录且 `ready` 的预览，不接受渲染器提交的任意正文；保留默认拒绝网页权限的安全策略。只读草稿也可复制，原框替换继续要求可写编辑器。

实时行为与参考插件一致：原回复编辑器输入事件及时作废旧结果，仍在停笔 1500ms 后请求完整翻译，并非逐字网络请求或 SSE 输出。Ctrl+Alt+Enter 在已核验原编辑器内触发，并复用主进程替换校验；渲染界面不监听此快捷键来直接写入。没有当前可替换译文、输入法组合中或过期草稿不会被替换。快捷键只替换，不发送；UI 显示快捷键及就绪/等待/关闭提示，设置关闭快捷键不影响按钮替换。
