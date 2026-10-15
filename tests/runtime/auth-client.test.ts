import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnedAuthClient } from '../../runtime/auth-client';
import type { OutboundBody, PsimIdentity } from '../../src/shared/workbench';

const identity: PsimIdentity = { accountScope: 'psim:42', authGeneration: 2, permissions: ['complaint_records'] };
const body: OutboundBody = { text: '请确认订单。', target_lang: 'en', source_lang: 'zh', purpose: 'outbound', draft_request_id: 'draft-1', composer_content_version: '["conv-1","请确认订单。","en","deepseek:outbound:v1"]' };
const login = `http://127.0.0.1:34567/auth/${'a'.repeat(64)}`;
class FakeChild extends EventEmitter {
  connected = true;
  messages: Record<string, any>[] = [];
  failSend = false;
  disconnect = vi.fn(() => { this.connected = false; this.emit('disconnect'); });
  send(message: Record<string, any>, callback?: (error: Error | null) => void) { this.messages.push(message); callback?.(this.failSend ? new Error('private process failure') : null); }
  ready(url = login) { this.emit('message', { type: 'ready', loginURL: url }); }
  auth(value: unknown = identity) { this.emit('message', { type: 'auth', identity: value }); }
  respond(request: Record<string, any>, value: unknown) { this.emit('message', { type: 'response', id: request.id, ok: true, value }); }
}
const clients: OwnedAuthClient[] = [];
function setup(options: { requestTimeoutMs?: number; readyTimeoutMs?: number; queryTimeoutMs?: number } = {}) {
  const child = new FakeChild(); const factory = vi.fn(() => child); const open = vi.fn(async () => {});
  const client = new OwnedAuthClient({ executable: 'owned-node.exe', workerEntry: 'owned-runtime.cjs', spawn: factory as unknown as typeof spawn, openLoginURL: open, ...options });
  clients.push(client); return { client, child, factory, open };
}
async function boot(options: Parameters<typeof setup>[0] = {}) { const result = setup(options); const started = result.client.start(); result.child.ready(); result.child.auth(); await started; return result; }
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function response() { return { success: true, data: { translated_text: 'Please confirm the order.', draft_request_id: body.draft_request_id, composer_content_version: body.composer_content_version } }; }
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers(); });

describe('OwnedAuthClient capability and lifecycle', () => {
  it('starts only its own Node entry with ignored stdio and IPC, then opens validated login', async () => {
    const { client, factory, open } = await boot();
    expect(factory).toHaveBeenCalledWith('owned-node.exe', ['owned-runtime.cjs', '--owned-auth'], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await client.openLogin(); expect(open).toHaveBeenCalledExactlyOnceWith(login);
    const copied = client.identity()!; copied.permissions.push('forged'); expect(client.identity()).toEqual(identity);
  });
  it.each(['https://127.0.0.1:34567/auth/' + 'a'.repeat(64), 'http://localhost:34567/auth/' + 'a'.repeat(64), 'http://127.0.0.1:65536/auth/' + 'a'.repeat(64), login + '?token=hidden', login + '#secret', 'http://127.0.0.1:34567/auth/' + 'A'.repeat(64), 'http://user@127.0.0.1:34567/auth/' + 'a'.repeat(64)])('rejects an unsafe ready URL without opening it: %s', async url => {
    const { client, child, open } = setup(); const result = client.start(); const rejection = expect(result).rejects.toThrow('INVALID_OWNED_MESSAGE'); child.ready(url); await rejection;
    expect(open).not.toHaveBeenCalled(); expect(child.disconnect).toHaveBeenCalledOnce();
  });
  it('strictly rejects credential-bearing auth projection and only publishes null', async () => {
    const { client, child } = await boot(); const changed = vi.fn(); client.onIdentity(changed);
    child.auth({ ...identity, access_token: 'must-not-be-relayed' });
    expect(client.identity()).toBeNull(); expect(changed).toHaveBeenCalledExactlyOnceWith(null);
    expect(child.messages.every(message => !JSON.stringify(message).includes('must-not-be-relayed'))).toBe(true);
  });
  it('accepts only exact outbound echo and strips optional response metadata', async () => {
    const { client, child } = await boot(); const result = client.translate(body, identity, new AbortController().signal); await tick();
    const command = child.messages.at(-1)!; expect(command.type).toBe('translate'); expect(command.identity).toEqual(identity); expect(command.body).toEqual(body);
    child.respond(command, { ...response(), data: { ...response().data, source_language: 'zh' } }); expect(await result).toEqual(response());
  });
  it('rejects stale request identity before sending any draft', async () => {
    const { client, child } = await boot(); await expect(client.translate(body, { ...identity, authGeneration: 1 }, new AbortController().signal)).rejects.toThrow('AUTH_CHANGED'); expect(child.messages).toEqual([]);
  });
  it('does not send extra credential fields even when a caller bypasses TypeScript', async () => {
    const { client, child } = await boot(); await expect(client.translate({ ...body, password: 'not-relayed' } as OutboundBody, identity, new AbortController().signal)).rejects.toThrow('INVALID_OUTBOUND_REQUEST'); expect(child.messages).toEqual([]);
  });
  it('rejects a mismatched revision echo instead of accepting a translated draft', async () => {
    const { client, child } = await boot(); const result = client.translate(body, identity, new AbortController().signal); const rejected = expect(result).rejects.toThrow('INVALID_OWNED_MESSAGE'); await tick(); child.respond(child.messages.at(-1)!, { ...response(), data: { ...response().data, composer_content_version: 'other-revision' } }); await rejected; expect(client.identity()).toBeNull();
  });
  it('rejects credential-like order fields rather than returning unrestricted worker data', async () => {
    const { client, child } = await boot(); const result = client.queryOriginalIdentifier('12345', identity, new AbortController().signal); const rejected = expect(result).rejects.toThrow('INVALID_OWNED_MESSAGE'); await tick(); child.respond(child.messages.at(-1)!, { identifier: '12345', found: true, fields: [{ label: 'pin_puk', value: 'not-relayed' }], source: '旅游商家原编号（未转换）', ownership: 'tsim_cs 服务端权限核验' }); await rejected;
  });
  it('aborts an in-flight request, sends cancel only for its id, and ignores late response', async () => {
    const { client, child } = await boot(); const controller = new AbortController(); const result = client.translate(body, identity, controller.signal); const rejected = expect(result).rejects.toThrow('REQUEST_ABORTED'); await tick(); const request = child.messages.at(-1)!;
    controller.abort(); await rejected; expect(child.messages.at(-1)).toEqual({ type: 'cancel', id: request.id }); child.respond(request, response()); expect(client.identity()).toEqual(identity);
  });
  it('aborts immediately even while the owned worker is still starting', async () => {
    const { client, child } = setup(); const controller = new AbortController(); const result = client.translate(body, identity, controller.signal); const rejected = expect(result).rejects.toThrow('REQUEST_ABORTED'); controller.abort(); await rejected;
    expect(child.messages).toEqual([]); child.ready();
  });
  it('auth changes cancel pending work and a late old result cannot restore it', async () => {
    const { client, child } = await boot(); const result = client.translate(body, identity, new AbortController().signal); const rejected = expect(result).rejects.toThrow('AUTH_CHANGED'); await tick(); const request = child.messages.at(-1)!;
    const next = { ...identity, authGeneration: 3 }; child.auth(next); await rejected; child.respond(request, response()); expect(client.identity()).toEqual(next); expect(child.messages.at(-1)).toEqual({ type: 'cancel', id: request.id });
  });
  it('cannot resurrect a logged-out identity from an old auth event', async () => {
    const { client, child } = await boot(); child.auth(null); child.auth(identity); expect(client.identity()).toBeNull(); expect(child.disconnect).toHaveBeenCalledOnce();
  });
  it('times out once, sends cancel, and never retries the translation', async () => {
    vi.useFakeTimers(); const { client, child } = await boot({ requestTimeoutMs: 40 }); const result = client.translate(body, identity, new AbortController().signal); const rejected = expect(result).rejects.toThrow('OWNED_AUTH_REQUEST_TIMEOUT'); await tick(); const request = child.messages.at(-1)!;
    await vi.advanceTimersByTimeAsync(40); await rejected; expect(child.messages).toEqual([request, { type: 'cancel', id: request.id }]);
  });
  it('separately allows a bounded longer order query and projects only read fields', async () => {
    vi.useFakeTimers(); const { client, child } = await boot({ requestTimeoutMs: 5, queryTimeoutMs: 60 }); const result = client.queryOriginalIdentifier('12345', identity, new AbortController().signal); await tick(); const request = child.messages.at(-1)!;
    await vi.advanceTimersByTimeAsync(10); const projection = { identifier: '12345', found: false, fields: [], source: '旅游商家原编号（未转换）', ownership: 'tsim_cs 服务端权限核验' }; child.respond(request, projection); expect(await result).toEqual(projection);
  });
  it('terminates all pending requests on abnormal exit and never returns raw process errors', async () => {
    const { client, child } = await boot(); const result = client.translate(body, identity, new AbortController().signal); const rejected = expect(result).rejects.toThrow('OWNED_AUTH_EXITED'); await tick(); child.emit('exit', 1, null); await rejected; expect(client.identity()).toBeNull(); await expect(client.openLogin()).rejects.toThrow('OWNED_AUTH_DISPOSED');
  });
  it('handles startup timeout and IPC send failure as safe error codes', async () => {
    vi.useFakeTimers(); const waiting = setup({ readyTimeoutMs: 20 }); const started = waiting.client.start(); const startupRejected = expect(started).rejects.toThrow('OWNED_AUTH_READY_TIMEOUT'); await vi.advanceTimersByTimeAsync(20); await startupRejected;
    const { client, child } = await boot(); child.failSend = true; await expect(client.translate(body, identity, new AbortController().signal)).rejects.toThrow('OWNED_AUTH_IPC_FAILED');
  });
  it('dispose sends stop and disconnects its own IPC without any kill API or vendor command', async () => {
    const { client, child } = await boot(); client.dispose(); client.dispose(); expect(child.disconnect).toHaveBeenCalledOnce(); expect(child.messages).toHaveLength(1); expect(child.messages[0].type).toBe('stop'); expect(child.messages[0].id).toMatch(/^[a-z0-9-]{1,100}$/); expect('kill' in child).toBe(false);
  });
});
