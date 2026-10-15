import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { OutboundBody, OutboundResponse, PsimIdentity } from '../src/shared/workbench';
import { WORKBENCH_TARGETS } from '../src/shared/workbench';
import type { OrderProjection } from '../host/owned-service';

export interface OwnedAuthProcess {
  connected: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(message: unknown, callback?: (error: Error | null) => void): unknown;
  disconnect(): void;
}
export interface OwnedAuthClientOptions {
  executable?: string;
  workerEntry?: string;
  spawn?: typeof spawnChild;
  openLoginURL?: (url: string) => Promise<void>;
  requestTimeoutMs?: number;
  queryTimeoutMs?: number;
  readyTimeoutMs?: number;
}
type Pending = {
  type: string; identity?: PsimIdentity; body?: OutboundBody; identifier?: string;
  resolve(value: unknown): void; reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>; detach(): void;
};
const fail = (code: string) => new Error(code);
const cloneIdentity = (value: PsimIdentity | null): PsimIdentity | null => value && ({ ...value, permissions: [...value.permissions] });
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every(key => allowed.includes(key)); }
function parseIdentity(value: unknown): PsimIdentity | null {
  if (value === null) return null;
  if (!record(value) || !keys(value, ['accountScope', 'authGeneration', 'permissions'])
    || typeof value.accountScope !== 'string' || !/^psim:[A-Za-z0-9_-]{1,128}$/.test(value.accountScope)
    || !Number.isSafeInteger(value.authGeneration) || (value.authGeneration as number) < 0
    || !Array.isArray(value.permissions) || value.permissions.length > 200
    || !value.permissions.every(item => typeof item === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item))) throw fail('INVALID_AUTH_IDENTITY');
  return { accountScope: value.accountScope, authGeneration: value.authGeneration as number, permissions: [...new Set(value.permissions as string[])].sort() };
}
function equalIdentity(a: PsimIdentity | null, b: PsimIdentity | null) {
  return a === null ? b === null : b !== null && a.accountScope === b.accountScope && a.authGeneration === b.authGeneration && JSON.stringify(a.permissions) === JSON.stringify(b.permissions);
}
function loginURL(value: unknown): string {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/auth\/[0-9a-f]{64}$/.test(value)) throw fail('INVALID_OWNED_LOGIN_URL');
  const url = new URL(value);
  if (!url.port || Number(url.port) > 65535 || url.username || url.password || url.search || url.hash || url.href !== value) throw fail('INVALID_OWNED_LOGIN_URL');
  return value;
}
function validateBody(body: OutboundBody): OutboundBody {
  if (!record(body) || !keys(body, ['text', 'target_lang', 'source_lang', 'purpose', 'draft_request_id', 'composer_content_version'])
    || body.source_lang !== 'zh' || body.purpose !== 'outbound' || !WORKBENCH_TARGETS.includes(body.target_lang)
    || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000
    || typeof body.draft_request_id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(body.draft_request_id)
    || typeof body.composer_content_version !== 'string' || body.composer_content_version.length > 25000) throw fail('INVALID_OUTBOUND_REQUEST');
  return { text: body.text, target_lang: body.target_lang, source_lang: 'zh', purpose: 'outbound', draft_request_id: body.draft_request_id, composer_content_version: body.composer_content_version };
}
function translated(value: unknown, body: OutboundBody): OutboundResponse {
  if (!record(value) || !keys(value, ['success', 'data']) || value.success !== true || !record(value.data)
    || !keys(value.data, ['translated_text', 'draft_request_id', 'composer_content_version', 'source_language', 'target_language'])
    || typeof value.data.translated_text !== 'string' || !value.data.translated_text.trim() || value.data.translated_text.length > 50000
    || value.data.draft_request_id !== body.draft_request_id || value.data.composer_content_version !== body.composer_content_version) throw fail('OUTBOUND_ECHO_MISMATCH');
  return { success: true, data: { translated_text: value.data.translated_text, draft_request_id: body.draft_request_id, composer_content_version: body.composer_content_version } };
}
function order(value: unknown, identifier: string): OrderProjection {
  const readLabels = ['status', 'package_status', 'iccid', 'eiccid', 'topup_id', 'channel_name', 'supplier_name', 'channel_dataplan_name', 'type', 'out_order_identifier', 'custom_order_id', 'data_usage', 'spec_name', 'today_usage', 'esim_status'];
  if (!record(value) || !keys(value, ['identifier', 'found', 'fields', 'source', 'ownership']) || value.identifier !== identifier.trim()
    || typeof value.found !== 'boolean' || value.source !== '旅游商家原编号（未转换）' || value.ownership !== 'tsim_cs 服务端权限核验'
    || !Array.isArray(value.fields) || value.fields.length > 400 || !value.fields.every(field => record(field) && keys(field, ['label', 'value'])
      && typeof field.label === 'string' && readLabels.includes(field.label) && typeof field.value === 'string' && field.value.length <= 1000)) throw fail('INVALID_ORDER_PROJECTION');
  return { identifier: identifier.trim(), found: value.found, fields: value.fields.map(field => ({ label: field.label as string, value: field.value as string })), source: value.source, ownership: value.ownership };
}

/** Owns only an independent auth child. No credential-bearing commands or vendor process handles exist here. */
export class OwnedAuthClient {
  private child: OwnedAuthProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  private disposed = false;
  private url: string | null = null;
  private current: PsimIdentity | null = null;
  private highestGeneration = -1;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(identity: PsimIdentity | null) => void>();
  constructor(private options: OwnedAuthClientOptions = {}) {}
  identity(): PsimIdentity | null { return cloneIdentity(this.current); }
  onIdentity(listener: (identity: PsimIdentity | null) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(fail('OWNED_AUTH_DISPOSED'));
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.readyTimer = setTimeout(() => this.shutdown('OWNED_AUTH_READY_TIMEOUT'), this.options.readyTimeoutMs ?? 10000);
    try {
      const entry = this.options.workerEntry ?? process.argv[1];
      if (!entry) throw fail('OWNED_AUTH_ENTRY_REQUIRED');
      this.child = (this.options.spawn ?? spawnChild)(this.options.executable ?? process.execPath, [entry, '--owned-auth'], {
        shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }) as OwnedAuthProcess;
      this.child.on('message', message => this.message(message));
      this.child.on('error', () => this.shutdown('OWNED_AUTH_PROCESS_ERROR'));
      this.child.on('exit', () => this.shutdown('OWNED_AUTH_EXITED'));
      this.child.on('disconnect', () => this.shutdown('OWNED_AUTH_DISCONNECTED'));
    } catch { this.shutdown('OWNED_AUTH_START_FAILED'); }
    return this.readyPromise;
  }
  async openLogin(): Promise<void> {
    await this.start(); if (this.disposed || !this.url) throw fail('OWNED_AUTH_UNAVAILABLE');
    const url = loginURL(this.url);
    if (this.options.openLoginURL) { await this.options.openLoginURL(url); return; }
    if (process.platform !== 'win32') throw fail('OWNED_LOGIN_OPENER_REQUIRED');
    await new Promise<void>((resolve, reject) => {
      const opener = spawnChild('rundll32.exe', ['url.dll,FileProtocolHandler', url], { shell: false, detached: true, windowsHide: true, stdio: 'ignore' });
      opener.once('error', () => reject(fail('OWNED_LOGIN_OPEN_FAILED')));
      opener.once('spawn', () => { opener.unref(); resolve(); });
    });
  }
  async translate(body: OutboundBody, identity: PsimIdentity, signal: AbortSignal): Promise<OutboundResponse> {
    const exact = validateBody(body);
    return this.request('translate', { body: exact }, signal, identity, exact) as Promise<OutboundResponse>;
  }
  async queryOriginalIdentifier(identifier: string, identity: PsimIdentity, signal: AbortSignal): Promise<OrderProjection> {
    if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 128 || /[\r\n\u0000]/.test(identifier)) throw fail('INVALID_ORDER_IDENTIFIER');
    return this.request('query', { identifier }, signal, identity, undefined, identifier) as Promise<OrderProjection>;
  }
  async refresh(): Promise<PsimIdentity | null> { return this.request('refresh', {}) as Promise<PsimIdentity | null>; }
  async logout(): Promise<void> { await this.request('logout', {}); }
  private async request(type: string, payload: Record<string, unknown>, signal?: AbortSignal, expected?: PsimIdentity, body?: OutboundBody, identifier?: string): Promise<unknown> {
    if (signal?.aborted) throw fail('REQUEST_ABORTED');
    const ready = this.start();
    if (signal) await new Promise<void>((resolve, reject) => {
      const aborted = () => { signal.removeEventListener('abort', aborted); reject(fail('REQUEST_ABORTED')); };
      signal.addEventListener('abort', aborted, { once: true });
      ready.then(() => { signal.removeEventListener('abort', aborted); resolve(); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
      if (signal.aborted) aborted();
    }); else await ready;
    if (signal?.aborted) throw fail('REQUEST_ABORTED');
    const identity = expected ? parseIdentity(expected) : undefined;
    if (expected && (!identity || !equalIdentity(identity, this.current))) throw fail('AUTH_CHANGED');
    if (this.disposed || !this.child?.connected) throw fail('OWNED_AUTH_UNAVAILABLE');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => { this.send({ type: 'cancel', id }); this.finish(id, fail('REQUEST_ABORTED')); };
      const timer = setTimeout(() => { this.send({ type: 'cancel', id }); this.finish(id, fail('OWNED_AUTH_REQUEST_TIMEOUT')); }, type === 'query' ? this.options.queryTimeoutMs ?? 120000 : this.options.requestTimeoutMs ?? 35000);
      this.pending.set(id, { type, identity: identity ?? undefined, body, identifier, resolve, reject, timer, detach: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      this.send({ id, type, ...payload, ...(identity ? { identity } : {}) }, error => { if (error) this.finish(id, fail('OWNED_AUTH_IPC_FAILED')); });
    });
  }
  private send(value: unknown, callback?: (error: Error | null) => void): void {
    try { if (this.child?.connected) this.child.send(value, callback); else callback?.(fail('OWNED_AUTH_IPC_FAILED')); }
    catch { callback?.(fail('OWNED_AUTH_IPC_FAILED')); }
  }
  private message(value: unknown): void {
    if (this.disposed) return;
    try {
      if (!record(value)) throw fail('INVALID_OWNED_MESSAGE');
      if (value.type === 'ready') {
        if (this.ready || !keys(value, ['type', 'loginURL'])) throw fail('INVALID_OWNED_READY');
        this.url = loginURL(value.loginURL); this.ready = true;
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = null; this.readyResolve?.(); this.readyResolve = null; this.readyReject = null;
      } else if (value.type === 'auth') {
        if (!keys(value, ['type', 'identity'])) throw fail('INVALID_AUTH_IDENTITY');
        const next = parseIdentity(value.identity);
        if (next && (next.authGeneration < this.highestGeneration || (!this.current && next.authGeneration === this.highestGeneration))) throw fail('STALE_AUTH_IDENTITY');
        if (next) this.highestGeneration = next.authGeneration;
        if (!equalIdentity(next, this.current)) {
          this.current = next;
          for (const [id, pending] of this.pending) if (pending.identity) { this.send({ type: 'cancel', id }); this.finish(id, fail('AUTH_CHANGED')); }
          this.publish();
        }
      } else if (value.type === 'response') {
        if (!keys(value, ['type', 'id', 'ok', 'value', 'error']) || typeof value.id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(value.id) || typeof value.ok !== 'boolean') throw fail('INVALID_OWNED_RESPONSE');
        const pending = this.pending.get(value.id); if (!pending) return;
        if (pending.identity && !equalIdentity(pending.identity, this.current)) { this.finish(value.id, fail('AUTH_CHANGED')); return; }
        if (!value.ok) { this.finish(value.id, fail(typeof value.error === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value.error) ? value.error : 'SERVICE_UNAVAILABLE')); return; }
        let result: unknown;
        if (pending.type === 'translate') result = translated(value.value, pending.body!);
        else if (pending.type === 'query') result = order(value.value, pending.identifier!);
        else if (pending.type === 'logout') { if (value.value !== null) throw fail('INVALID_AUTH_IDENTITY'); result = null; }
        else { result = parseIdentity(value.value); if (!equalIdentity(result as PsimIdentity | null, this.current)) throw fail('STALE_AUTH_IDENTITY'); }
        this.finish(value.id, undefined, result);
      } else throw fail('INVALID_OWNED_MESSAGE');
    } catch { this.shutdown('INVALID_OWNED_MESSAGE'); }
  }
  private publish() { for (const listener of this.listeners) try { listener(this.identity()); } catch { /* subscriber cannot break process cleanup */ } }
  private finish(id: string, error?: Error, value?: unknown) { const pending = this.pending.get(id); if (!pending) return; this.pending.delete(id); clearTimeout(pending.timer); pending.detach(); if (error) pending.reject(error); else pending.resolve(value); }
  private shutdown(code: string): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.readyTimer) clearTimeout(this.readyTimer); this.readyTimer = null;
    this.readyReject?.(fail(code)); this.readyResolve = null; this.readyReject = null;
    for (const id of this.pending.keys()) this.finish(id, fail(code));
    this.url = null; this.current = null; this.publish(); this.listeners.clear();
    this.send({ type: 'stop', id: randomUUID() });
    try { if (this.child?.connected) this.child.disconnect(); } catch { /* disconnect only the owned IPC */ }
  }
  dispose(): void { this.shutdown('OWNED_AUTH_DISPOSED'); }
}

