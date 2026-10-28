import {safeCode} from '../../host-node/diagnostics';
/** Public, browser-safe telemetry projection. Never copy arbitrary payload fields into logs. */
const EVENTS=new Set(['translation-summary','translation-action','session-check','runtime-health','translation-statistics','runtime-environment']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER=/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-zA-Z0-9.-]{1,40})?$/;
const NUMBER_FIELDS=new Set(('elapsedMs replaceMs sendMs sourceChars targetChars configuredWaitMs actualWaitMs schedulerDelayMs inFlightWaitMs authMs authChecks authHttpCount authHttpMs authGeneration inputRevision contextRevision httpMs headersMs bodyMs parseMs requestBytes responseBytes contentLength httpStatus timeoutMs failedElapsedMs captureBeforeMs captureAfterMs editorLockMs postAuthMs postReadTokenMs previewPublishMs responseToPreviewMs userWaitMs attempt headerRetryAfterMs providerRetryAfterMs pid uptimeMs rssBytes heapUsedBytes heapTotalBytes eventLoopDelayMs logRetained logEvicted connectionEpoch reconnectCount windowMs requests successCount failureCount timeoutCount rateLimitedCount cancelledCount supersededCount httpP50Ms httpP95Ms httpMaxMs userP50Ms userP95Ms userMaxMs authTokenReadMs authTokenReads authHeadersMs authBodyMs authParseMs authFailedElapsedMs authHttpStatus').split(' '));
const NULLABLE_NUMBER_FIELDS=new Set(['providerMs','providerQueueMs']);
const NULLABLE_INTEGER_FIELDS=new Set(['inputTokens','outputTokens','cachedInputTokens','cacheWriteTokens','reasoningTokens']);
const INTEGER_FIELDS=new Set(['httpSampleCount','userSampleCount','upstreamCalls','upstreamCallsCompleted']);
const BOOLEAN_FIELDS=new Set('translationSent previewShown readbackMatched sendTriggered sendConfirmed foreground composing plainText retryable usageComplete'.split(' '));
const LANGUAGES=['zh','en','ja','ko','es','fr','de','ru','pt','it','ar','th','vi','id','ms','zh-TW','tr','unknown'];
const ENUMS:Record<string,readonly string[]>={
  inputTimingSource:['native-event','capture','manual'],httpMethod:['POST','GET'],httpRoute:['/agent/translate','/agent/translate/batch','/agent/profile','/agent/auth/refresh'],contentType:['application/json','other'],
  operation:['translate','replace','send'],trigger:['automatic','manual','enter'],
  outcome:['shown','replaced','send-triggered','send-unconfirmed','cancelled','superseded','failed','rate-limited','skipped','success'],
  reason:['empty','empty-draft','empty-translation','not-ready','busy','paused','unchanged','stale','superseded','aborted','cancelled','auth-changed','login-required','permission-required','context-changed','draft-changed','composing','not-plain-text','unavailable','timeout','network','invalid-response','rate-limited','request-failed','not-foreground','closed','unknown'],
  sourceLanguage:LANGUAGES,targetLanguage:LANGUAGES,targetSource:['manual','recognized','fallback','unavailable'],
  authCheckMode:['fresh','joined','reused','owned'],authStateBefore:['ready','needs_login','connecting','failed'],authStateAfter:['ready','needs_login','connecting','failed'],sessionMode:['browser','owned'],
  httpFailurePhase:['request','headers','body','parse','validation','auth'],authHttpFailurePhase:['request','headers','body','parse','validation','auth'],
  providerReported:['deepl','deepseek','openai','google','google_nmt','anthropic','azure','tencent','baidu','unknown'],
  translationProfile:['customer_reading','agent_draft','sent_reading','generic'],
  translationProtocol:['agent-translation-items-v1'],usageAttribution:['request_owned_calls'],cacheSource:['unknown','upstream','memory_cache','shared_cache','singleflight','mixed','none'],platform:['win32','darwin'],arch:['arm64','x64'],
};
export function sanitizeTelemetry(value:unknown):Record<string,unknown>|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  let descriptors:Record<string,PropertyDescriptor>;try{descriptors=Object.getOwnPropertyDescriptors(value);}catch{return;}
  const event=descriptors.event?.value;
  if(typeof event!=='string'||!EVENTS.has(event))return;
  const result:Record<string,unknown>={event};
  for(const key of Object.keys(descriptors)){
    const descriptor=descriptors[key];if(!Object.hasOwn(descriptor,'value'))continue;const item=descriptor.value;
    if(key==='diagnosticsVersion'){if(item===1)result[key]=item;continue;}
    if(NULLABLE_NUMBER_FIELDS.has(key)||key==='serverMs'){if(item===null||typeof item==='number'&&Number.isFinite(item)&&item>=0)result[key]=item;continue;}
    if(NULLABLE_INTEGER_FIELDS.has(key)){if(item===null||typeof item==='number'&&Number.isSafeInteger(item)&&item>=0)result[key]=item;continue;}
    if(INTEGER_FIELDS.has(key)){if(typeof item==='number'&&Number.isSafeInteger(item)&&item>=0)result[key]=item;continue;}
    if(NUMBER_FIELDS.has(key)){if(typeof item==='number'&&Number.isFinite(item)&&item>=0)result[key]=item;continue;}
    if(BOOLEAN_FIELDS.has(key)){if(typeof item==='boolean')result[key]=item;continue;}
    if(Object.hasOwn(ENUMS,key)){if(typeof item==='string'&&ENUMS[key].includes(item))result[key]=item;continue;}
    if(typeof item!=='string')continue;
    if(['operationStartedAt','requestStartedAt','responseHeadersAt','responseCompletedAt'].includes(key)&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item)&&Number.isFinite(Date.parse(item))){result[key]=item;continue;}
    if(key==='code'){result.code=['REQUEST_SUPERSEDED','SERVICE_RESPONSE_TOO_LARGE','OWNED_SERVICE_CLOSED','SESSION_STORAGE_CORRUPT','PSIM_SESSION_LOAD_FAILED','PSIM_SESSION_SAVE_FAILED','PSIM_SESSION_CLEAR_FAILED','INVALID_STORED_SESSION','LOGIN_RESPONSE_INVALID','REFRESH_RESPONSE_INVALID','SESSION_STORAGE_ENCRYPTION_UNAVAILABLE','BROWSER_SESSION_ACCESS_DENIED'].includes(item)||/^PSIM_HTTP_(?:401|403|422|423|429|500|502|503|504)(?:_VALIDATION)?$/.test(item)?item:safeCode(item);continue;}
    if((key==='traceId'||key==='parentTraceId'||key==='serverRequestId')&&UUID.test(item)||key==='runId'&&/^(?:[a-f0-9]{16}|[a-f0-9]{32})$/.test(item)||key==='policyVersion'&&/^20\d{2}-\d{2}-\d{2}\.\d{1,4}$/.test(item)||(key==='appVersion'||key==='injectorVersion'||key==='electronVersion'||key==='nodeVersion')&&SEMVER.test(item)||key==='osRelease'&&/^\d{1,5}(?:\.\d{1,5}){1,3}$/.test(item))result[key]=item;
  }
  return result;
}
const LABELS:Record<string,string>={diagnosticsVersion:'诊断协议版本',usageAttribution:'用量归属',providerQueueMs:'新建上游调用排队合计',upstreamCalls:'新建上游调用数',upstreamCallsCompleted:'完成上游调用数',inputTokens:'上游输入Token合计',outputTokens:'上游输出Token合计',cachedInputTokens:'上游缓存读取Token',cacheWriteTokens:'上游缓存写入Token',reasoningTokens:'上游推理Token',usageComplete:'Token用量完整',reason:'原因',httpRoute:'接口',httpMethod:'方法',contentType:'响应类型',replaceMs:'替换耗时',sendMs:'发送耗时',httpSampleCount:'请求耗时样本数',userSampleCount:'用户等待样本数',trigger:'触发方式',inputTimingSource:'输入计时来源',configuredWaitMs:'配置等待',schedulerDelayMs:'超过计划触发时间',inFlightWaitMs:'旧请求占用时长',captureBeforeMs:'前置编辑器读取',captureAfterMs:'后置编辑器读取',editorLockMs:'编辑器锁等待',postAuthMs:'后置授权',postReadTokenMs:'响应后登录检查',previewPublishMs:'预览发布',responseToPreviewMs:'响应至预览',authChecks:'会话检查次数',authHttpCount:'鉴权请求次数',authTokenReadMs:'登录存储读取',authTokenReads:'登录存储读取次数',authHeadersMs:'鉴权响应头',authBodyMs:'鉴权响应读取',authParseMs:'鉴权JSON解析',authHttpStatus:'鉴权HTTP状态',authHttpFailurePhase:'鉴权失败阶段',failedElapsedMs:'失败前耗时',timeoutMs:'超时限制',requestBytes:'请求字节',responseBytes:'响应字节',contentLength:'响应声明字节',providerReported:'服务端报告供应商',translationProfile:'翻译场景',translationProtocol:'翻译协议',policyVersion:'策略版本',translationSent:'请求已发出',previewShown:'预览更新确认',readbackMatched:'草稿读回一致',sendTriggered:'发送已触发',sendConfirmed:'发送已确认',authStateBefore:'检查前登录状态',authStateAfter:'检查后登录状态',sourceChars:'原文字数',targetChars:'译文字数',headerRetryAfterMs:'响应头重试等待',providerRetryAfterMs:'供应商重试等待',timeoutCount:'超时数',rateLimitedCount:'限流数',cancelledCount:'取消数',supersededCount:'被替代数',httpMaxMs:'请求最大耗时',userP50Ms:'用户等待P50',userMaxMs:'用户等待最大耗时',rssBytes:'常驻内存字节',heapUsedBytes:'已用堆字节',heapTotalBytes:'总堆字节',eventLoopDelayMs:'事件循环延迟',uptimeMs:'运行时长',logRetained:'保留日志数',logEvicted:'淘汰日志数',reconnectCount:'重连次数',electronVersion:'Electron版本',nodeVersion:'Node版本',injectorVersion:'安装器版本',osRelease:'系统版本',operation:'操作',outcome:'结果',elapsedMs:'总耗时',userWaitMs:'输入观测至预览',actualWaitMs:'输入等待',authMs:'会话校验',httpMs:'翻译请求',headersMs:'响应头',bodyMs:'响应读取',parseMs:'JSON解析',authHttpMs:'鉴权请求',providerMs:'上游传输耗时合计',serverMs:'TSIM处理耗时',cacheSource:'结果来源',sourceLanguage:'源语言',targetLanguage:'目标语言',targetSource:'目标来源',authCheckMode:'会话模式',httpStatus:'HTTP状态',httpFailurePhase:'失败阶段',code:'错误码',requests:'请求数',successCount:'成功数',failureCount:'失败数',httpP50Ms:'请求P50',httpP95Ms:'请求P95',userP95Ms:'用户等待P95',platform:'平台',arch:'架构',appVersion:'应用版本'};
/** Localized display of the safe projection; raw diagnostic values are never mutated. */
export function formatTelemetry(value:unknown):string {
  const safe=sanitizeTelemetry(value);if(!safe)return '';
  const titles:Record<string,string>={'translation-summary':'翻译摘要','translation-action':'翻译操作','session-check':'会话检查','runtime-health':'运行健康','translation-statistics':'翻译统计','runtime-environment':'运行环境'};
  const parts=[titles[String(safe.event)]];
  const localized:Record<string,string>={request_owned_calls:'仅本请求新建调用',upstream:'新建上游调用',memory_cache:'进程缓存',shared_cache:'共享缓存',singleflight:'等待共享请求',mixed:'混合来源',none:'无结果来源',unknown:'未知',translate:'翻译',replace:'替换',send:'发送',shown:'已展示',replaced:'已替换','send-triggered':'已触发发送','send-unconfirmed':'发送待确认',cancelled:'已取消',superseded:'被新输入替代',failed:'失败','rate-limited':'限流',skipped:'已跳过',success:'成功',manual:'手动',recognized:'识别',fallback:'备用',unavailable:'不可用',fresh:'新检查',joined:'等待进行中检查',reused:'复用近期检查',owned:'助手会话',automatic:'自动',enter:'回车',ready:'已登录',needs_login:'需要登录',connecting:'连接中',request:'请求连接',headers:'响应头',body:'响应读取',parse:'JSON解析',validation:'响应校验',auth:'登录校验','native-event':'输入事件',capture:'编辑器读取','draft-changed':'草稿已变化','auth-changed':'登录已变化','context-changed':'客户会话已变化','not-foreground':'窗口在后台','login-required':'需要登录','permission-required':'权限不足','empty-draft':'草稿为空','not-ready':'未就绪','not-plain-text':'草稿不是纯文本',composing:'输入法组合中',timeout:'超时',network:'网络失败','invalid-response':'响应无效','request-failed':'请求失败',closed:'助手已关闭',paused:'翻译已暂停'};
  const priority=['operation','outcome','sourceLanguage','targetLanguage','httpMs','userWaitMs','httpStatus','actualWaitMs','authMs','headersMs','bodyMs','parseMs','reason','code'];
  for(const key of [...new Set([...priority,...Object.keys(LABELS)])]){const label=LABELS[key];if(Object.hasOwn(safe,key))parts.push(`${label}：${safe[key]===null?'未提供':typeof safe[key]==='boolean'?(safe[key]?'是':'否'):typeof safe[key]==='string'?(localized[safe[key] as string]??(safe[key] as string).replace(/^PSIM_/,'TSIM_')):safe[key]}${typeof safe[key]==='number'&&key.endsWith('Ms')?' ms':''}`);}
  if(safe.event==='translation-summary')for(const key of ['providerMs','serverMs','cacheSource'])if(!Object.hasOwn(safe,key))parts.push(`${LABELS[key]}：未提供`);
  return parts.join(' · ');
}
