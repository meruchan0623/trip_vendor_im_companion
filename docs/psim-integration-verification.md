# tsim_cs 隔离集成验证与补丁交接

日期：2026-10-14。状态：本地实现、构建和相关自动测试通过；未提交、未推送、未部署、未上线。

## 基准与范围

- 上游：`https://github.com/meruchan0623/TSim_CS.git`
- 隔离工作树：`C:\Develop\travel-merchant-companion\work\tsim-host-integration`
- 基准SHA：`be882c40875becb40e804ea84a03c82fff30a3ad`，fetch后的origin/develop，detached HEAD。
- 原checkout仍为 `c3f661b8d7c93cfe87270a20cfe7051f0fe4e694`，未pull、checkout或改写；fetch只更新远端引用。
- 补丁：`docs/psim-desktop-host-integration.patch`，仅8个agent-frontend源码/测试文件，不含dist、node_modules、env或任何凭据。

完整实现 `/desktop-host` 独立route、站点React page→现有apiClient/authStore适配、登录返回白名单、窄桥类型与运行时、真实iframe隔离和测试。供应商密钥不涉及此补丁，tsim_cs客服token不离开受控HTTPS站点；账号与权限变化使在途请求和iframe失效。

## 验证

安装使用仓库pnpm11.5.3与冻结lockfile；只有`.env.production.example`被枚举，无环境文件内容或秘密被读取。构建通过命令传入公开API/socket origin，未启动服务或调用业务API。

```powershell
$env:VITE_API_BASE_URL = 'https://csapi.tsim.tech'
$env:VITE_SOCKETIO_URL = 'https://csapi.tsim.tech'
$env:VITE_REMOTE_API_URL = 'https://csapi.tsim.tech'
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec vitest run src/desktop-host/runtime.test.ts src/pages/DesktopHostPage.test.tsx src/utils/authReturnPath.session.test.ts src/pages/OperatorEmbedPage.test.tsx src/pages/operatorEmbedViewport.test.ts
node --experimental-strip-types --test src/utils/translationPurposeContracts.test.ts
pnpm run build
```

- Vitest：5 suites/43 tests通过，包括11项宿主安全协议、4项真实站点绑定、4项登录返回、24项既有Operator/viewport契约。
- 原Node runner：3项翻译purpose契约通过。首次错误地由Vitest运行此Node测试时“No test suite found”，已改正确runner验证，没有改测试消除报错。
- 完整构建：TypeScript通过，Vite6.4.3转换8913 modules，DesktopHostPage chunk9.23kB，PWA release artifact `agent-77ac491abae19f6c`验证通过，退出码0。
- 构建存在既有dynamic/static import及大chunk提示，没有借本任务重构整个站点。
- 源码范围 `git diff --check` 与补丁 `git apply --reverse --check`通过。
- React Doctor首次已跟踪3文件100/100，无诊断；将新文件纳入后第二次扫描最终完成，扫描9文件/274秒，100/100、无诊断、退出码0。未安装其项目脚本或修改依赖。

## 应用与回滚

补丁面向上述基准，在独立目标工作树审查并应用，不能直接套到原落后checkout。以下命令都应在目标工作树根执行：

```powershell
git rev-parse HEAD
git apply --check <补丁完整路径>
git apply <补丁完整路径>
```

再运行相关测试和完整前端构建。未经生产授权不部署、不推送。回滚仅在这8个文件未有后续相关改动且反向检查成功后：

```powershell
git apply --reverse --check <补丁完整路径>
git apply --reverse <补丁完整路径>
```

后续分支漂移或相关改动发生冲突，应重新审查差异，不强制覆盖。

## 外部门槛

`operatorReadOnlyVerified:false`保持查询关闭，直到受限账号和服务端拒绝退款、取消、客诉编辑等写入完成真实验收。本地Electron同时精确限制允许的HTTP写方法路径，不开放客户发送入口。现有Ctrip/Trip标识到TSim订单映射未确认，自动订单联动继续禁用。

HTTPS路由部署、站点CSP/frame-ancestors、独立Electron分区登录、ego-browser真实iframe/401/403/423/快速换单验收、线上翻译与p50/p95延迟尚未完成。Edge已有登录不代表独立分区已认证。Mac仍缺真实环境。Windowshelper编译和绑定快照已通过，但UIA结构探针超时，自动原文/订单/草稿读写没有可用证据。
