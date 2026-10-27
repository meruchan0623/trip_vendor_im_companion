'use strict';
// Runs before the unchanged vendor main. No business API or vendor content is read here; the
// only renderer access is a DOM-only startup placeholder drawn in our own isolated world.
const path = require('node:path');
// Progress stages the helper may report. Anything else on the pipe is ignored.
const HELPER_STAGES = new Set(['host-ready', 'start', 'files-verified', 'transport-ready', 'target-found', 'page-verified', 'native-ready', 'panel-mounted', 'failed']);
const LOADING_STEPS = {
  launching: [1, '启动助手进程'],
  'host-ready': [2, '等待客服窗口就绪'],
  start: [3, '校验客户端文件'],
  'files-verified': [4, '建立安全连接'],
  'transport-ready': [5, '定位客服页面'],
  'target-found': [6, '校验页面完整性'],
  'page-verified': [7, '挂载翻译面板'],
  'native-ready': [7, '挂载翻译面板'],
};
const LOADING_TOTAL = 7;
// Electron reserves 0 (main) and 999 (preload isolation); this world holds only the placeholder.
const LOADING_WORLD_ID = 7301;
const MAX_PROGRESS_LINE = 4096;
const MAX_DIAGNOSTICS = 1000;
const DIAGNOSTIC_EVENTS = new Set(['host-start', 'host-ready', 'host-quit', 'state', 'composer-startup', 'composer-reconnect', 'runtime-waiting-visible', 'runtime-invalidated', 'cdp-command-rejected', 'companion-service-failed', 'cdp-command-timeout', 'cdp-slow-command', 'host-error', 'order-discovery', 'composer-waiting-target']);
// Keep this independent of helper modules: the vendor bootstrap is shipped as one file.
const DIAGNOSTIC_CODES = new Set([
  'ACTIVE_IM_TARGET_UNVERIFIED', 'ALREADY_ATTACHED', 'AMBIGUOUS_CLIENT_WINDOW', 'AMBIGUOUS_IM_TARGET', 'AMBIGUOUS_LISTENER',
  'AUTH_CHANGED', 'BOOTSTRAP_NATIVE_LEASE_ENDED', 'BROWSER_ADOPTION_FAILED', 'BROWSER_BOOTSTRAP_UNAVAILABLE', 'BROWSER_BRIDGE_BUSY',
  'BROWSER_BRIDGE_DIRECTORY_DENIED', 'BROWSER_BRIDGE_DISPOSED', 'BROWSER_BRIDGE_TIMEOUT', 'BROWSER_BRIDGE_UNAVAILABLE', 'BROWSER_CLEANUP_UNCONFIRMED',
  'BROWSER_LOGIN_OPENER_REQUIRED', 'BROWSER_PLACEMENT_FAILED', 'BROWSER_PROFILE_REQUIRED', 'BROWSER_SESSION_DISABLED', 'BROWSER_SESSION_DISPOSED',
  'BROWSER_SESSION_STORAGE_INVALID', 'BROWSER_SESSION_TIMEOUT', 'BROWSER_SPACE_TOO_SMALL', 'CDP_COMMAND_REJECTED', 'CDP_CONNECT_FAILED',
  'CDP_CONNECT_TIMEOUT', 'CDP_DISCONNECTED', 'CLIENT_WINDOW_NOT_FOUND', 'COMPOSER_GEOMETRY_UNAVAILABLE', 'COMPOSER_NOT_PLAIN_TEXT',
  'COMPOSER_PUBLIC_API_UNVERIFIED', 'COMPOSER_SOURCE_UNVERIFIED', 'COMPOSER_UNAVAILABLE', 'CONNECTION_SUPERSEDED', 'CONVERSATION_SOURCE_UNVERIFIED',
  'DEBUGGER_ENABLE', 'DEBUG_ENDPOINT_INVALID', 'DEBUG_ENDPOINT_TIMEOUT', 'DEBUG_ENDPOINT_UNAVAILABLE', 'DEBUG_LISTENER_NOT_AVAILABLE',
  'DEBUG_PORT_REQUIRED', 'DISPLAY_UNAVAILABLE', 'DRAFT_CHANGED', 'DRAFT_COMPARE_AND_SWAP_FAILED', 'DRAFT_FOCUS_REJECTED',
  'DRAFT_READBACK_MISMATCH', 'DRAFT_UPDATE_NOT_OBSERVED', 'DRAFT_WRITE_REJECTED', 'EDGE_NOT_INSTALLED', 'EDITOR_ARTIFACT_NOT_BUILT',
  'EMPTY_DRAFT', 'EMPTY_TRANSLATION', 'EXISTING_CLIENT_DEBUG_PORT_REQUIRED', 'EXISTING_CLIENT_OR_INSTALLER', 'FACTORY_NOT_READY',
  'FINGERPRINT_FILE_CHANGED', 'FINGERPRINT_FILE_UNVERIFIED', 'FORBIDDEN_CDP_METHOD', 'FORBIDDEN_SERVICE_REQUEST', 'FRAME_TREE',
  'HELPER_CLEANUP_FAILED', 'HTML_RESOURCE', 'IM_TARGET_INACTIVE', 'IM_TARGET_LIMIT', 'IM_TARGET_NOT_READY',
  'INPUT_COMPOSING', 'INSPECT_NAV', 'INVALID_ACTION', 'INVALID_APPLY_MODE', 'INVALID_ARGUMENTS',
  'INVALID_AUTH_GENERATION', 'INVALID_AUTH_IDENTITY', 'INVALID_BROWSER_LEASE', 'INVALID_BROWSER_MESSAGE', 'INVALID_BROWSER_SESSION',
  'INVALID_BROWSER_WINDOW', 'INVALID_CONTEXT', 'INVALID_DEBUG_PORT', 'INVALID_INTERACTION_OPTIONS', 'INVALID_LANGUAGE',
  'INVALID_LOOPBACK_RESERVATION', 'INVALID_NATIVE_BINDING', 'INVALID_NATIVE_LEASE', 'INVALID_OPERATOR_URL', 'INVALID_OPTIONS',
  'INVALID_ORDER_IDENTIFIER', 'INVALID_ORDER_PROJECTION', 'INVALID_OUTBOUND_REQUEST', 'INVALID_OWNED_BINDING', 'INVALID_OWNED_GEOMETRY',
  'INVALID_OWNED_LOGIN_URL', 'INVALID_OWNED_MESSAGE', 'INVALID_OWNED_READY', 'INVALID_OWNED_RESPONSE', 'INVALID_PID',
  'INVALID_REATTACH_ARGUMENTS', 'INVALID_SCRIPT_ID', 'INVALID_SERVICE_RESPONSE', 'INVALID_SESSION', 'INVALID_SHORTCUT_OPTION',
  'INVALID_TARGET', 'INVALID_TARGET_INVENTORY', 'INVALID_TARGET_LANGUAGE', 'ISOLATED_WORLD', 'ISOLATED_WORLD_REQUIRED',
  'LAUNCH_FAILED', 'LEASE_ENDED', 'LISTENER_CHECK_UNAVAILABLE', 'LISTENER_INSPECTION_UNAVAILABLE', 'LOADED_DOCUMENT_HASH_MISMATCH',
  'LOADED_RENDERER_HASH_MISMATCH', 'LOADED_RENDERER_NOT_UNIQUE', 'LOGIN_UNAVAILABLE', 'MAIN_CONTEXT_REQUIRED', 'MESSAGE_NAVIGATION_BUILD_MISMATCH',
  'MESSAGE_NAVIGATION_INSPECTION_UNAVAILABLE', 'MESSAGE_NAVIGATION_SCRIPT_NOT_UNIQUE', 'MESSAGE_NAVIGATION_UNVERIFIED', 'MESSAGE_PAGE_INACTIVE', 'MESSAGE_PAGE_REQUIRED',
  'NATIVE_CAS_FAILED', 'NATIVE_CREATE_FAILED', 'NATIVE_EVENTS_UNVERIFIED', 'NATIVE_FACTORY_MISSING', 'NATIVE_LEASE_ENDED',
  'NATIVE_NOT_READY', 'NATIVE_OPTIONS_FAILED', 'NATIVE_POLL_FAILED', 'OPERATOR_HTTPS_REQUIRED', 'ORDER_ENTRY_STALE',
  'ORDER_PERMISSION_REQUIRED', 'ORDER_QUERY_FAILED', 'ORDER_RESPONSE_INVALID', 'ORDER_WINDOW_STATE_SAVE_FAILED', 'OUTBOUND_ECHO_MISMATCH',
  'OWNED_AUTH_DISCONNECTED', 'OWNED_AUTH_DISPOSED', 'OWNED_AUTH_ENTRY_REQUIRED', 'OWNED_AUTH_EXITED', 'OWNED_AUTH_IPC_FAILED',
  'OWNED_AUTH_PROCESS_ERROR', 'OWNED_AUTH_READY_TIMEOUT', 'OWNED_AUTH_REQUEST_TIMEOUT', 'OWNED_AUTH_START_FAILED', 'OWNED_AUTH_UNAVAILABLE',
  'OWNED_FRAME_BOUNDARY_FAILED', 'OWNED_LOGIN_OPENER_REQUIRED', 'OWNED_LOGIN_OPEN_FAILED', 'OWN_LOG_UNAVAILABLE', 'PAGE_ENABLE',
  'PORT_RESERVATION_FAILED', 'POST_LAUNCH_PROCESS_CHECK_FAILED', 'PREVIEW_STALE', 'PROCESS_CHANGED', 'PROCESS_CHECK_UNAVAILABLE',
  'PROCESS_IDENTITY_UNAVAILABLE', 'PROCESS_INSPECTION_FAILED', 'PROCESS_INSPECTION_INVALID_JSON', 'PROCESS_INSPECTION_INVALID_STATE', 'PROFILE_UNVERIFIED',
  'PSIM_LOGIN_REQUIRED', 'RATE_LIMITED', 'REATTACH_PROCESS_MISMATCH', 'REQUEST_ABORTED', 'REVIEW_EXPIRED',
  'RUNTIME_ARTIFACT_NOT_BUILT', 'RUNTIME_ASSISTANCE_FAILED', 'RUNTIME_DETACH_FAILED', 'RUNTIME_ENABLE', 'RUNTIME_FACTORY_MISSING',
  'RUNTIME_INSTALL_FAILED', 'RUNTIME_LEASE_ENDED', 'RUNTIME_MOUNT_FAILED', 'RUNTIME_NOT_MOUNTED', 'RUNTIME_TARGET_CHANGED',
  'SCRIPT_DISCOVERY', 'SCRIPT_LISTEN', 'SCRIPT_SOURCE', 'SERVICE_DISCONNECTED', 'SERVICE_UNAVAILABLE',
  'SESSION_ALREADY_ATTACHED', 'SESSION_CHANGED', 'SESSION_DETACHED', 'SESSION_REQUIRED', 'SETTINGS_LOAD_FAILED',
  'SHELL_START_FAILED', 'STALE_AUTH_IDENTITY', 'TARGET_CHANGED', 'TARGET_DESTROYED', 'TARGET_DISCOVERY_UNAVAILABLE',
  'TARGET_REQUIRED', 'TARGET_URL_CHANGED', 'TRANSLATION_PERMISSION_REQUIRED', 'TRANSPORT_DISCONNECTED', 'TSIM_OPERATOR_BASIC_READY',
  'TSIM_OPERATOR_BOUNDS', 'TSIM_OPERATOR_CLOSE', 'TSIM_OPERATOR_FOCUS', 'TSIM_OPERATOR_LOADED', 'TSIM_OPERATOR_NEEDS_LOGIN',
  'TSIM_OPERATOR_QUERY_TERMINAL', 'TSIM_OPERATOR_READY', 'UI_STATE_FAILED', 'UNAPPROVED_LAUNCH', 'UNAPPROVED_NATIVE_ARTIFACT',
  'UNAPPROVED_RUNTIME_ARTIFACT', 'UNAPPROVED_RUNTIME_OPTIONS', 'UNAUTHORIZED_RENDERER', 'UNCLASSIFIED', 'UNOWNED_DEBUG_LISTENER',
  'UNSPECIFIED', 'UNVERIFIED_BUILD', 'UNVERIFIED_DEBUG_ENDPOINT', 'UNVERIFIED_EXECUTABLE', 'UNVERIFIED_MAIN_FRAME',
  'UNVERIFIED_POLICY_TARGET', 'UNVERIFIED_PROCESS', 'UNVERIFIED_RUNTIME_TARGET', 'USER_CANCELLED', 'USER_START_REQUIRED',
  'USE_EMBEDDED_ORDER_PANEL', 'VERIFY_FRAME', 'WINDOWS_REQUIRED', 'WORKBENCH_ALREADY_MOUNTED', 'WRITE_UNAVAILABLE',
  'WRONG_RUNTIME_TARGET',
]);
for (const code of ['ORDER_READY', 'ORDER_UNAVAILABLE', 'ORDER_INSPECTION_FAILED', 'BOOTSTRAP_HELPER_EXITED', 'BOOTSTRAP_PROGRESS_UNAVAILABLE', 'BOOTSTRAP_CONNECTION_FAILED', 'CDP_COMMAND_TIMEOUT']) DIAGNOSTIC_CODES.add(code);
for (const code of ['INVALID_WINDOWS_PAGE_MANIFEST','INVALID_WINDOWS_RUNTIME_MANIFEST','UNSUPPORTED_WINDOWS_PAGE_STRUCTURE','UNSUPPORTED_WINDOWS_PAGE_VERSION','UNSUPPORTED_WINDOWS_RENDERER_CONTRACT','WINDOWS_INSTALLATION_PATH_REJECTED','WINDOWS_INSTALLED_HELPER_REQUIRED','WINDOWS_MANIFEST_EXECUTABLE_MISMATCH','WINDOWS_PACKAGE_VERSION_MISMATCH','UNSUPPORTED_WINDOWS_BUNDLED_BUILD','UNSUPPORTED_WINDOWS_HOT_UPDATE','VERIFIED_FILES_REQUIRED','WINDOWS_APPDATA_UNAVAILABLE','WINDOWS_MANIFEST_NOT_PROTECTED','WINDOWS_RESOURCE_CHANGED_DURING_READ','WINDOWS_RESOURCE_ENCODING_REJECTED','WINDOWS_RESOURCE_PATH_REJECTED','WINDOWS_RESOURCE_REDIRECTION','WINDOWS_RESOURCE_SIZE_REJECTED','VENDOR_OWNER_EXITED','VENDOR_OWNER_CHANGED','VENDOR_OWNER_INSPECTION_FAILED','INVALID_VENDOR_OWNER','INSTALLED_VENDOR_OWNER_REQUIRED']) DIAGNOSTIC_CODES.add(code);
for (const code of [...DIAGNOSTIC_CODES]) for (const prefix of ['NATIVE_EVENT_', 'ACTIVE_TARGET_']) DIAGNOSTIC_CODES.add(prefix + code);
const CDP_METHODS = new Set(['Target.getTargets', 'Target.attachToTarget', 'Target.detachFromTarget', 'Target.getTargetInfo', 'Page.enable', 'Page.getFrameTree', 'Page.getResourceContent', 'Page.createIsolatedWorld', 'Runtime.enable', 'Runtime.addBinding', 'Runtime.removeBinding', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup', 'Debugger.enable', 'Debugger.disable', 'Debugger.getScriptSource', 'DOMDebugger.getEventListeners', 'DOM.describeNode']);
const DIAGNOSTIC_STAGES = new Set([...HELPER_STAGES, 'launching', 'complete', 'CONNECT_COMPOSER', 'CONNECT_SESSION', 'INITIALIZE', 'STARTUP', 'SHUTDOWN', 'SHELL_START_FAILED', 'PROCESS_CHECK_FAILED']);
const STATE_VALUES = {
  auth: new Set(['ready', 'needs_login', 'connecting', 'failed']),
  phase: new Set(['idle', 'reading', 'translating', 'ready', 'stale', 'failed', 'replaced', 'waiting', 'replacing']),
  composerSource: new Set(['uia', 'verified-editor', 'unavailable']),
  nativeStatus: new Set(['starting', 'available', 'helper_not_built', 'helper_diagnostic', 'helper_unavailable', 'helper_stopped', 'target_lost', 'windows_required']),
  orderStatus: new Set(['idle', 'loading', 'ready', 'failed', 'empty', 'unknown']),
};
// Mirrored from src/shared/runtime-telemetry.ts; parity tests guard this single-file boundary.
/** Literal diagnostic codes reviewed from the current runtime; unknown values never reach logs. */
const telemetryCodes=new Set(["ACTIVE_IM_TARGET_UNVERIFIED", "ALREADY_ATTACHED", "AMBIGUOUS_CLIENT_WINDOW", "AMBIGUOUS_IM_TARGET", "AMBIGUOUS_LISTENER", "AUTH_CHANGED", "BOOTSTRAP_NATIVE_LEASE_ENDED", "BROWSER_ADOPTION_FAILED", "BROWSER_BOOTSTRAP_UNAVAILABLE", "BROWSER_BRIDGE_BUSY", "BROWSER_BRIDGE_DIRECTORY_DENIED", "BROWSER_BRIDGE_DISPOSED", "BROWSER_BRIDGE_TIMEOUT", "BROWSER_BRIDGE_UNAVAILABLE", "BROWSER_CLEANUP_UNCONFIRMED", "BROWSER_LOGIN_OPENER_REQUIRED", "BROWSER_PLACEMENT_FAILED", "BROWSER_PROFILE_REQUIRED", "BROWSER_SESSION_DISABLED", "BROWSER_SESSION_DISPOSED", "BROWSER_SESSION_STORAGE_INVALID", "BROWSER_SESSION_TIMEOUT", "BROWSER_SPACE_TOO_SMALL", "CDP_COMMAND_REJECTED", "CDP_CONNECT_FAILED", "CDP_CONNECT_TIMEOUT", "CDP_DISCONNECTED", "CLIENT_WINDOW_NOT_FOUND", "COMPOSER_GEOMETRY_UNAVAILABLE", "COMPOSER_NOT_PLAIN_TEXT", "COMPOSER_PUBLIC_API_UNVERIFIED", "COMPOSER_SOURCE_UNVERIFIED", "COMPOSER_UNAVAILABLE", "CONNECTION_SUPERSEDED", "CONVERSATION_SOURCE_UNVERIFIED", "DEBUGGER_ENABLE", "DEBUG_ENDPOINT_INVALID", "DEBUG_ENDPOINT_TIMEOUT", "DEBUG_ENDPOINT_UNAVAILABLE", "DEBUG_LISTENER_NOT_AVAILABLE", "DEBUG_PORT_REQUIRED", "DISPLAY_UNAVAILABLE", "DRAFT_CHANGED", "DRAFT_COMPARE_AND_SWAP_FAILED", "DRAFT_FOCUS_REJECTED", "DRAFT_READBACK_MISMATCH", "DRAFT_UPDATE_NOT_OBSERVED", "DRAFT_WRITE_REJECTED", "EDGE_NOT_INSTALLED", "EDITOR_ARTIFACT_NOT_BUILT", "EMPTY_DRAFT", "EMPTY_TRANSLATION", "EXISTING_CLIENT_DEBUG_PORT_REQUIRED", "EXISTING_CLIENT_OR_INSTALLER", "FACTORY_NOT_READY", "FINGERPRINT_FILE_CHANGED", "FINGERPRINT_FILE_UNVERIFIED", "FORBIDDEN_CDP_METHOD", "FORBIDDEN_SERVICE_REQUEST", "FRAME_TREE", "HELPER_CLEANUP_FAILED", "HTML_RESOURCE", "IM_TARGET_INACTIVE", "IM_TARGET_LIMIT", "IM_TARGET_NOT_READY", "INPUT_COMPOSING", "INSPECT_NAV", "INVALID_ACTION", "INVALID_APPLY_MODE", "INVALID_ARGUMENTS", "INVALID_AUTH_GENERATION", "INVALID_AUTH_IDENTITY", "INVALID_BROWSER_LEASE", "INVALID_BROWSER_MESSAGE", "INVALID_BROWSER_SESSION", "INVALID_BROWSER_WINDOW", "INVALID_CONTEXT", "INVALID_DEBUG_PORT", "INVALID_INTERACTION_OPTIONS", "INVALID_LANGUAGE", "INVALID_LOOPBACK_RESERVATION", "INVALID_NATIVE_BINDING", "INVALID_NATIVE_LEASE", "INVALID_OPERATOR_URL", "INVALID_OPTIONS", "INVALID_ORDER_IDENTIFIER", "INVALID_ORDER_PROJECTION", "INVALID_OUTBOUND_REQUEST", "INVALID_OWNED_BINDING", "INVALID_OWNED_GEOMETRY", "INVALID_OWNED_LOGIN_URL", "INVALID_OWNED_MESSAGE", "INVALID_OWNED_READY", "INVALID_OWNED_RESPONSE", "INVALID_PID", "INVALID_REATTACH_ARGUMENTS", "INVALID_SCRIPT_ID", "INVALID_SERVICE_RESPONSE", "INVALID_SESSION", "INVALID_SHORTCUT_OPTION", "INVALID_TARGET", "INVALID_TARGET_INVENTORY", "INVALID_TARGET_LANGUAGE", "ISOLATED_WORLD", "ISOLATED_WORLD_REQUIRED", "LAUNCH_FAILED", "LEASE_ENDED", "LISTENER_CHECK_UNAVAILABLE", "LISTENER_INSPECTION_UNAVAILABLE", "LOADED_DOCUMENT_HASH_MISMATCH", "LOADED_RENDERER_HASH_MISMATCH", "LOADED_RENDERER_NOT_UNIQUE", "LOGIN_UNAVAILABLE", "MAIN_CONTEXT_REQUIRED", "MESSAGE_NAVIGATION_BUILD_MISMATCH", "MESSAGE_NAVIGATION_INSPECTION_UNAVAILABLE", "MESSAGE_NAVIGATION_SCRIPT_NOT_UNIQUE", "MESSAGE_NAVIGATION_UNVERIFIED", "MESSAGE_PAGE_INACTIVE", "MESSAGE_PAGE_REQUIRED", "NATIVE_CAS_FAILED", "NATIVE_CREATE_FAILED", "NATIVE_EVENTS_UNVERIFIED", "NATIVE_FACTORY_MISSING", "NATIVE_LEASE_ENDED", "NATIVE_NOT_READY", "NATIVE_OPTIONS_FAILED", "NATIVE_POLL_FAILED", "OPERATOR_HTTPS_REQUIRED", "ORDER_ENTRY_STALE", "ORDER_PERMISSION_REQUIRED", "ORDER_QUERY_FAILED", "ORDER_RESPONSE_INVALID", "ORDER_WINDOW_STATE_SAVE_FAILED", "OUTBOUND_ECHO_MISMATCH", "OWNED_AUTH_DISCONNECTED", "OWNED_AUTH_DISPOSED", "OWNED_AUTH_ENTRY_REQUIRED", "OWNED_AUTH_EXITED", "OWNED_AUTH_IPC_FAILED", "OWNED_AUTH_PROCESS_ERROR", "OWNED_AUTH_READY_TIMEOUT", "OWNED_AUTH_REQUEST_TIMEOUT", "OWNED_AUTH_START_FAILED", "OWNED_AUTH_UNAVAILABLE", "OWNED_FRAME_BOUNDARY_FAILED", "OWNED_LOGIN_OPENER_REQUIRED", "OWNED_LOGIN_OPEN_FAILED", "OWN_LOG_UNAVAILABLE", "PAGE_ENABLE", "PORT_RESERVATION_FAILED", "POST_LAUNCH_PROCESS_CHECK_FAILED", "PREVIEW_STALE", "PROCESS_CHANGED", "PROCESS_CHECK_UNAVAILABLE", "PROCESS_IDENTITY_UNAVAILABLE", "PROCESS_INSPECTION_FAILED", "PROCESS_INSPECTION_INVALID_JSON", "PROCESS_INSPECTION_INVALID_STATE", "PROFILE_UNVERIFIED", "PSIM_LOGIN_REQUIRED", "RATE_LIMITED", "REATTACH_PROCESS_MISMATCH", "REQUEST_ABORTED", "REVIEW_EXPIRED", "RUNTIME_ARTIFACT_NOT_BUILT", "RUNTIME_ASSISTANCE_FAILED", "RUNTIME_DETACH_FAILED", "RUNTIME_ENABLE", "RUNTIME_FACTORY_MISSING", "RUNTIME_INSTALL_FAILED", "RUNTIME_LEASE_ENDED", "RUNTIME_MOUNT_FAILED", "RUNTIME_NOT_MOUNTED", "RUNTIME_TARGET_CHANGED", "SCRIPT_DISCOVERY", "SCRIPT_LISTEN", "SCRIPT_SOURCE", "SERVICE_DISCONNECTED", "SERVICE_UNAVAILABLE", "SESSION_ALREADY_ATTACHED", "SESSION_CHANGED", "SESSION_DETACHED", "SESSION_REQUIRED", "SETTINGS_LOAD_FAILED", "SHELL_START_FAILED", "STALE_AUTH_IDENTITY", "TARGET_CHANGED", "TARGET_DESTROYED", "TARGET_DISCOVERY_UNAVAILABLE", "TARGET_REQUIRED", "TARGET_URL_CHANGED", "TRANSLATION_PERMISSION_REQUIRED", "TRANSPORT_DISCONNECTED", "TSIM_OPERATOR_BASIC_READY", "TSIM_OPERATOR_BOUNDS", "TSIM_OPERATOR_CLOSE", "TSIM_OPERATOR_FOCUS", "TSIM_OPERATOR_LOADED", "TSIM_OPERATOR_NEEDS_LOGIN", "TSIM_OPERATOR_QUERY_TERMINAL", "TSIM_OPERATOR_READY", "UI_STATE_FAILED", "UNAPPROVED_LAUNCH", "UNAPPROVED_NATIVE_ARTIFACT", "UNAPPROVED_RUNTIME_ARTIFACT", "UNAPPROVED_RUNTIME_OPTIONS", "UNAUTHORIZED_RENDERER", "UNCLASSIFIED", "UNOWNED_DEBUG_LISTENER", "UNSPECIFIED", "UNVERIFIED_BUILD", "UNVERIFIED_DEBUG_ENDPOINT", "UNVERIFIED_EXECUTABLE", "UNVERIFIED_MAIN_FRAME", "UNVERIFIED_POLICY_TARGET", "UNVERIFIED_PROCESS", "UNVERIFIED_RUNTIME_TARGET", "USER_CANCELLED", "USER_START_REQUIRED", "USE_EMBEDDED_ORDER_PANEL", "VERIFY_FRAME", "WINDOWS_REQUIRED", "WORKBENCH_ALREADY_MOUNTED", "WRITE_UNAVAILABLE", "WRONG_RUNTIME_TARGET"]);
for(const value of ['INVALID_WINDOWS_PAGE_MANIFEST','INVALID_WINDOWS_RUNTIME_MANIFEST','UNSUPPORTED_WINDOWS_PAGE_STRUCTURE','UNSUPPORTED_WINDOWS_PAGE_VERSION','UNSUPPORTED_WINDOWS_RENDERER_CONTRACT','WINDOWS_INSTALLATION_PATH_REJECTED','WINDOWS_INSTALLED_HELPER_REQUIRED','WINDOWS_MANIFEST_EXECUTABLE_MISMATCH','WINDOWS_PACKAGE_VERSION_MISMATCH','UNSUPPORTED_WINDOWS_BUNDLED_BUILD','UNSUPPORTED_WINDOWS_HOT_UPDATE','VERIFIED_FILES_REQUIRED','WINDOWS_APPDATA_UNAVAILABLE','WINDOWS_MANIFEST_NOT_PROTECTED','WINDOWS_RESOURCE_CHANGED_DURING_READ','WINDOWS_RESOURCE_ENCODING_REJECTED','WINDOWS_RESOURCE_PATH_REJECTED','WINDOWS_RESOURCE_REDIRECTION','WINDOWS_RESOURCE_SIZE_REJECTED','VENDOR_OWNER_EXITED','VENDOR_OWNER_CHANGED','VENDOR_OWNER_INSPECTION_FAILED','INVALID_VENDOR_OWNER','INSTALLED_VENDOR_OWNER_REQUIRED'])telemetryCodes.add(value);

const EVENTS = /* @__PURE__ */ new Set(["translation-summary", "translation-action", "session-check", "runtime-health", "translation-statistics", "runtime-environment"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-zA-Z0-9.-]{1,40})?$/;
const NUMBER_FIELDS = new Set("elapsedMs replaceMs sendMs sourceChars targetChars configuredWaitMs actualWaitMs schedulerDelayMs inFlightWaitMs authMs authChecks authHttpCount authHttpMs authGeneration inputRevision contextRevision httpMs headersMs bodyMs parseMs requestBytes responseBytes contentLength httpStatus timeoutMs failedElapsedMs captureBeforeMs captureAfterMs editorLockMs postAuthMs postReadTokenMs previewPublishMs responseToPreviewMs userWaitMs attempt headerRetryAfterMs providerRetryAfterMs pid uptimeMs rssBytes heapUsedBytes heapTotalBytes eventLoopDelayMs logRetained logEvicted connectionEpoch reconnectCount windowMs requests successCount failureCount timeoutCount rateLimitedCount cancelledCount supersededCount httpP50Ms httpP95Ms httpMaxMs userP50Ms userP95Ms userMaxMs authTokenReadMs authTokenReads authHeadersMs authBodyMs authParseMs authFailedElapsedMs authHttpStatus".split(" "));
const NULLABLE_NUMBER_FIELDS = new Set(["providerMs", "providerQueueMs"]);
const NULLABLE_INTEGER_FIELDS = new Set(["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"]);
const INTEGER_FIELDS = /* @__PURE__ */ new Set(["httpSampleCount", "userSampleCount", "upstreamCalls", "upstreamCallsCompleted"]);
const BOOLEAN_FIELDS = new Set("translationSent previewShown readbackMatched sendTriggered sendConfirmed foreground composing plainText retryable usageComplete".split(" "));
const LANGUAGES = ["zh", "en", "ja", "ko", "es", "fr", "de", "ru", "pt", "it", "ar", "th", "vi", "id", "ms", "zh-TW", "tr", "unknown"];
const ENUMS = {
  inputTimingSource: ["native-event", "capture", "manual"],
  httpMethod: ["POST", "GET"],
  httpRoute: ["/agent/translate", "/agent/translate/batch", "/agent/profile", "/agent/auth/refresh"],
  contentType: ["application/json", "other"],
  operation: ["translate", "replace", "send"],
  trigger: ["automatic", "manual", "enter"],
  outcome: ["shown", "replaced", "send-triggered", "send-unconfirmed", "cancelled", "superseded", "failed", "rate-limited", "skipped", "success"],
  reason: ["empty", "empty-draft", "empty-translation", "not-ready", "busy", "paused", "unchanged", "stale", "superseded", "aborted", "cancelled", "auth-changed", "login-required", "permission-required", "context-changed", "draft-changed", "composing", "not-plain-text", "unavailable", "timeout", "network", "invalid-response", "rate-limited", "request-failed", "not-foreground", "closed", "unknown"],
  sourceLanguage: LANGUAGES,
  targetLanguage: LANGUAGES,
  targetSource: ["manual", "recognized", "fallback", "unavailable"],
  authCheckMode: ["fresh", "joined", "reused", "owned"],
  authStateBefore: ["ready", "needs_login", "connecting", "failed"],
  authStateAfter: ["ready", "needs_login", "connecting", "failed"],
  sessionMode: ["browser", "owned"],
  httpFailurePhase: ["request", "headers", "body", "parse", "validation", "auth"],
  authHttpFailurePhase: ["request", "headers", "body", "parse", "validation", "auth"],
  providerReported: ["deepl", "deepseek", "openai", "google", "google_nmt", "anthropic", "azure", "tencent", "baidu", "unknown"],
  translationProfile: ["customer_reading", "agent_draft", "sent_reading", "generic"],
  translationProtocol: ["agent-translation-items-v1"],
  usageAttribution: ["request_owned_calls"],
  cacheSource: ["unknown", "upstream", "memory_cache", "shared_cache", "singleflight", "mixed", "none"],
  platform: ["win32", "darwin"],
  arch: ["arm64", "x64"]
};
function sanitizeTelemetry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return;
  }
  const event = descriptors.event?.value;
  if (typeof event !== "string" || !EVENTS.has(event)) return;
  const result = { event };
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, "value")) continue;
    const item = descriptor.value;
    if (key === "diagnosticsVersion") { if (item === 1) result[key] = item; continue; }
    if (NULLABLE_NUMBER_FIELDS.has(key) || key === "serverMs") {
      if (item === null || typeof item === "number" && Number.isFinite(item) && item >= 0) result[key] = item;
      continue;
    }
    if (NULLABLE_INTEGER_FIELDS.has(key)) {
      if (item === null || typeof item === "number" && Number.isSafeInteger(item) && item >= 0) result[key] = item;
      continue;
    }
    if (INTEGER_FIELDS.has(key)) {
      if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) result[key] = item;
      continue;
    }
    if (NUMBER_FIELDS.has(key)) {
      if (typeof item === "number" && Number.isFinite(item) && item >= 0) result[key] = item;
      continue;
    }
    if (BOOLEAN_FIELDS.has(key)) {
      if (typeof item === "boolean") result[key] = item;
      continue;
    }
    if (Object.hasOwn(ENUMS, key)) {
      if (typeof item === "string" && ENUMS[key].includes(item)) result[key] = item;
      continue;
    }
    if (typeof item !== "string") continue;
    if (['operationStartedAt', 'requestStartedAt', 'responseHeadersAt', 'responseCompletedAt'].includes(key) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item))) {
      result[key] = item;
      continue;
    }
    if (key === "code") {
      result.code = ["REQUEST_SUPERSEDED", "SERVICE_RESPONSE_TOO_LARGE", "OWNED_SERVICE_CLOSED", "SESSION_STORAGE_CORRUPT", "PSIM_SESSION_LOAD_FAILED", "PSIM_SESSION_SAVE_FAILED", "PSIM_SESSION_CLEAR_FAILED", "INVALID_STORED_SESSION", "LOGIN_RESPONSE_INVALID", "REFRESH_RESPONSE_INVALID", "SESSION_STORAGE_ENCRYPTION_UNAVAILABLE", "BROWSER_SESSION_ACCESS_DENIED"].includes(item) || /^PSIM_HTTP_(?:401|403|422|423|429|500|502|503|504)$/.test(item) ? item : (telemetryCodes.has(item)||['NATIVE_EVENT_','ACTIVE_TARGET_'].some(prefix=>item.startsWith(prefix)&&telemetryCodes.has(item.slice(prefix.length)))?item:'UNCLASSIFIED');
      continue;
    }
    if ((key === "traceId" || key === "parentTraceId" || key === "serverRequestId") && UUID.test(item) || key === "runId" && /^(?:[a-f0-9]{16}|[a-f0-9]{32})$/.test(item) || key === "policyVersion" && /^20\d{2}-\d{2}-\d{2}\.\d{1,4}$/.test(item) || (key === "appVersion" || key === "injectorVersion" || key === "electronVersion" || key === "nodeVersion") && SEMVER.test(item) || key === "osRelease" && /^\d{1,5}(?:\.\d{1,5}){1,3}$/.test(item)) result[key] = item;
  }
  return result;
}

function sanitizeDiagnostic(value) {
  const telemetry=sanitizeTelemetry(value);
  if(telemetry){const at=Object.getOwnPropertyDescriptor(value,'at')?.value;if(typeof at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)||!Number.isFinite(Date.parse(at)))return;return {at,...telemetry};}
  if (!value || typeof value !== 'object' || Array.isArray(value) || !DIAGNOSTIC_EVENTS.has(value.event)) return undefined;
  if (typeof value.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.at) || !Number.isFinite(Date.parse(value.at))) return undefined;
  const entry = {at: value.at, event: value.event};
  if (DIAGNOSTIC_CODES.has(value.code)) entry.code = value.code;
  if (DIAGNOSTIC_STAGES.has(value.stage) || DIAGNOSTIC_CODES.has(value.stage)) entry.stage = value.stage;
  if (CDP_METHODS.has(value.method)) entry.method = value.method;
  for (const key of ['elapsedMs', 'timeoutMs', 'pid', 'ownerPid']) if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 2147483647) entry[key] = value[key];
  if (Number.isSafeInteger(value.errorCode) && Math.abs(value.errorCode) <= 2147483647) entry.errorCode = value.errorCode;
  if (['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AggregateError', 'AbortError', 'Unknown'].includes(value.errorType)) entry.errorType = value.errorType;
  if (Array.isArray(value.locations)) entry.locations = value.locations.filter(item => typeof item === 'string' && item.length <= 120 && /^(?:main\.cjs|external-composer\.ts|companion-service\.ts|driver\.ts|transport\.ts):\d{1,8}:\d{1,8}$/.test(item)).slice(0, 4);
  for (const key of ['attached', 'hasPreview', 'hasError']) if (typeof value[key] === 'boolean') entry[key] = value[key];
  for (const [key, allowed] of Object.entries(STATE_VALUES)) if (allowed.has(value[key])) entry[key] = value[key];
  return entry;
}
function recoveryAdvice(code, stage) {
  if (stage === 'exited' || code === 'BOOTSTRAP_HELPER_EXITED') return '请完全退出并重新打开客户端；仍失败时查看运行日志';
  if (['MESSAGE_PAGE_INACTIVE', 'MESSAGE_PAGE_REQUIRED', 'COMPOSER_UNAVAILABLE', 'IM_TARGET_NOT_READY', 'CLIENT_WINDOW_NOT_FOUND'].includes(code)) return '请打开客服页并选择一个客户会话，保持窗口可见';
  if (/HASH|FINGERPRINT|UNVERIFIED_BUILD|ARTIFACT/.test(code)) return '请通过安装器更新助手；仍失败时完全退出并重新打开客户端';
  if (/LOGIN|AUTH|SESSION_REQUIRED/.test(code)) return '请在助手中检查登录状态，再完全退出并重新打开客户端';
  if (['launching', 'host-ready', 'start', 'files-verified', 'transport-ready'].includes(stage)) return '请保持客服窗口打开；仍失败时完全退出并重新打开客户端';
  return '请打开客户会话并保持窗口可见；仍失败时完全退出并重新打开客户端';
}
function loadingView(stage, context = {}) {
  const logs = context.logs || [], lastStage = context.lastStage || 'launching';
  const common = {logs, step: 0, total: LOADING_TOTAL};
  const step = LOADING_STEPS[stage];
  if (step) return {...common, tone: 'busy', title: '翻译助手加载中', label: step[1], step: step[0]};
  if ((stage === 'panel-mounted' || stage === 'hidden') && !context.errorCode) return {...common, tone: 'busy', title: '翻译助手正在恢复', label: '正在重新连接客服页面'};
  const code = context.errorCode || (stage === 'exited' ? 'BOOTSTRAP_HELPER_EXITED' : 'BOOTSTRAP_CONNECTION_FAILED');
  const recent = LOADING_STEPS[lastStage]?.[1] || (lastStage === 'panel-mounted' ? '翻译面板已挂载' : '启动助手进程');
  return {...common, tone: stage === 'exited' ? 'bad' : 'warn', title: stage === 'exited' ? '翻译助手未运行' : '翻译助手连接失败', label: '最近阶段：' + recent + ' · ' + code + ' · ' + recoveryAdvice(code, stage === 'exited' ? stage : lastStage), code};
}
/**
 * Serialized into the vendor document's isolated world. Self-contained: it may use only its
 * arguments and DOM globals. It sits exactly where the outbound panel will attach and yields
 * as soon as that panel exists, so the composer does not jump when loading finishes.
 */
function companionLoadingIndicator(view, doc) {
  doc = doc || document;
  const win = doc.defaultView, KEY = '__tsimCompanionLoading';
  let ui = win[KEY];
  if (!ui) {
    const host = doc.createElement('div');
    host.id = 'tsim-companion-loading'; host.setAttribute('data-tsim-owned', '1'); host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite');
    const root = host.attachShadow({mode: 'closed'});
    const styles = '<style>:host{all:initial;display:block;width:100%;box-sizing:border-box;font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI","Microsoft YaHei",sans-serif;color:#1d2433}*{box-sizing:border-box}'
      + '.bar{position:relative;display:flex;align-items:center;gap:8px;min-height:36px;padding:5px 12px;background:#f6f7fa;border-top:1px solid #e3e7ee}.mark{width:12px;height:12px;flex:none;border-radius:50%;border:2px solid #d5dbf6;border-top-color:#3a5bd9;animation:spin .8s linear infinite}'
      + '.title{font-weight:600;font-size:12.5px;white-space:nowrap}.label{font-size:12px;color:#4b5568;min-width:0;overflow-wrap:anywhere}.step{font-size:11px;padding:0 5px;border-radius:4px;background:#eef1fd;color:#3a5bd9;flex:none}.spacer{flex:1}.elapsed{font-size:11px;color:#8a93a6;white-space:nowrap}'
      + 'button{font:inherit;cursor:pointer;border:1px solid #d7dce5;border-radius:5px;background:#fff;color:#1d2433;padding:4px 8px}button:focus-visible,textarea:focus-visible{outline:2px solid #3a5bd9;outline-offset:1px}.more{font-size:20px;line-height:20px;border:0;background:transparent;flex:none}.menu{padding:4px 12px;text-align:right;background:#f6f7fa}'
      + '.track{position:absolute;left:0;right:0;bottom:0;height:2px;background:#e3e7ee}.fill{display:block;height:100%;background:#3a5bd9;transition:width .4s ease}[data-tone="warn"] .mark,[data-tone="bad"] .mark{border:0;width:8px;height:8px;margin:0 2px;background:#b26a00;animation:none}[data-tone="bad"] .mark{background:#c2382f}[data-tone="warn"] .title{color:#b26a00}[data-tone="bad"] .title{color:#c2382f}[data-tone="warn"] .track,[data-tone="bad"] .track{display:none}'
      + '.overlay{position:fixed;inset:0;z-index:2147483647;background:#0006;display:grid;place-items:center;padding:20px}.dialog{width:min(900px,100%);max-height:90vh;background:white;padding:18px;border-radius:10px;box-shadow:0 12px 50px #0004;display:flex;flex-direction:column;gap:10px}.heading{font-size:16px;font-weight:600}.hint,.copy-status{font-size:12px;color:#4b5568}.logs{width:100%;height:55vh;min-height:120px;resize:vertical;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre;border:1px solid #d7dce5;border-radius:5px;padding:8px;color:#1d2433;background:#f8f9fb}.actions{display:flex;gap:8px;justify-content:flex-end}'
      + '@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:600px){.elapsed{display:none}.bar{flex-wrap:wrap}.label{order:2;flex-basis:100%}.dialog{padding:12px}.overlay{padding:10px}}@media(prefers-reduced-motion:reduce){.mark{animation:none}.fill{transition:none}}[hidden]{display:none!important}</style>';
    root.innerHTML = styles + '<div class="bar"><span class="mark" aria-hidden="true"></span><span class="title"></span><span class="label"></span><span class="step"></span><span class="spacer"></span><span class="elapsed"></span><button class="more" type="button" title="助手菜单" aria-label="助手菜单" aria-expanded="false">…</button><span class="track" aria-hidden="true"><span class="fill"></span></span></div><div class="menu" hidden><button class="open-logs" type="button">查看运行日志</button></div>';
    // The dialog has a separate owner so the normal panel may hide the bar without hiding logs.
    const dialogHost = doc.createElement('div'); dialogHost.id = 'tsim-companion-log-viewer'; dialogHost.setAttribute('data-tsim-owned', '1');
    const dialogRoot = dialogHost.attachShadow({mode: 'closed'});
    dialogRoot.innerHTML = styles + '<div class="overlay" hidden><section class="dialog" role="dialog" aria-modal="true" aria-label="翻译助手运行日志"><div class="heading">翻译助手运行日志</div><div class="hint">最近 1000 条本地诊断，不含客户正文或登录凭据。助手退出后仍可查看已有记录。</div><label><input class="raw" type="checkbox"> 原始字段</label><textarea class="logs" readonly aria-label="运行日志"></textarea><div class="copy-status" role="status"></div><div class="actions"><button class="copy" type="button">复制</button><button class="refresh" type="button">刷新</button><button class="close" type="button">关闭</button></div></section></div>';
    const part = name => root.querySelector('.' + name), logPart = name => dialogRoot.querySelector('.' + name);
    ui = win[KEY] = {host, dialogHost, root, dialogRoot, view, logs: [], bar: part('bar'), title: part('title'), label: part('label'), step: part('step'), elapsed: part('elapsed'), more: part('more'), menu: part('menu'), fill: part('fill'), overlay: logPart('overlay'), text: logPart('logs'), copyStatus: logPart('copy-status'), shownAt: 0, pending: undefined, clock: undefined, observer: undefined};
    for (const owner of [host, dialogHost]) for (const type of ['click', 'mousedown', 'pointerdown', 'keydown']) owner.addEventListener(type, event => event.stopPropagation());
    const titles={'translation-summary':'翻译摘要','translation-action':'翻译操作','session-check':'会话检查','runtime-health':'运行健康','translation-statistics':'翻译统计','runtime-environment':'运行环境'};
    const labels={diagnosticsVersion:'诊断协议版本',usageAttribution:'用量归属',providerQueueMs:'新建上游调用排队合计',upstreamCalls:'新建上游调用数',upstreamCallsCompleted:'完成上游调用数',inputTokens:'上游输入Token合计',outputTokens:'上游输出Token合计',cachedInputTokens:'上游缓存读取Token',cacheWriteTokens:'上游缓存写入Token',reasoningTokens:'上游推理Token',usageComplete:'Token用量完整',httpMs:'翻译请求 httpMs',providerMs:'上游传输耗时合计 providerMs',serverMs:'TSim处理耗时 serverMs',cacheSource:'结果来源',elapsedMs:'总耗时',userWaitMs:'用户等待',authMs:'会话检查',operation:'操作',outcome:'结果',code:'错误码',requests:'请求数',successCount:'成功数',failureCount:'失败数',sourceChars:'原文字数',targetChars:'译文字数'};
    const localized={request_owned_calls:'仅本请求新建调用',upstream:'新建上游调用',memory_cache:'进程缓存',shared_cache:'共享缓存',singleflight:'等待共享请求',mixed:'混合来源',none:'无结果来源',unknown:'未知',translate:'翻译',replace:'替换',send:'发送',shown:'已展示',replaced:'已替换',failed:'失败',success:'成功',cancelled:'已取消',superseded:'被新输入替代','rate-limited':'限流','send-triggered':'发送已触发','send-unconfirmed':'发送待确认',skipped:'已跳过'};
    ui.refresh = (force=false) => {
      if(force!==true&&dialogRoot.activeElement===ui.text&&ui.text.selectionStart!==ui.text.selectionEnd)return;
      const text=ui.logs.map(entry=>{
        if(logPart('raw').checked||!Object.hasOwn(titles,entry.event))return JSON.stringify(entry);
        const parts=[(entry.at?entry.at+' ':'')+titles[entry.event]];
        if(entry.traceId||entry.parentTraceId)parts.push('编号 '+(entry.traceId?entry.traceId.slice(0,8):'')+(entry.parentTraceId?' ← '+entry.parentTraceId.slice(0,8):''));
        for(const key of Object.keys(entry)){
          if(['event','at','traceId','parentTraceId'].includes(key))continue;
          const value=entry[key];parts.push((labels[key]||key)+'：'+(value===null?'未提供':typeof value==='boolean'?(value?'是':'否'):(localized[value]||value))+(typeof value==='number'&&key.endsWith('Ms')?' ms':''));
        }
        if(entry.event==='translation-summary')for(const key of ['providerMs','serverMs','cacheSource'])if(!Object.hasOwn(entry,key))parts.push(labels[key]+'：未提供');
        return parts.join(' · ');
      }).join('\n');
      const atEnd=ui.text.scrollHeight-ui.text.scrollTop-ui.text.clientHeight<24;
      if(ui.text.value!==text){ui.text.value=text;if(atEnd)ui.text.scrollTop=ui.text.scrollHeight;}
    };
    logPart('raw').addEventListener('change',()=>ui.refresh(true));
    ui.openLogs = () => {
      if (!dialogHost.isConnected) (doc.body || doc.documentElement).appendChild(dialogHost);
      ui.menu.hidden = true; ui.more.setAttribute('aria-expanded', 'false'); ui.overlay.hidden = false; ui.copyStatus.textContent = ''; ui.refresh(true); logPart('close').focus();
    };
    ui.more.addEventListener('click', () => { ui.menu.hidden = !ui.menu.hidden; ui.more.setAttribute('aria-expanded', String(!ui.menu.hidden)); });
    part('open-logs').addEventListener('click', ui.openLogs);
    logPart('refresh').addEventListener('click',()=>ui.refresh(true));
    logPart('close').addEventListener('click', () => { ui.overlay.hidden = true; if (ui.host.isConnected) ui.more.focus(); });
    logPart('copy').addEventListener('click', async () => {
      try { if (!win.navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE'); await win.navigator.clipboard.writeText(ui.text.value); ui.copyStatus.textContent = '已复制'; }
      catch { ui.text.focus(); ui.text.select(); ui.copyStatus.textContent = '自动复制失败，日志已选中，请按 Ctrl+C 复制'; }
    });
    ui.overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); logPart('close').click(); }
      if (event.key === 'Tab') {
        const items = [logPart('raw'), ui.text, logPart('copy'), logPart('refresh'), logPart('close')];
        if (!event.shiftKey && dialogRoot.activeElement === items[items.length-1]) { event.preventDefault(); items[0].focus(); }
        else if (event.shiftKey && dialogRoot.activeElement === items[0]) { event.preventDefault(); items[items.length-1].focus(); }
      }
    });
    // Read-only bridge, deliberately with no renderer payload or command forwarding.
    doc.addEventListener('tsim-companion-open-logs', event => { event.preventDefault(); ui.openLogs(); });
    const tick = () => { const seconds = Math.floor((Date.now() - ui.shownAt) / 1000); ui.elapsed.textContent = ui.view.tone === 'busy' && seconds >= 3 ? '已等待 ' + seconds + ' 秒' : ''; };
    ui.sync = () => {
      const area = doc.querySelector('.im_detail.inform-con > .chat_area'), input = area && area.querySelector('.chat_area-input');
      const show = !doc.getElementById('tsim-outbound-panel') && !!input?.parentNode;
      if (!show) { if (host.isConnected) host.remove(); win.clearInterval(ui.clock); ui.clock = undefined; ui.shownAt = 0; return; }
      if (host.parentNode !== input.parentNode || host.nextSibling !== input) input.parentNode.insertBefore(host, input);
      if (!ui.shownAt) ui.shownAt = Date.now();
      if (ui.clock === undefined) ui.clock = win.setInterval(tick, 1000);
      tick();
    };
    ui.observer = new win.MutationObserver(mutations => {
      if (mutations.every(mutation => [...mutation.addedNodes, ...mutation.removedNodes].every(node => node === host || node === dialogHost) && mutation.addedNodes.length + mutation.removedNodes.length > 0)) return;
      if (ui.pending === undefined) ui.pending = win.setTimeout(() => { ui.pending = undefined; ui.sync(); }, 100);
    });
    ui.observer.observe(doc.documentElement, {childList: true, subtree: true});
  }
  // Only the bootstrap sends this view; bound both retained data and rendered text independently.
  ui.logs = Array.isArray(view.logs) ? view.logs.slice(-1000) : [];
  ui.view = {...view, logs: ui.logs}; ui.bar.dataset.tone = view.tone; ui.title.textContent = view.title; ui.label.textContent = view.label;
  ui.step.textContent = view.step ? view.step + '/' + view.total : ''; ui.step.hidden = !view.step;
  ui.fill.style.width = view.step ? Math.round(view.step / view.total * 100) + '%' : '0';
  ui.host.setAttribute('aria-label', view.title + '：' + view.label);
  if (!ui.overlay.hidden) ui.refresh();
  ui.sync();
}
function installBootstrap({app, spawn, createServer = require('node:net').createServer, randomBytes = require('node:crypto').randomBytes, execPath = process.execPath, pid = process.pid, argv = process.argv, schedule = setTimeout, cancel = clearTimeout}) {
  // The vendor disables site-isolation trials and webSecurity. Without an
  // explicit isolated process, its renderer can read a sandboxed login iframe
  // and Chromium 118 omits Origin on its fetches. Force isolation before the
  // original main runs; this takes precedence over disabling isolation trials.
  app.commandLine.appendSwitch('site-per-process');
  // Port 0 lets the OS allocate a free, non-reserved port atomically. Random
  // guesses can land inside Windows excluded ranges or collide with a listener.
  const port = 0;
  // Electron initializes its DevTools server after executing the main entry.
  app.commandLine.removeSwitch('remote-debugging-port');
  app.commandLine.removeSwitch('remote-debugging-address');
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
  let child, childRunning = false, quitting = false, stage = 'launching', lastStage = 'launching', errorCode, retries = 0, retryTimer, stableTimer, diagnosticTimer;
  const diagnostics = [{at:new Date().toISOString(),event:'host-start',pid}];
  const appendDiagnostic = entry => {diagnostics.push(entry);if(diagnostics.length>MAX_DIAGNOSTICS)diagnostics.splice(0,diagnostics.length-MAX_DIAGNOSTICS);};
  const context = () => ({lastStage, errorCode, logs: diagnostics});
  const retryDelays = [1000, 3000, 10000];
  const cancelRetry = () => { if (retryTimer !== undefined) cancel(retryTimer); retryTimer = undefined; };
  const cancelStable = () => { if (stableTimer !== undefined) cancel(stableTimer); stableTimer = undefined; };
  // A helper is alive while our child runs or any helper holds a progress connection:
  // a running helper can adopt this vendor while our own child exits on its instance lock.
  const sockets = new Set();
  const helperGone = () => {
    if (quitting || childRunning || sockets.size !== 0 || retryTimer !== undefined) return;
    cancelStable();
    errorCode = errorCode || 'BOOTSTRAP_HELPER_EXITED';
    appendDiagnostic({at:new Date().toISOString(),event:'host-error',stage:'STARTUP',code:errorCode});
    if (retries >= retryDelays.length) { setStage('exited'); return; }
    setStage('failed');
    retryTimer = schedule(() => { retryTimer = undefined; if (quitting || childRunning || sockets.size !== 0) return; retries++; launchHelper(); }, retryDelays[retries]);
    retryTimer.unref?.();
  };
  // Startup progress: the helper reports fixed stage names over a private pipe;
  // the vendor document shows them where the outbound panel will appear.
  const documents = new Set();
  const paintings = new Map();
  const paint = contents => {
    let job;
    try {
      if (contents.isDestroyed() || !/^file:/i.test(contents.getURL())) return;
      const pending = paintings.get(contents);
      if (pending) {pending.dirty=true;return;}
      const code = `(${companionLoadingIndicator.toString()})(${JSON.stringify(loadingView(stage, context()))})`;
      job={dirty:false};paintings.set(contents,job);
      Promise.resolve(contents.executeJavaScriptInIsolatedWorld(LOADING_WORLD_ID, [{code}])).catch(() => {}).finally(()=>{
        if(paintings.get(contents)!==job)return;
        paintings.delete(contents);if(job.dirty&&!quitting&&!contents.isDestroyed())paint(contents);
      });
    } catch { if (job && paintings.get(contents) === job) paintings.delete(contents); /* A synchronous execution error must not leave a stuck in-flight job. */ }
  };
  const paintAll = () => { for (const contents of documents) paint(contents); };
  const recordDiagnostic = value => {
    const entry = sanitizeDiagnostic(value);
    if (!entry || quitting) return;
    appendDiagnostic(entry);
    if (entry.code && ['host-error', 'runtime-invalidated', 'companion-service-failed'].includes(entry.event)) errorCode = entry.code;
    else if (entry.event === 'cdp-command-timeout') errorCode = 'CDP_COMMAND_TIMEOUT';
    else if (entry.event === 'cdp-command-rejected') errorCode = 'CDP_COMMAND_REJECTED';
    // Diagnostic bursts repaint once per 500ms, regardless of record volume.
    if (diagnosticTimer === undefined) {
      diagnosticTimer = schedule(() => { diagnosticTimer = undefined; if (!quitting) paintAll(); }, 500);
      diagnosticTimer.unref?.();
    }
  };
  const setStage = next => {
    if (next === stage || quitting) return;
    stage = next;
    if(HELPER_STAGES.has(next)||next==='launching')appendDiagnostic({at:new Date().toISOString(),event:'composer-startup',stage:next});
    if (next !== 'failed' && next !== 'exited' && next !== 'hidden') lastStage = next;
    if (next === 'panel-mounted') errorCode = undefined;
    if (next !== 'panel-mounted') cancelStable();
    if (next === 'panel-mounted' && stableTimer === undefined) {
      stableTimer = schedule(() => { stableTimer = undefined; if (!quitting && (childRunning || sockets.size > 0)) retries = 0; }, 60000);
      stableTimer.unref?.();
    }
    paintAll();
  };
  app.on('web-contents-created', (_event, contents) => {
    documents.add(contents);
    contents.on('dom-ready', () => paint(contents));
    contents.once('destroyed', () => {documents.delete(contents);paintings.delete(contents);});
  });
  const progressPipe = `\\\\.\\pipe\\tsim-companion-progress-${pid}-${randomBytes(16).toString('hex')}`;
  let progress;
  try {
    progress = createServer(socket => {
      let buffered = '';
      sockets.add(socket);
      // A single-instance helper may adopt this owner before our retry fires.
      cancelRetry();
      socket.once('close', () => { sockets.delete(socket); helperGone(); });
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.on('data', chunk => {
        if (typeof chunk !== 'string') { socket.destroy(); return; }
        // Bound each unterminated fragment and complete line in bytes, including UTF-8.
        let offset = 0;
        while (offset < chunk.length) {
          const index = chunk.indexOf('\n', offset);
          const end = index < 0 ? chunk.length : index;
          const fragment = chunk.slice(offset, end);
          if (Buffer.byteLength(buffered, 'utf8') + Buffer.byteLength(fragment, 'utf8') > MAX_PROGRESS_LINE) { buffered = ''; socket.destroy(); return; }
          buffered += fragment;
          if (index < 0) return;
          const line = buffered; buffered = ''; offset = index + 1;
          try {
            const value = JSON.parse(line);
            if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) continue;
            if (HELPER_STAGES.has(value.stage)) setStage(value.stage);
            else if (Object.hasOwn(value, 'diagnostic')) recordDiagnostic(value.diagnostic);
          } catch { /* Ignore malformed progress. */ }
        }
      });
    });
    progress.on('error', () => { progress = undefined; errorCode = 'BOOTSTRAP_PROGRESS_UNAVAILABLE'; setStage('failed'); });
    progress.listen(progressPipe);
    progress.unref?.();
  } catch { progress = undefined; errorCode = 'BOOTSTRAP_PROGRESS_UNAVAILABLE'; stage = 'failed'; }
  app.once('before-quit', () => { quitting = true; cancelRetry(); cancelStable(); if (diagnosticTimer !== undefined) cancel(diagnosticTimer); diagnosticTimer = undefined; });
  app.once('will-quit', () => { try { child?.kill(); } catch { /* Owner watch also handles crashes. */ } try { progress?.close(); } catch { /* Already closed. */ } });
  const launchHelper = () => {
    // A rejected second vendor instance calls app.quit() in its original main.
    if (quitting || childRunning || sockets.size > 0) return;
    setStage(progress ? 'launching' : 'failed');
    const executable = path.join(path.dirname(execPath), 'resources', 'TripVendorCompanion', '旅游商家助手.exe');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ASAR;
    delete env.NODE_OPTIONS;
    // Windows PowerShell must construct its own classic module search path.
    // Inheriting PowerShell 7's PSModulePath can make Get-Acl/CIM modules unloadable.
    delete env.PSModulePath;
    // The helper discovers the sole listener owned by this exact process, then
    // performs its usual full identity/loopback/handshake checks before HTTP/CDP.
    try {
      const launched = spawn(executable, [`--vendor-owner=${pid}`, '--vendor-debug-port=auto', ...(progress ? [`--vendor-progress=${progressPipe}`] : [])], {shell:false, windowsHide:true, stdio:'ignore', env});
      child = launched; childRunning = true;
      let ended = false;
      const gone = () => { if (ended || child !== launched) return; ended = true; childRunning = false; helperGone(); };
      launched.on('error', gone); launched.on('exit', gone);
    } catch { childRunning = false; helperGone(); }
  };
  app.whenReady().then(launchHelper).catch(() => {});
  return {port, progressPipe: progress ? progressPipe : undefined, stage: () => stage};
}
// Startup preference, kept identical in macos-vendor-bootstrap.cjs: each vendor main window opens
// maximized once. Only its construction title identifies it; a later restore or resize is the user's.
// No show/hide/close, BrowserView or throttling behaviour of the official window is changed.
const VENDOR_MAIN_WINDOW_TITLE = 'Main window';
function maximizeMainWindowOnOpen(app, {defer = setImmediate} = {}) {
  const created = (_event, win) => {
    let title;
    try { title = win.getTitle(); } catch { return; }
    if (title !== VENDOR_MAIN_WINDOW_TITLE) return;
    const maximize = () => {
      try {
        if (win.isDestroyed() || win.isMaximized() || win.isFullScreen() || win.isMinimized() || !win.isMaximizable() || !win.isResizable()) return;
        win.maximize();
      } catch { /* A window preference never blocks the vendor. */ }
    };
    // Run after the vendor's constructor block so its resize listener sizes the attached BrowserView.
    defer(() => {
      try {
        if (win.isDestroyed()) return;
        // maximize() also shows a hidden window; a background start waits for the vendor's own first show.
        if (win.isVisible()) maximize(); else win.once('show', maximize);
      } catch { /* Same as above. */ }
    });
  };
  app.on('browser-window-created', created);
  return () => app.removeListener('browser-window-created', created);
}
module.exports = {installBootstrap, maximizeMainWindowOnOpen, companionLoadingIndicator, loadingView, sanitizeTelemetry, sanitizeDiagnostic, MAX_PROGRESS_LINE, MAX_DIAGNOSTICS, LOADING_WORLD_ID};
if (process.versions.electron && process.type === 'browser') {
  const {app} = require('electron');
  maximizeMainWindowOnOpen(app);
  installBootstrap({app, spawn:require('node:child_process').spawn});
  const config = require('./companion-vendor-original-main.json');
  if (!config || typeof config.main !== 'string' || !config.main || path.isAbsolute(config.main) || config.main.split(/[\\/]/).includes('..')) throw new Error('INVALID_VENDOR_ORIGINAL_MAIN');
  require(path.resolve(__dirname, config.main));
}
