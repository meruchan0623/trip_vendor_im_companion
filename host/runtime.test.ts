import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountDesktopHost, validateTranslation, type SiteBindings, type SiteSession } from './runtime';
import type { DesktopHostAPI, HostCommand, HostResponse, QueryRequest, TranslationRequest } from '../src/shared/types';

class Element {
  children: Element[] = [];
  style = { cssText: '' };
  textContent = '';
  hidden = false;
  href = '';
  src = '';
  title = '';
  onclick: unknown;
  parent: Element | null = null;
  contentWindow = { postMessage: vi.fn() };
  setAttribute() {}
  append(...elements: Element[]) { this.children.push(...elements); for (const element of elements) element.parent = this; }
  replaceChildren(...elements: Element[]) { this.children = []; this.append(...elements); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}

const requestId = '550e8400-e29b-41d4-a716-446655440000';
const context = { accountScope: 'psim:7', platformAccountScope: 'unknown', conversationKey: 'manual:test', generation: 1, authGeneration: 31, draftRevision: 4 };
const translation = (): TranslationRequest => ({ requestId, text: 'hello', targetLanguage: 'ja', sourceLanguage: 'en', purpose: 'outbound', context: { ...context }, configurationVersion: 'server' });
const queryRequest = (): QueryRequest => ({ requestId, identifier: 'TEST-ORDER', identifierType: 'order_number', context: { ...context }, confirmed: true });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('HTTPS desktop host trust and lifecycle', () => {
  let root: Element;
  let session: SiteSession;
  let sessionChanged: () => void;
  let command: (value: HostCommand) => void;
  let listener: (event: MessageEvent) => void;
  let responses: HostResponse[];
  let bindings: SiteBindings;
  let dispose: (() => void) | undefined;
  let bridge: DesktopHostAPI;
  beforeEach(() => {
    root = new Element(); responses = [];
    session = { authenticated: true, accountScope: 'psim:7', sessionRef: 'session-a', permissions: ['complaint_records'] };
    const fakeWindow: Record<string, unknown> = {
      location: { protocol: 'https:', origin: 'https://csagent.tsim.tech' },
      addEventListener: (_: string, fn: (event: MessageEvent) => void) => { listener = fn; }, removeEventListener: vi.fn(),
    };
    fakeWindow.parent = fakeWindow;
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', { createElement: () => new Element() });
    bridge = { ready: vi.fn(), authChanged: vi.fn(), respond: response => responses.push(response), onCommand: callback => { command = callback; return vi.fn(); } };
    bindings = {
      post: vi.fn(async () => ({ success: true, data: { translated_text: 'こんにちは', source_language: 'en', target_language: 'ja', draft_request_id: requestId, composer_content_version: '4' } })),
      session: () => session,
      subscribe: callback => { sessionChanged = callback; return vi.fn(); }, validate: vi.fn(async () => {}), logout: vi.fn(async () => {}), navigateLogin: vi.fn(), operatorReadOnlyVerified: true,
    };
  });
  afterEach(() => { dispose?.(); dispose = undefined; vi.unstubAllGlobals(); });
  async function mount() { dispose = mountDesktopHost(root as unknown as HTMLElement, bindings, bridge); await flush(); }
  const frame = () => root.children[2].children[0];
  const message = (data: unknown, source: unknown = frame()?.contentWindow, origin = 'https://csagent.tsim.tech') => listener({ data, source, origin } as MessageEvent);
  const open = (frameGeneration = 1) => command({ type: 'query', request: queryRequest(), navigationGeneration: 12, frameGeneration });

  it('restricts the top-level host to the approved HTTPS origin', () => {
    vi.stubGlobal('window', { location: { protocol: 'https:', origin: 'https://evil.test' } });
    expect(() => mountDesktopHost(root as unknown as HTMLElement, bindings, bridge)).toThrow('untrusted_host');
  });
  it('uses only the allowed translation endpoint/fields and echoes shell auth generation after reload', async () => {
    await mount(); command({ type: 'translate', request: translation(), navigationGeneration: 12 }); await flush();
    expect(bindings.post).toHaveBeenCalledWith('/agent/translate', { text: 'hello', target_lang: 'ja', source_lang: 'en', purpose: 'outbound', draft_request_id: requestId, composer_content_version: '4' }, expect.any(AbortSignal));
    expect(responses[0]).toMatchObject({ type: 'translation', navigationGeneration: 12, authGeneration: 31, result: { ok: true, value: { composerContentVersion: 4 } } });
  });
  it('rejects a mismatched draft version echo', async () => {
    bindings.post = vi.fn(async () => ({ success: true, data: { translated_text: 'bad', target_language: 'ja', source_language: 'en', draft_request_id: requestId, composer_content_version: '3' } }));
    await mount(); command({ type: 'translate', request: translation(), navigationGeneration: 12 }); await flush();
    expect(responses[0].result.ok).toBe(false);
  });
  it('inbound always uses batch auto and does not pretend auto is detected language', async () => {
    bindings.post = vi.fn(async () => ({ success: true, data: [{ translated_text: 'こんにちは', source_language: 'auto', target_language: 'ja' }] }));
    await mount(); command({ type: 'translate', request: { ...translation(), purpose: 'inbound', sourceLanguage: 'auto' }, navigationGeneration: 12 }); await flush();
    expect(bindings.post).toHaveBeenCalledWith('/agent/translate/batch', { texts: ['hello'], target_lang: 'ja', source_lang: 'auto', purpose: 'inbound' }, expect.any(AbortSignal));
    expect(responses[0].result).toMatchObject({ ok: true, value: { sourceLanguage: 'auto' } });
  });
  it('never accepts media/base64 as inbound original text', () => {
    for (const text of ['data:image/png;foo', 'blob:test', '[图片]', 'A'.repeat(512), '']) expect(validateTranslation({ ...translation(), text, purpose: 'inbound', sourceLanguage: 'auto' })).toBe(false);
  });
  it('rejects unverified read-only permissions before creating iframe', async () => {
    bindings.operatorReadOnlyVerified = false; await mount(); open();
    expect(frame()).toBeUndefined(); expect(responses[0].result).toMatchObject({ ok: false, error: { code: 'query_authorization_unverified' } });
  });
  it('validates both source and origin before sending identifier', async () => {
    await mount(); open(); const ready = { type: 'TSIM_OPERATOR_READY', version: 2, mode: 'host', capabilities: ['requestId'] };
    message(ready, {}, 'https://csagent.tsim.tech'); message(ready, frame().contentWindow, 'https://evil.test');
    expect(frame().contentWindow.postMessage).not.toHaveBeenCalled(); message(ready);
    expect(frame().contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'TSIM_OPERATOR_SET_IDENTIFIER', version: 2, requestId }), 'https://csagent.tsim.tech');
  });
  it('recreates iframe for the same identifier and discards late no-ID success from prior source', async () => {
    await mount(); open(); const oldSource = frame().contentWindow; open(2);
    expect(frame().contentWindow).not.toBe(oldSource);
    message({ type: 'TSIM_OPERATOR_READY', version: 2, mode: 'host', capabilities: ['requestId'] });
    message({ type: 'TSIM_OPERATOR_LOADED', identifier: 'TEST-ORDER' }, oldSource);
    expect(responses).toHaveLength(0);
    message({ type: 'TSIM_OPERATOR_LOADED', identifier: 'TEST-ORDER' });
    expect(responses[0].result).toMatchObject({ ok: true, value: { frameGeneration: 2, status: 'loaded' } });
  });
  it('discards in-flight results across same-account session changes', async () => {
    let resolve: (value: unknown) => void = () => {};
    bindings.post = vi.fn(() => new Promise(done => { resolve = done; }));
    await mount(); command({ type: 'translate', request: translation(), navigationGeneration: 12 });
    session = { ...session, sessionRef: 'session-b' }; sessionChanged();
    resolve({ success: true, data: { translated_text: 'stale', source_language: 'en', target_language: 'ja', draft_request_id: requestId, composer_content_version: '4' } }); await flush();
    expect(responses).toHaveLength(0); expect(bridge.authChanged).toHaveBeenCalledTimes(2);
  });
  it('destroys the current iframe when effective permissions change', async () => {
    await mount(); open(); session = { ...session, permissions: ['complaint_records', 'complaint_records_edit'] }; sessionChanged();
    expect(frame()).toBeUndefined();
  });
  it('explicitly retries identity verification after a transient network failure',async()=>{
    bindings.validate=vi.fn().mockRejectedValueOnce(new Error('temporary_network_failure')).mockResolvedValue(undefined);
    await mount();await flush();
    command({type:'translate',request:translation(),navigationGeneration:12});await flush();
    expect(bindings.post).not.toHaveBeenCalled();expect(responses[0].result.ok).toBe(false);
    command({type:'refresh-auth'});await flush();await flush();
    expect(bindings.validate).toHaveBeenCalledTimes(2);
    command({type:'translate',request:translation(),navigationGeneration:12});await flush();
    expect(bindings.post).toHaveBeenCalledTimes(1);expect(responses.at(-1)?.result.ok).toBe(true);
  });
});
