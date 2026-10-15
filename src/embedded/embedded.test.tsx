// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountEmbedded, type EmbeddedInstance } from './index';
import { EMPTY_WORKBENCH } from './Workbench';
import type { RuntimeWorkbenchAPI } from './App';
let instance: EmbeddedInstance | undefined;
let nativeRoot: HTMLDivElement, editor: HTMLDivElement, send: HTMLButtonElement;
function viewport(width: number) { Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width }); }
beforeEach(() => {
  vi.useFakeTimers(); (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  viewport(1700); nativeRoot = document.createElement('div'); nativeRoot.id = 'root'; nativeRoot.style.height = '100%';
  const body = document.createElement('div'); body.className = 'body-container';
  editor = document.createElement('div'); editor.className = 'ProseMirror chat-editor'; editor.contentEditable = 'true'; editor.textContent = 'ORIGINAL FIXTURE';
  send = document.createElement('button'); send.textContent = '发送'; body.append(editor, send); nativeRoot.append(body); document.body.append(nativeRoot);
});
afterEach(async () => { await act(async () => { await instance?.destroy(); }); instance = undefined; nativeRoot.remove(); vi.useRealTimers(); });
it('default collapsed sibling preserves original editor/send and has no obsolete inbound UI', async () => {
  await act(async () => { instance = mountEmbedded(); });
  expect(instance!.host.parentNode).toBe(document.body); expect(instance!.host.style.width).toBe('32px');
  await act(async () => { instance!.setExpanded(true); });
  expect(instance!.host.shadowRoot!.querySelector('textarea')).toBeNull(); expect(editor.textContent).toBe('ORIGINAL FIXTURE'); expect(send.isConnected).toBe(true);
  expect(instance!.host.shadowRoot!.textContent).toContain('原草稿来源与翻译服务尚未验证');
});
it('narrow viewport refuses expansion and a resize collapses without changing original content', async () => {
  viewport(1100); await act(async () => { instance = mountEmbedded(); }); expect(instance!.setExpanded(true)).toBe(false);
  viewport(1700); await act(async () => { instance!.setExpanded(true); }); expect(instance!.expanded()).toBe(true);
  viewport(1000); await act(async () => { window.dispatchEvent(new Event('resize')); }); expect(instance!.expanded()).toBe(false); expect(editor.textContent).toBe('ORIGINAL FIXTURE');
});
it('detach restores owned layout and preserves later vendor style changes', async () => {
  const previous = document.body.style.display;
  await act(async () => { instance = mountEmbedded(); instance.setExpanded(true); });
  nativeRoot.style.height = '91%'; await act(async () => { await instance!.detach(); });
  expect(document.body.style.display).toBe(previous); expect(nativeRoot.style.flex).toBe(''); expect(nativeRoot.style.height).toBe('91%');
});
it('mock dangerous shortcut/edit sentinels never receive assistant events and default IME is preserved', async () => {
  await act(async () => { instance = mountEmbedded(); instance.setExpanded(true); });
  const sentinel = vi.fn(); const handler = (event: Event) => { if (!(event instanceof KeyboardEvent) || ['Enter', 'F1', 'F2', 'F3'].includes(event.key)) sentinel(); };
  const events = ['keydown', 'keyup', 'keypress', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'paste', 'copy', 'cut'];
  events.forEach(type => document.addEventListener(type, handler));
  try {
    const control = instance!.host.shadowRoot!.querySelector('button')!;
    for (const type of ['keydown', 'keyup', 'keypress']) for (const key of ['Enter', 'F1', 'F2', 'F3']) {
      const event = new KeyboardEvent(type, { key, bubbles: true, composed: true, cancelable: true }); control.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
    }
    for (const type of events.slice(3)) { const event = new Event(type, { bubbles: true, composed: true, cancelable: true }); control.dispatchEvent(event); expect(event.defaultPrevented).toBe(false); }
    expect(sentinel).not.toHaveBeenCalled(); expect(editor.textContent).toBe('ORIGINAL FIXTURE');
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); expect(sentinel).toHaveBeenCalledTimes(1);
  } finally { events.forEach(type => document.removeEventListener(type, handler)); }
});
it('workbench disposal is idempotent, external state stops and original client nodes remain', async () => {
  const dispose = vi.fn(async () => {}), unsubscribe = vi.fn();
  const workbench: RuntimeWorkbenchAPI = { getState: () => EMPTY_WORKBENCH, onState: () => unsubscribe, dispose, actions: { cancel: vi.fn() } as unknown as RuntimeWorkbenchAPI['actions'] };
  await act(async () => { instance = mountEmbedded({ workbench }); instance.setExpanded(true); });
  await act(async () => { const first = instance!.detach(); expect(instance!.detach()).toBe(first); await first; });
  expect(dispose).toHaveBeenCalledTimes(1); expect(unsubscribe).toHaveBeenCalledTimes(1); expect(editor.isConnected).toBe(true); expect(send.isConnected).toBe(true);
});
it('lease expiry restores layout and stale heartbeat cannot renew it', async () => {
  await act(async () => { instance = mountEmbedded({ leaseMs: 1000 }); instance.setExpanded(true); });
  instance!.heartbeat(1); expect(() => instance!.heartbeat(1)).toThrow('STALE_HEARTBEAT');
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); }); expect(instance!.host.isConnected).toBe(false); expect(nativeRoot.style.flex).toBe(''); expect(() => instance!.heartbeat(2)).toThrow('LEASE_ENDED');
});
it.each([false, true])('own exit expanded=%s never activates original send', async expanded => {
  const originalSend = vi.fn(); send.addEventListener('click', originalSend);
  await act(async () => { instance = mountEmbedded(); instance.setExpanded(expanded); });
  await act(async () => { const control = [...instance!.host.shadowRoot!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === (expanded ? '退出' : '×'))!; control.click(); });
  expect(instance!.host.isConnected).toBe(false); expect(originalSend).not.toHaveBeenCalled(); expect(editor.textContent).toBe('ORIGINAL FIXTURE');
});
