# 后台恢复与订单提速：Windows / macOS 对齐

本记录覆盖本次保留在源码中的后台恢复、订单识别、查询交接、原生助手就绪与构建检查。Windows 已安装的 0.5.34 包与之后追加的跨平台源码验证分别记录；现有发行包没有被覆盖或重新安装。

| 能力 | Windows | macOS |
| --- | --- | --- |
| owner 身份检查短暂失败 | 共用 `electron/vendor-owner.ts`，连续失败有界容忍，身份变化立即失效 | 同一实现；区分 owner 退出与检查预算耗尽，后者使用可恢复退出码 72 |
| 助手异常退出恢复 | `scripts/lib/windows-vendor-bootstrap.cjs`，1 / 3 / 10 秒有限重试 | `native/macos/CompanionRecovery.swift` 与 `scripts/install-macos-companion.mjs` 的 launcher；同样三个退避档位，owner 结束或取消即停止 |
| 原生助手迟到就绪 | 共用 `electron/native-adapter.ts`，有效 ready 后及时重新检查，旧子进程事件不影响新进程 | 同一实现，darwin 分支测试覆盖 |
| 原生启动身份查询 | ToolHelp 读取父 PID，保留有界 CIM 身份核验 | 已使用 NSRunningApplication / sysctl 直接读取，没有对应的 PowerShell 冷启动开销，无须移植 Windows API |
| 提前识别当前订单 | 固定 header 的当前 React root、owner 合同、store 与会话字段均匹配后读取 | 同一严格能力探测与会话核验；native poll → driver → host → panel 链路已接通，不等待右侧详情内容 |
| 页面结构不支持或发生歧义 | 能力缺失走受控后备路径，识别出的无效源拒绝使用 | `undefined` 才允许旧 iframe observer；`null` 清空并阻止后备覆盖；有效对象优先，晚到 iframe 不覆盖它 |
| 独立验证并行、查询授权 | 共用 driver 与 companion service；授权前重新读取并复核账号、会话、lease、epoch | 同一实现，保留助手自有登录与凭据隔离 |
| 连接发现与取消 | 隐藏多账号场景可等待前台恢复，取消会移除监听器 | 补齐取消唤醒与监听器清理；保留 Mac 原有有限发现时限，没有增加官方窗口生命周期或渲染节流修补 |
| 构建检查 | Windows 平台测试、原生绑定测试、查询浮层测试 | Mac 两个构建入口加入页面、独立会话、早期订单、原生恢复、浮层及隔离 launcher 测试 |

Mac launcher 保留首次 30 秒等待单实例锁释放的行为。启动成功后的正常退出码 0 不重启；异常退出最多恢复三次。Mac 没有可信的 panel-mounted 握手，因此不以“进程还活着”重置预算，避免无限崩溃循环。监督只作用于助手自身，不修补官方窗口。

## 本轮 Windows 源码检查（2026-10-24）

- 类型检查与完整应用构建通过；Windows owner 恢复 11 / 11、生命周期 27 / 27、面板恢复 4 / 4、订单 31 / 31、原生就绪 4 / 4、查询浮层 14 / 14 通过。原生目标绑定项目构建零警告、零错误，运行通过 45 项检查。
- darwin 配置的订单模拟 14 / 14 通过；原生恢复与就绪模拟 10 项通过，Swift 状态机 1 项跳过；完整 launcher 集成因 Windows 主机跳过。
- Mac 独立会话套件在 Windows 通过 7 项、失败 1 项（POSIX 文件权限期望 0600、实际 0666）；Mac 页面选择通过 2 项、失败 3 项（POSIX URL/home 路径假设）。这些失败不计为 macOS 通过，也未扩大范围修改平台测试。
- 独立评审发现并修复查询浮层在授权完成前向旧 bearer 页面发送新订单的竞态；修复后 14 项浮层回归通过，复核无剩余确定 P0 至 P2。
- 本轮没有重新构建 0.5.35 安装器，没有注入、安装或操作已安装客户端。下列 Mac 构建与设备记录属于历史证据，本轮未重跑。

## 历史验证记录（非本轮复跑）

在 Apple Silicon Mac 的独立源码目录执行，未覆盖该机已有未提交工作：

- 页面选择 5 / 5、独立登录与会话 8 / 8、早期订单与授权 14 / 14、原生恢复与 ready 11 / 11、查询浮层 4 / 4。
- 完整 Swift launcher 编译并运行四组模拟子进程：三次有限恢复、正常退出不恢复、owner 在退避时退出取消、首次短暂退出后的启动重试。全部通过，没有重叠启动。
- `npm run build:native:mac` 生成 arm64 + x86_64 通用原生助手；`TMC_RUNTIME_PLATFORM=darwin npm run build` 通过类型检查及构建。
- Windows 订单 29 / 29、生命周期 20 / 20、owner 恢复 11 / 11 通过；独立代码评审未发现 P0–P2 问题。

测试使用临时目录中的虚构应用及子进程。未安装或启动修改后的官方 Mac 客户端，未访问其账号，也未做 Mac 真实会话、输入法、长时间后台或原入口冷启动验收。Mac 实机功能验收仍须用户在一次性安装器中主动安装后进行。

当前 Mac 缓存的受支持 renderer 字节哈希与项目 pinned 版本一致，并包含订单提示所需的合同标记；这只是静态资源核验，不等同于真实页面运行验证。
