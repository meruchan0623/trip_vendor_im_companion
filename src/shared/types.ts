export const PROTOCOL_VERSION = '1.0' as const;
export const HOST_ORIGIN = 'https://csagent.tsim.tech';
export const HOST_URL = `${HOST_ORIGIN}/desktop-host`;
export type Language = 'zh-CN' | 'en' | 'ja' | 'ko' | 'zh-TW' | 'th' | 'vi' | 'id' | 'es' | 'fr' | 'de';
export type TranslationPurpose = 'inbound' | 'outbound' | 'sent_message_review';
export type IdentifierType = 'order_number' | 'iccid' | 'eiccid';
export interface ContextSnapshot {
  accountScope: string;
  platformAccountScope: string;
  conversationKey: string;
  generation: number;
  authGeneration: number;
  draftRevision: number;
}
export interface TranslationRequest {
  requestId: string;
  text: string;
  targetLanguage: Language;
  sourceLanguage: Language | 'auto';
  purpose: TranslationPurpose;
  context: ContextSnapshot;
  configurationVersion: string;
}
export interface TranslationResult {
  requestId: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  context: ContextSnapshot;
  fromCache: boolean;
}
export interface QueryRequest {
  requestId: string;
  identifier: string;
  identifierType: IdentifierType;
  context: ContextSnapshot;
  confirmed: true;
}
export interface QueryResult { requestId: string; status: 'loading' | 'loaded' | 'failed' | 'needs_login'; identifier: string; frameGeneration: number }
export interface BridgeError { code: string; message: string; retryable: boolean }
export type Result<T> = { ok: true; value: T } | { ok: false; error: BridgeError };
export interface CompanionStatus {
  mode: 'manual';
  host: 'unconfigured' | 'loading' | 'ready' | 'needs_login' | 'failed';
  accountScope: string;
  authGeneration: number;
  capabilities: { readMessage: false; readOrder: false; readDraft: false; writeDraft: false; windowFollow: boolean };
  hostVisible: boolean;
  nativeStatus?: string;
  attached?: boolean;
  layout?: 'independent' | 'right' | 'left' | 'overlay';
}
export interface OrderCandidate {
  id: string;
  identifier: string;
  identifierType: IdentifierType;
  source: 'labeled_text' | 'manual';
  originalFragment: string;
  label: string;
  confidence: 'medium' | 'low';
  normalized: boolean;
  requiresConfirmation: true;
}
export interface CompanionAPI {
  getStatus(): Promise<CompanionStatus>;
  setContext(context: ContextSnapshot): Promise<Result<ContextSnapshot>>;
  translate(request: TranslationRequest): Promise<Result<TranslationResult>>;
  cancel(requestId: string): Promise<void>;
  query(request: QueryRequest): Promise<Result<QueryResult>>;
  resetQuery(): Promise<void>;
  showHost(): Promise<void>;
  hideHost(): Promise<void>;
  readClipboard(): Promise<Result<string>>;
  copyText(request: { text: string; context: ContextSnapshot }): Promise<Result<void>>;
  clearCache(): Promise<{ cleared: number }>;
  logout(): Promise<void>;
  onStatus(listener: (status: CompanionStatus) => void): () => void;
  listWindows(): Promise<Result<NativeWindow[]>>;
  bindWindow(targetInstanceId: string): Promise<Result<void>>;
  unbindWindow(): Promise<void>;
  minimize(): Promise<void>;
  close(): Promise<void>;
}
export interface NativeWindow { targetInstanceId: string; title: string; processName: string }
/** This API exists only in the approved remote top-level HTTPS host, never its iframe. */
export interface DesktopHostAPI {
  ready(): void;
  authChanged(accountScope: string | null): void;
  respond(response: HostResponse): void;
  onCommand(listener: (command: HostCommand) => void): () => void;
}
export type HostCommand =
  | { type: 'translate'; request: TranslationRequest; navigationGeneration: number }
  | { type: 'cancel'; requestId: string }
  | { type: 'query'; request: QueryRequest; frameGeneration: number; navigationGeneration: number }
  | { type: 'logout' }
  | { type: 'reset-context' }
  | { type: 'reset-query' }
  | { type: 'refresh-auth' };
export type HostResponse =
  | { type: 'translation'; requestId: string; navigationGeneration: number; authGeneration: number; result: Result<{ translatedText: string; sourceLanguage: string; targetLanguage: string; draftRequestId?: string; composerContentVersion?: number }> }
  | { type: 'query'; requestId: string; navigationGeneration: number; authGeneration: number; result: Result<QueryResult> };
declare global { interface Window { companion: CompanionAPI; desktopHost?: DesktopHostAPI } }
