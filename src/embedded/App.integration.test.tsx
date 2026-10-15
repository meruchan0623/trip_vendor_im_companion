// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EmbeddedApp, type RuntimeWorkbenchAPI } from './App';
import { EMPTY_WORKBENCH, type WorkbenchState } from './Workbench';

let node: HTMLDivElement, root: Root;
const snapshot = { text: 'TEST DRAFT A', conversationId: 'test-A', revision: 1, composing: false, scopeGeneration: 1, authGeneration: 1, editorIdentity: 'test-editor', docFingerprint: 'test-doc-A', isPlainText: true };
function provider(initial: WorkbenchState) {
  let state = initial;
  const listeners = new Set<(value: WorkbenchState) => void>();
  const abandoned: ((value: WorkbenchState) => void)[] = [];
  const actions = { setTarget: vi.fn(), setAuto: vi.fn(), setPaused: vi.fn(), setDelay: vi.fn(), cancel: vi.fn(), translateNow: vi.fn(), applyReviewedTranslation: vi.fn(async () => {}), copyReviewedTranslation: vi.fn(async () => {}), openOrderDetail: vi.fn(async () => {}), closeOrderDetail: vi.fn(), openLogin: vi.fn(async () => {}) };
  const api: RuntimeWorkbenchAPI = { getState: () => state, onState: listener => { listeners.add(listener); return () => { listeners.delete(listener); abandoned.push(listener); }; }, actions, dispose: vi.fn(async () => {}) };
  return { api, actions, publish(next: WorkbenchState) { state = next; listeners.forEach(listener => listener(next)); }, late(next: WorkbenchState) { abandoned.forEach(listener => listener(next)); } };
}
const readyState: WorkbenchState = { ...EMPTY_WORKBENCH, sourceVerified: true, serviceConnected: true, writeVerified: true, copyAvailable: true, auth: 'ready', snapshot, preview: { phase: 'ready', translatedText: 'TEST TRANSLATION A', snapshot, target: 'en' }, orders: [{ id: '000123', label: '旅游商家原编号（未转换）' }], orderQueryAvailable: true, orderDetail: { id: '000123', phase: 'ready', source: '旅游商家原编号（未转换）', ownership: 'tsim_cs 服务端权限核验', status: 'TEST STATUS A', fields: [] } };
function render(api: RuntimeWorkbenchAPI, expanded = true) { root.render(<EmbeddedApp workbench={api} expanded={expanded} isExpanded={() => expanded} onExpanded={() => true} />); }
async function click(label: string) { await act(async () => { const button = [...node.querySelectorAll('button')].find(item => item.textContent === label)!; expect(button).toBeTruthy(); button.click(); }); }
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; node = document.createElement('div'); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });

it('auth revocation removes old translation/order and invalidates an open review', async () => {
  const service = provider(readyState); await act(async () => render(service.api));
  await click('确认回填原草稿');
  await act(async () => service.publish({ ...EMPTY_WORKBENCH, auth: 'needs_login', reason: '认证已经失效' }));
  expect(node.textContent).not.toContain('TEST TRANSLATION A'); expect(node.textContent).not.toContain('TEST STATUS A'); expect(node.textContent).not.toContain('000123');
  await click('确认回填'); expect(service.actions.applyReviewedTranslation).not.toHaveBeenCalled();
  expect(node.textContent).toContain('请先登录 tsim_cs');
});
it('replacement provider cannot receive old account preview and late old events are ignored', async () => {
  const previous = provider(readyState), current = provider({ ...EMPTY_WORKBENCH, auth: 'needs_login' });
  await act(async () => render(previous.api)); await act(async () => render(current.api));
  await act(async () => previous.late(readyState));
  expect(node.textContent).not.toContain('TEST TRANSLATION A'); expect(node.textContent).not.toContain('000123');
  await click('确认回填原草稿'); expect(current.actions.applyReviewedTranslation).not.toHaveBeenCalled(); expect(previous.api.dispose).toHaveBeenCalledTimes(1);
});
it('login failure offers retry and success transitions without fake logged-in status', async () => {
  const service = provider({ ...EMPTY_WORKBENCH, auth: 'failed' }); await act(async () => render(service.api));
  expect(node.textContent).toContain('服务连接失败'); expect(node.textContent).not.toContain('草稿已连接');
  await click('打开登录'); expect(service.actions.openLogin).toHaveBeenCalledTimes(1);
  await act(async () => service.publish({ ...EMPTY_WORKBENCH, auth: 'connecting' }));
  expect(node.textContent).toContain('正在连接');
  await act(async () => service.publish(readyState)); expect(node.textContent).toContain('草稿已连接'); expect(node.textContent).toContain('TEST TRANSLATION A');
});
it('folding cancels preview while disposal stays idempotent', async () => {
  const service = provider(readyState); await act(async () => render(service.api));
  await act(async () => render(service.api, false)); expect(service.actions.cancel).toHaveBeenCalledTimes(1);
  expect(node.textContent).not.toContain('TEST TRANSLATION A'); expect(node.querySelector('textarea')).toBeNull();
});
it('ordinary detail snapshot never opens folded UI; controlled order event shows loading/results and close restores rail', async () => {
  const loading = { ...readyState, orderDetail: { ...readyState.orderDetail!, phase: 'loading' as const, fields: [] } };
  const service = provider(loading); let presentation: 'inline' | 'popover' = 'inline'; const close = vi.fn();
  const show = () => root.render(<EmbeddedApp workbench={service.api} expanded={false} isExpanded={() => false} onExpanded={() => false} orderPresentation={presentation} onCloseOrder={() => { close(); service.actions.closeOrderDetail(); presentation = 'inline'; show(); }} />);
  await act(async () => show()); expect(node.querySelector('[role="dialog"]')).toBeNull(); expect(node.textContent).not.toContain('000123');
  await act(async () => { presentation = 'popover'; show(); });
  expect(node.querySelector('[role="dialog"]')).not.toBeNull(); expect(node.textContent).toContain('正在查询订单详情'); expect(node.textContent).toContain('000123');
  await act(async () => service.publish(readyState)); expect(node.textContent).toContain('TEST STATUS A');
  await click('关闭'); expect(close).toHaveBeenCalledTimes(1); expect(service.actions.closeOrderDetail).toHaveBeenCalledTimes(1); expect(node.querySelector('[role="dialog"]')).toBeNull(); expect(node.textContent).toContain('翻译 · 订单');
});
it('auth loss removes controlled popover and a stale provider cannot reopen its old order', async () => {
  const previous = provider(readyState), next = provider({ ...EMPTY_WORKBENCH, auth: 'needs_login' });
  const show = (api: RuntimeWorkbenchAPI) => root.render(<EmbeddedApp workbench={api} expanded={false} isExpanded={() => false} onExpanded={() => false} orderPresentation="popover" />);
  await act(async () => show(previous.api)); expect(node.textContent).toContain('000123');
  await act(async () => previous.publish({ ...EMPTY_WORKBENCH, auth: 'needs_login' })); expect(node.querySelector('[role="dialog"]')).toBeNull(); expect(node.textContent).not.toContain('000123');
  await act(async () => show(next.api)); await act(async () => previous.late(readyState));
  expect(node.querySelector('[role="dialog"]')).toBeNull(); expect(node.textContent).not.toContain('TEST STATUS A');
});
it('unsafe narrow geometry notice is actually visible in rail without rendering old order results', async () => {
  const service = provider(readyState);
  await act(async () => root.render(<EmbeddedApp workbench={service.api} expanded={false} isExpanded={() => false} onExpanded={() => false} orderNotice="没有不遮挡编辑器的空间，请加宽窗口后查询。" />));
  expect(node.textContent).toContain('查询需加宽窗口'); expect(node.textContent).not.toContain('TEST STATUS A');
});
