import type { DesktopHostAPI, HostCommand, HostResponse, QueryRequest, QueryResult, Result, TranslationRequest } from '../src/shared/types';

export interface SiteSession { authenticated: boolean; accountScope: string | null; sessionRef: string | null; permissions: string[] }
export interface SiteBindings {
  /** Existing tsim_cs API client: its interceptors retain bearer credentials inside HTTPS site. */
  post(path: '/agent/translate' | '/agent/translate/batch', body: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  session(): SiteSession;
  subscribe(listener: () => void): () => void;
  validate(): Promise<void>;
  logout(): Promise<unknown>;
  navigateLogin(): void;
  /** Deployment gate, enabled only after backend write-denial acceptance for the restricted account. */
  operatorReadOnlyVerified: boolean;
}

const languages = new Set(['zh-CN', 'en', 'ja', 'ko', 'zh-TW', 'th', 'vi', 'id', 'es', 'fr', 'de']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failure = (code: string, message: string, retryable = false) => ({ ok: false as const, error: { code, message, retryable } });

export function validateTranslation(request: TranslationRequest): boolean {
  if (!request || !uuid.test(request.requestId) || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 20_000) return false;
  if (!languages.has(request.targetLanguage) || !(request.sourceLanguage === 'auto' || languages.has(request.sourceLanguage))) return false;
  if (!['inbound', 'outbound', 'sent_message_review'].includes(request.purpose)) return false;
  if (request.purpose === 'inbound') {
    const text = request.text.trim();
    if (request.sourceLanguage !== 'auto' || /^(?:data:|blob:|file:)/i.test(text) || /\/file\/get_files/i.test(text)
      || /^\s*(?:\[(?:图片|图像|image|video|audio|file|附件)\]|(?:image|video|audio|file)\s*[:：])/i.test(text)
      || (text.length >= 512 && /^[A-Za-z0-9+/\s]+={0,2}$/.test(text))) return false;
  }
  return Number.isSafeInteger(request.context?.draftRevision) && request.context.draftRevision >= 0;
}

function responseData(raw: unknown, inbound: boolean): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') throw new Error('invalid_response');
  const envelope = raw as Record<string, unknown>;
  if (envelope.success !== true) throw new Error('invalid_response');
  const data = inbound ? Array.isArray(envelope.data) && envelope.data.length === 1 ? envelope.data[0] : null : envelope.data;
  if (!data || typeof data !== 'object') throw new Error('invalid_response');
  const result = data as Record<string, unknown>;
  if (typeof result.translated_text !== 'string' || !result.translated_text.trim() || result.translated_text.length > 50_000 || typeof result.source_language !== 'string' || typeof result.target_language !== 'string') throw new Error('invalid_response');
  return result;
}

export function mountDesktopHost(root: HTMLElement, bindings: SiteBindings, bridge: DesktopHostAPI | undefined = window.desktopHost): () => void {
  if (window.location.protocol !== 'https:' || window.location.origin !== 'https://csagent.tsim.tech' || window.parent !== window) throw new Error('untrusted_host');
  root.replaceChildren();
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const login = document.createElement('a'); login.href = '/login'; login.textContent = '在此独立会话登录 tsim_cs';
  login.onclick = event => { event.preventDefault(); bindings.navigateLogin(); };
  const frames = document.createElement('div'); frames.style.cssText = 'width:100%;height:calc(100vh - 64px)';
  root.append(status, login, frames);
  if (!bridge) { status.textContent = '请从旅游商家辅助面板打开此页面。'; return () => root.replaceChildren(); }
  let disposed = false;
  let authGeneration = 0;
  let authKey: string | undefined;
  let validatedKey: string | null = null;
  let validatingKey: string | null = null;
  let iframe: HTMLIFrameElement | null = null;
  let current: Extract<HostCommand, { type: 'query' }> | null = null;
  let queryTimer: ReturnType<typeof setTimeout> | null = null;
  let frameGeneration = 0;
  let frameReady = false;
  const requests = new Map<string, AbortController>();
  const sessionKey = (s: SiteSession) => JSON.stringify([s.authenticated, s.accountScope, s.sessionRef, [...s.permissions].sort()]);
  const destroyFrame = () => { if (queryTimer) clearTimeout(queryTimer); queryTimer = null; iframe?.remove(); iframe = null; current = null; frameReady = false; frameGeneration++; };
  const cancelAll = () => { for (const controller of requests.values()) controller.abort(); requests.clear(); destroyFrame(); };
  const canUse = (context: TranslationRequest['context']) => {
    const session = bindings.session();
    return !disposed && session.authenticated && validatedKey === sessionKey(session) && session.accountScope === context.accountScope;
  };
  const sendQuery = (result: HostResponse & { type: 'query' }) => bridge.respond(result);
  const queryResponse = (command: Extract<HostCommand, { type: 'query' }>, result: Result<QueryResult>) => {
    sendQuery({ type: 'query', requestId: command.request.requestId, authGeneration: command.request.context.authGeneration, navigationGeneration: command.navigationGeneration, result });
  };
  const updateAuth = () => {
    if (disposed) return;
    const session = bindings.session(); const key = sessionKey(session);
    if (key !== authKey) {
      authKey = key; validatedKey = null; validatingKey = null; authGeneration++; cancelAll();
      bridge.authChanged(session.authenticated ? session.accountScope : null);
      login.hidden = session.authenticated; status.textContent = session.authenticated ? '正在核对客服身份…' : '需要在此会话登录 tsim_cs';
    }
    if (session.authenticated && session.accountScope && validatedKey !== key && validatingKey !== key) {
      validatingKey = key;
      void bindings.validate().then(() => {
        if (disposed || sessionKey(bindings.session()) !== key) return;
        validatedKey = key; status.textContent = 'tsim_cs 身份已确认';
      }).catch(() => { if (!disposed && sessionKey(bindings.session()) === key) status.textContent = '身份暂不可验证，请收起后重新打开 tsim_cs 视图以重试'; })
        .finally(() => { if(validatingKey===key)validatingKey=null; });
    }
  };

  async function translate(command: Extract<HostCommand, { type: 'translate' }>) {
    const request = command.request;
    const capturedAuth = authGeneration;
    const respond = (result: Extract<HostResponse, { type: 'translation' }>['result']) => bridge!.respond({ type: 'translation', requestId: request.requestId, navigationGeneration: command.navigationGeneration, authGeneration: request.context.authGeneration, result });
    if (!validateTranslation(request)) { respond(failure('invalid_translation', '翻译请求格式无效')); return; }
    if (!canUse(request.context)) { respond(failure('needs_login', '请在面板的 tsim_cs 会话中完成登录和身份核对')); return; }
    if (requests.has(request.requestId)) { respond(failure('duplicate_request', '请求已在进行')); return; }
    const controller = new AbortController(); requests.set(request.requestId, controller);
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const inbound = request.purpose === 'inbound';
      const body: Record<string, unknown> = inbound
        ? { texts: [request.text], target_lang: request.targetLanguage, source_lang: 'auto', purpose: 'inbound' }
        : { text: request.text, target_lang: request.targetLanguage, source_lang: request.sourceLanguage, purpose: request.purpose,
          ...(request.purpose === 'outbound' ? { draft_request_id: request.requestId, composer_content_version: String(request.context.draftRevision) } : {}) };
      const result = responseData(await bindings.post(inbound ? '/agent/translate/batch' : '/agent/translate', body, controller.signal), inbound);
      if (controller.signal.aborted || capturedAuth !== authGeneration || !canUse(request.context)) return;
      if (result.target_language !== request.targetLanguage) throw new Error('invalid_response');
      if (request.purpose === 'outbound' && (result.draft_request_id !== request.requestId || result.composer_content_version !== String(request.context.draftRevision))) throw new Error('draft_echo_mismatch');
      respond({ ok: true, value: { translatedText: result.translated_text as string, sourceLanguage: result.source_language as string, targetLanguage: result.target_language as string,
        ...(request.purpose === 'outbound' ? { draftRequestId: request.requestId, composerContentVersion: request.context.draftRevision } : {}) } });
    } catch (error) {
      if (disposed || capturedAuth !== authGeneration) return;
      const code = (error as { response?: { status?: number } })?.response?.status;
      const messages: Record<number, string> = { 401: '登录已失效', 403: '此客服账号没有所需权限', 413: '文本超过服务限制', 422: '翻译配置或文本不受支持', 423: '客服账号已锁定', 429: '翻译请求过于频繁', 503: '翻译服务暂不可用' };
      respond(failure(controller.signal.aborted ? 'cancelled_or_timeout' : code ? `http_${code}` : 'translation_unavailable', controller.signal.aborted ? '翻译已取消或超时，请明确重试' : code ? messages[code] ?? '翻译请求失败' : '翻译响应不可用', code === 429 || code === 503));
    } finally { clearTimeout(timeout); requests.delete(request.requestId); }
  }

  function query(command: Extract<HostCommand, { type: 'query' }>) {
    const request: QueryRequest = command.request;
    if (!request || !uuid.test(request.requestId) || request.confirmed !== true || typeof request.identifier !== 'string' || !request.identifier.trim() || request.identifier.length > 128 || !['order_number', 'iccid', 'eiccid'].includes(request.identifierType)) { queryResponse(command, failure('invalid_query', '请确认查询标识')); return; }
    if (!canUse(request.context)) { queryResponse(command, failure('needs_login', '请先完成 tsim_cs 登录和身份核对')); return; }
    const permissions = bindings.session().permissions;
    if (!bindings.operatorReadOnlyVerified || !permissions.includes('complaint_records') || permissions.includes('complaint_records_edit') || permissions.includes('complaint_records_manage')) { queryResponse(command, failure('query_authorization_unverified', '只读查询权限尚未通过部署验收')); return; }
    destroyFrame(); current = command; frameGeneration = command.frameGeneration;
    iframe = document.createElement('iframe');
    iframe.title = 'TSim 只读查询'; iframe.style.cssText = 'width:100%;height:100%;border:0';
    // Each request gets a fresh WindowProxy, including retrying the same identifier.
    const url = new URL('/embed/operator', window.location.origin);
    url.searchParams.set('mode', 'host'); url.searchParams.set('parentOrigin', window.location.origin);
    iframe.src = url.href; frames.append(iframe); status.textContent = '正在打开查询视图…';
    queryTimer = setTimeout(() => { if (current === command) { queryResponse(command, failure('frame_timeout', '查询页面等待超时，请明确重试', true)); destroyFrame(); } }, 30_000);
  }

  const onMessage = (event: MessageEvent) => {
    if (!current || !iframe || event.source !== iframe.contentWindow || event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') return;
    const command = current; const request = command.request; const data = event.data as Record<string, unknown>;
    if (!canUse(request.context) || frameGeneration !== command.frameGeneration) return;
    if (data.type === 'TSIM_OPERATOR_NEEDS_LOGIN') { status.textContent = '查询会话需要登录'; queryResponse(command, failure('needs_login', '查询会话需要重新登录')); destroyFrame(); return; }
    if (data.type === 'TSIM_OPERATOR_READY') {
      if (frameReady || data.version !== 2 || data.mode !== 'host' || !Array.isArray(data.capabilities) || !data.capabilities.includes('requestId')) return;
      frameReady = true;
      iframe.contentWindow!.postMessage({ type: 'TSIM_OPERATOR_SET_IDENTIFIER', version: 2, identifier: request.identifier, identifierType: request.identifierType, requestId: request.requestId, diagnosticRequestId: request.requestId }, window.location.origin);
      return;
    }
    if (!frameReady) return;
    if (data.type === 'TSIM_OPERATOR_BASIC_READY' || data.type === 'TSIM_OPERATOR_QUERY_TERMINAL') {
      if (data.version !== 2 || data.requestId !== request.requestId || data.identifier !== request.identifier) return;
      if (data.type === 'TSIM_OPERATOR_QUERY_TERMINAL') {
        if (data.outcome !== 'failed' && data.outcome !== 'unavailable') return;
        status.textContent = '查询失败'; queryResponse(command, failure('query_failed', '查询失败或暂不可用', true)); destroyFrame(); return;
      }
      status.textContent = '基础查询信息已呈现'; return;
    }
    if (data.type === 'TSIM_OPERATOR_LOADED' && data.identifier === request.identifier) {
      if (queryTimer) clearTimeout(queryTimer); queryTimer = null;
      status.textContent = '查询完成'; queryResponse(command, { ok: true, value: { requestId: request.requestId, identifier: request.identifier, frameGeneration, status: 'loaded' } });
    } else if (data.type === 'TSIM_OPERATOR_CLOSE') { status.textContent = '查询已关闭'; destroyFrame(); }
    // v1 BOUNDS/FOCUS hints never authorize success, resize, focus, or an API call.
  };
  window.addEventListener('message', onMessage);
  const unsubscribeSession = bindings.subscribe(updateAuth);
  const unsubscribeCommand = bridge.onCommand(command => {
    if (disposed) return;
    switch (command.type) {
      case 'translate': void translate(command); break;
      case 'query': query(command); break;
      case 'cancel':
        requests.get(command.requestId)?.abort();
        if (current?.request.requestId === command.requestId) { destroyFrame(); status.textContent = '查询已取消'; }
        break;
      case 'reset-context': cancelAll(); status.textContent = '面板上下文已更新，请重新查询'; break;
      case 'reset-query': destroyFrame(); status.textContent = '查询选择已更新，请重新确认'; break;
      case 'refresh-auth': updateAuth(); break;
      case 'logout': cancelAll(); void bindings.logout().finally(updateAuth); break;
    }
  });
  updateAuth(); bridge.ready();
  return () => { disposed = true; cancelAll(); unsubscribeSession(); unsubscribeCommand(); window.removeEventListener('message', onMessage); root.replaceChildren(); };
}
