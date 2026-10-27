# 助手翻译运行日志

日志弹窗提供中文摘要与「原始字段」切换；正常翻译按操作合并一条记录，不按输入字符或后台登录轮询逐条刷日志。基础日志由助手独立采集；0.7.3 增加接收 TSiM 翻译接口的可选 `diagnostics`，需配套后端部署后才有上游用量和分段耗时。旧后端仍可正常翻译，未报告的字段保留为未提供。

## 记录范围

| 事件 | 内容 |
| --- | --- |
| `runtime-environment` | 本次运行编号、应用与安装器版本、系统及架构、Electron/Node 版本、助手进程编号 |
| `translation-summary` | 一次翻译的触发方式、输入规模、等待、鉴权、请求阶段、编辑器核对、预览发布、结果去向 |
| `translation-action` | 替换或 Enter 发送操作，关联原翻译编号，分别记录耗时、读回核对、发送触发及待确认状态 |
| `runtime-health` | 每 30 秒记录助手进程内存、堆内存、采样调度延误、运行时长、连接尝试及日志淘汰情况 |
| `translation-statistics` | 每 5 分钟（有实际翻译请求时）或退出时汇总请求数、结果分类及耗时分位数 |

`traceId` 和 `runId` 是本机随机生成的诊断编号，`parentTraceId` 关联翻译与替换/发送。它们不包含客户、订单或账号标识。

## 主要字段与计时口径

所有耗时使用本机单调时钟，单位毫秒；ISO 时间字段仅用于定位发生时间，不用客户端和服务端墙钟相减计算耗时。不同阶段可能重叠，不能把所有字段直接相加。

| 字段 | 含义 |
| --- | --- |
| `operationStartedAt` / `requestStartedAt` | 助手操作及实际翻译 HTTP 尝试开始时间 |
| `responseHeadersAt` / `responseCompletedAt` | 收到翻译响应头及完整响应体时间；失败未到达该阶段就不提供 |
| `trigger` | 自动、手动或 Enter 触发 |
| `sourceLanguage` / `targetLanguage` / `targetSource` | 请求语言及手动、识别、兜底选择来源 |
| `sourceChars` / `targetChars` / `requestBytes` / `responseBytes` | 文本字符数与 JSON 请求/响应规模，不包含正文 |
| `configuredWaitMs` / `actualWaitMs` | 当前自适应等待值及本次输入观测到翻译准备开始的时间；手动操作从操作开始计 |
| `inputTimingSource` | 原生输入事件、编辑器读取或手动操作。编辑器轮询只能给出观测后的等待，不代表物理按键时间 |
| `schedulerDelayMs` / `inFlightWaitMs` | 超过计划触发时刻的时间、观测新输入后旧请求尚未结束的时长；两者可重叠 |
| `authMs` / `authChecks` / `authCheckMode` | 会话检查耗时、次数、fresh/joined/reused/owned。等待已有检查时不虚构一份所属 HTTP 请求 |
| `authHttpCount` / `authHttpMs` | 当前操作中实际产生的 profile/refresh 请求数及累计耗时 |
| `authHeadersMs` / `authBodyMs` / `authParseMs` | 鉴权请求的响应头、响应体和解析分段累计耗时 |
| `authTokenReads` / `authTokenReadMs` / `postReadTokenMs` | Windows 既有登录态读取次数、耗时及翻译响应后的复核耗时；macOS 不读取其他应用登录态 |
| `httpMethod` / `httpRoute` / `httpStatus` / `contentType` | 翻译接口、方法、状态码和经过枚举限制的响应类型，不记录完整 URL 或任意头部 |
| `headersMs` | 发起 fetch 到收到响应头，包含链路和服务端等待，不能当作供应商耗时 |
| `bodyMs` / `parseMs` / `httpMs` | 响应体读取、JSON 解析、整个助手 HTTP 请求处理耗时。错误返回只记录已观测阶段，不额外读取错误体 |
| `timeoutMs` / `failedElapsedMs` / `httpFailurePhase` | 超时配置、失败前等待及失败阶段。无响应时不虚构状态码 |
| `captureBeforeMs` / `captureAfterMs` / `editorLockMs` | 翻译前后编辑器读取及等待编辑器操作锁的时间 |
| `responseToPreviewMs` / `previewPublishMs` | 收到完整响应体到预览 DOM 更新确认、发布预览到确认的时间 |
| `userWaitMs` / `previewShown` | 输入观测（或手动操作）到预览 DOM 更新确认的时间，以及是否取得确认。不代表已测量物理屏幕绘制 |
| `replaceMs` / `sendMs` / `readbackMatched` | 草稿替换、发送触发耗时及读回核对。翻译摘要中的读回指原草稿仍匹配；替换摘要中的读回指替换结果一致 |
| `sendTriggered` / `sendConfirmed` | 是否成功触发原客户端发送；目前没有业务送达确认，所以不把触发成功记为已送达 |
| `outcome` / `reason` / `code` | 已展示、生成成功但无预览确认、替换、发送待确认、跳过、主动取消、被新输入替代、失败、限流及白名单原因/错误码 |
| `providerReported` / `translationProfile` / `translationProtocol` / `policyVersion` | 仅在现有响应提供且通过白名单时记录；提供商字段是接口声明，不是独立核验的供应商实际调用 |
| `headerRetryAfterMs` / `providerRetryAfterMs` / `retryable` | 仅记录已返回且已读取、合法的重试建议，不因此新增重试 |

### TSiM 返回的可选诊断

单条和批量响应的顶层 `diagnostics` 使用版本 1；批量只返回一份，不向每项重复分配 Token。`attribution: request_owned_calls` 表示只统计此请求新建的上游调用，包含分组和受限回退；等待其他请求的在途结果不继承其用量。

| 接口字段 | 口径 |
| --- | --- |
| `server_ms` | TSiM 翻译 handler 进入至构造响应前的耗时；不含依赖鉴权、响应序列化、代理和网络传输 |
| `upstream_ms` | 本请求新建的上游 HTTP 传输耗时之和；不含排队、后置配置复核及计量写库 |
| `provider_queue_ms` | 本请求新建调用取得供应商并发槽之前的等待耗时之和 |
| `upstream_calls` / `upstream_calls_completed` | 本请求实际开始及已结束的上游传输次数；不等于成功次数或已计费次数 |
| `input_tokens` / `output_tokens` | 上游报告的输入及输出 Token；各字段只有所有本请求新建调用均报告时才累加，否则为 `null` |
| `cached_input_tokens` / `cache_write_tokens` / `reasoning_tokens` | 上游报告的输入缓存读取、缓存写入、推理 Token；缓存读取属于输入的一部分，推理属于输出的一部分，不重复相加 |
| `usage_complete` | 是否存在新建调用、全部调用已结束，且输入和输出 Token 均完整报告；不表示所有可选明细都有报告 |
| `result_source` | `upstream`、`memory_cache`、`shared_cache`、`singleflight`、`mixed` 或 `none`，反映本请求结果的获取路径 |

助手分别将 `upstream_ms`、`server_ms`、`result_source` 展示在原有供应商耗时、服务端耗时、缓存来源字段；并保留本机 `httpMs` 的客户端请求耗时。并行调用的累计上游耗时可能大于服务端墙钟耗时，不能将所有分段直接相加，也不能用客户端耗时减服务端耗时精确推定网络延迟。

没有上游调用时 Token 和上游耗时为 `null`，不会复制缓存产生时的历史用量。供应商未提供的字段不根据字符数估算。真实模型、费用、首 Token 延迟及代理耗时仍不在此合同中。缺失字段表示没有采集到，不等于零。

后端可在错误的 `detail.diagnostics` 返回同一合同；助手 HTTP 失败仍可能在响应头阶段就返回原业务错误，不为排障等待额外的错误体读取，因此这类失败的后端诊断可能无法显示。macOS 现有 `response.text()` 失败时无法取得部分响应字节，留空；Windows 原有流式读取能保留已收到的字节数。

## 汇总、容量与隐私

统计里的 `requests` 只统计已尝试发出翻译 HTTP 的操作，鉴权前被拒绝的操作仍有单独摘要，不计作翻译 HTTP 请求。每个统计窗口保留最多 256 个最近的数字耗时样本；P50/P95/最大值都基于这批样本，并提供 `httpSampleCount`、`userSampleCount`。成功、取消、被替代、限流分别计数；超时数是失败中的附加分类。

健康采样调度延误可受事件循环拥堵、进程挂起或系统休眠影响，不能单凭它认定 CPU 繁忙。`reconnectCount` 是初次连接后的连接尝试次数，不代表每次都成功恢复。

日志内存最多 1000 条；磁盘当前和上一代各最多 500 条且各不超过 512 KiB。容量满时淘汰旧记录，日志不可写也不会阻断业务。遥测采用字段、枚举与错误码白名单；不记录客户正文、译文、账号/订单标识、凭据、浏览器路径、任意异常文本或任意 HTTP 头部。

相关检查：`node tests/run-translation-http-telemetry.mjs`、`node tests/run-translation-service-telemetry.mjs`、`node tests/run-telemetry-log-viewer.mjs`。macOS 安装器打包入口会执行这些检查；真实账号翻译和原客户端操作仍需安装后单独验收。
