# Windows 注入器 0.5.39 打包交接

本次 Windows 源码版本为 **0.5.39**，承接 macOS 注入器 0.7.4 中的共享修复。Windows 安装器 EXE 尚未在 Windows 主机上构建或安装验收；macOS 包和测试结果不能代替 Windows 实机结果。

## 本版本更改了什么

| 行为 | Windows 打包后应得到的变化 | 主要源码 |
| --- | --- | --- |
| 旧 TSIM 后端翻译兼容 | 首次请求仅发送六个出站字段，不再因可选来源字段触发额外字段拒绝；422 不自动重试 | `src/shared/translation-request.ts`、`electron/browser-profile-session.ts`、`browser-extension/background.js` |
| 错误分类和会话撤销 | 区分 422 校验、权限、登录/锁定、限流、服务故障、超时；错误体读取取消优先；浏览器桥收到新旧登录拒绝码均撤销待处理请求 | `src/shared/translation-http-error.ts`、`electron/browser-session.ts`、`electron/companion-service.ts` |
| 订单工作台 | 仅点击时加载完整 TSIM 页面；关闭后最多保留 60 秒；会话、账号或授权变化释放旧页面 | `runtime/page/operator-overlay.ts`、`runtime/page/index.ts` |
| 订单和套餐摘要 | 稳定心跳不重复更新摘要；来源扫描及布局按相关变更触发，弹窗与详情新增内容仍正确避让 | `runtime/page/identifiers.ts`、`runtime/page/order-summary-card.ts` |
| 客户语言识别 | 缓存当前会话原文窗口，避免重复推理；处理长无空格、邮箱和点分隔文本的重复正则回溯 | `runtime/page/language.ts` |
| 可见术语 | 助手面板、登录、查询及格式化日志使用 TSIM；内部账号作用域、存储键和历史错误码保持兼容 | `runtime/page/`、`src/ui/Panels.tsx`、`src/shared/runtime-telemetry.ts` |
| 首次最大化 | 主窗口构造完成、标题可识别后再判断首次最大化，保持后续用户还原/调整窗口的行为 | `scripts/lib/windows-vendor-bootstrap.cjs` |

Windows 继续使用现有 Edge / Chrome 登录方式。官方客户端的 Electron 和聊天业务脚本不由本次修复升级。Windows 使用宿主提前核验订单提示；DOM 订单观察是按需的回退路径，不必与 macOS 使用完全相同的内部调用次数。

兼容旧后端的代价：出站请求不发送 `client_source`，服务端暂不能通过该字段细分插件来源。本地诊断及配套后端返回的安全诊断字段仍可用。不要为了恢复来源统计擅自加回该字段，也不要采用 422 后删字段重试。

## 打包前同步与环境

1. 取得本轮**全部分块提交**，核对 `git log` 和文件状态；只挑某个页面提交会遗漏共享接口、错误映射或直接测试。
2. 使用 Windows x64、Node.js/npm、PowerShell 和 .NET 10 SDK。脚本优先使用 `work/tools/dotnet/dotnet.exe`，否则使用 `TMC_DOTNET` 或 PATH 中的 `dotnet`。
3. 在 Windows 检出源码后重新安装依赖；不要跨系统复制 `node_modules`。不要复制 macOS 的 `dist`、`dist-electron`、`dist-runtime` 或 `work/mac-installer` 作为 Windows 载荷。
4. 打包脚本固定 `TMC_RUNTIME_PLATFORM=win32`、`TMC_WINDOWS_DYNAMIC=1`、注入器版本 0.5.39，重新构建前端、运行时、原生助手及安装器。

```powershell
npm ci
npm run package:windows:injector
```

预期产物：

- `release/旅游商家助手-0.5.39-Windows资源注入安装.exe`
- 同名 `.exe.sha256`
- `work/windows-inject/build-report.json`

助手基础应用版本仍为 0.3.2，Windows 注入版本为 0.5.39；不要仅凭应用基础版本判断是否含本轮修复。旧 0.5.38 产物属于历史版本，不应改名充当 0.5.39。

## 打包门禁与注释约定

`scripts/package-windows-injector.mjs` 已标注本版本与 macOS 共享修复的关系，并在原有门禁中加入：

- `tests/run-order-observation.mjs`：订单来源变更、导航失效、布局通知与释放。
- `tests/run-page-performance.mjs`：原文缓存、长文本、稳定边界不重排、按需加载及会话释放。该 runner 接受打包脚本的 win32 环境，不能固定使用 darwin 分支。

既有翻译、工作台、摘要、Windows 生命周期、原生绑定、连接恢复及安装器进程退出检查继续运行。任何失败均应停止打包，不删除测试或跳过错误。

共享翻译投影旁的注释说明为何首次请求就采用旧协议六字段，以及为何不能靠重试探测兼容性。页面代码中的注释说明稳定心跳短路、缓存失效和关闭页面释放的安全边界；修改这些策略时连同对应行为测试更新。

## Windows 安装后验收

本机已完成跨平台可运行的 Windows 行为回归；Windows 原生构建、原生进程检查、物理键盘与 IME、官方窗口布局和真实服务仍由 Windows 主机验收。

安装需在用户主动操作安装器前完全退出客户端、助手和更新程序。安装后记录客户端版本、注入器 0.5.39、构建报告及 EXE 哈希，逐项检查：

1. 浏览器登录及账号切换正常；401/423 后旧译文和旧账号请求立即失效。
2. 中文 IME、复制粘贴、撤销、预览、替换和原有发送模式正确，不丢字、不误发、不跨会话写回。
3. 真实翻译正常；未知 422 不误报权限或网络，也不重复发送翻译请求。
4. 未点击订单时不加载完整 TSIM 工作台；关闭后释放、再开和切会话无旧订单闪现。
5. 长聊天滚动、快速切会话、窗口缩放、官方弹窗、订单详情内容变化时摘要位置和层级正确。
6. 冷启动、重连、助手退出及安装/恢复流程正确；官方客户端性能指标按同条件对照记录。

这些源码修复可随 Windows 包生效，但本记录不承诺两种系统获得相同的延迟改善幅度。完整 macOS 构建证据及剩余限制见 [0.7.4 验收记录](2026-10-28-tsim-injector-0.7.4-validation.md)。
