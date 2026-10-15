// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EMPTY_WORKBENCH, OutboundWorkbench, type ComposerSnapshot, type WorkbenchActions, type WorkbenchState } from './Workbench';

let node: HTMLDivElement, root: Root;
const snapshot = { text: '测试草稿', conversationId: 'test-conversation', revision: 1, composing: false, scopeGeneration: 2, isPlainText: true, authGeneration: 1, editorIdentity: 'test-editor', docFingerprint: 'test-json-fingerprint' };
let state: WorkbenchState, actions: WorkbenchActions;
function render() { root.render(<OutboundWorkbench state={state} actions={actions} onCollapse={() => {}} />); }
async function click(text: string) { await act(async () => { const target = [...node.querySelectorAll('button')].find(item => item.textContent === text); if (!target) throw new Error(`Missing ${text}`); target.click(); }); }
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  state = { ...EMPTY_WORKBENCH, sourceVerified: true, serviceConnected: true, writeVerified: true, copyAvailable: true, snapshot, preview: { phase: 'ready', translatedText: 'TEST TRANSLATION', target: 'en', snapshot } };
  actions = { setTarget: vi.fn(), setAuto: vi.fn(), setPaused: vi.fn(), setDelay: vi.fn(), cancel: vi.fn(), translateNow: vi.fn(), applyReviewedTranslation: vi.fn(async () => {}), copyReviewedTranslation: vi.fn(async () => {}), openOrderDetail: vi.fn(async () => {}) };
  await act(async () => render());
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });

it('only outbound preview and order query exist; no inbound import or send button', () => {
  expect(node.querySelector('textarea')).toBeNull();
  expect(node.textContent).not.toContain('入站');
  expect([...node.querySelectorAll('button')].some(button => /发送|发翻译/.test(button.textContent ?? ''))).toBe(false);
  expect(node.textContent).toContain('原稿保持不变');
});
it('a changed draft during review disables apply and does not call write', async () => {
  await click('确认回填原草稿');
  state = { ...state, snapshot: { ...snapshot, revision: 2, text: '新的草稿' } };
  await act(async () => render()); await click('确认回填');
  expect(actions.applyReviewedTranslation).not.toHaveBeenCalled();
  expect(node.textContent).toContain('已经变化');
});
it('language or scope changes cannot use an old translation', async () => {
  state = { ...state, target: 'ja', snapshot: { ...snapshot, scopeGeneration: 3 } };
  await act(async () => render()); await click('确认回填原草稿');
  expect(node.querySelector('dialog')).toBeNull();
  expect(node.textContent).not.toContain('TEST TRANSLATION');
});
it('IME does not permit translate or confirmation of an earlier result', async () => {
  state = { ...state, snapshot: { ...snapshot, composing: true } };
  await act(async () => render()); await click('立即翻译'); await click('确认回填原草稿');
  expect(actions.translateNow).not.toHaveBeenCalled(); expect(actions.applyReviewedTranslation).not.toHaveBeenCalled();
});
it('unverified composer/service/write capabilities stay disabled', async () => {
  state = { ...EMPTY_WORKBENCH }; await act(async () => render());
  await click('立即翻译'); await click('确认回填原草稿');
  expect(actions.translateNow).not.toHaveBeenCalled(); expect(actions.applyReviewedTranslation).not.toHaveBeenCalled();
  expect(node.textContent).toContain('尚未验证');
});
it('explicit reviewed operation sends the exact snapshot and preserves string order IDs', async () => {
  await click('确认回填原草稿'); await click('确认回填');
  expect(actions.applyReviewedTranslation).toHaveBeenCalledWith(snapshot, 'en');
  state = { ...state, orderQueryAvailable: true, orders: [{ id: '0000123', label: '订单' }] };
  await act(async () => render()); await click('订单 · 0000123');
  expect(actions.openOrderDetail).toHaveBeenCalledWith('0000123');
});
it('order detail is read-only and preserves source/ownership even on login failure', async () => {
  state = { ...state, orderDetail: { id: '0000123', phase: 'needs_login', source: 'TEST VERIFIED ORDER SOURCE', ownership: 'TEST ACCOUNT', fields: [] } };
  await act(async () => render());
  expect(node.textContent).toContain('TEST VERIFIED ORDER SOURCE'); expect(node.textContent).toContain('TEST ACCOUNT');
  expect(node.textContent).toContain('查询需要登录');
  expect([...node.querySelectorAll('button')].some(button => /发送|退款|取消订单/.test(button.textContent ?? ''))).toBe(false);
});
it('revoked write capability blocks an already-open confirmation', async () => {
  await click('确认回填原草稿'); state = { ...state, writeVerified: false };
  await act(async () => render()); await click('确认回填'); expect(actions.applyReviewedTranslation).not.toHaveBeenCalled();
});
it('absent plain text verification or absent identity cannot enable write', async () => {
  const noProof = { ...snapshot, isPlainText: undefined } as unknown as ComposerSnapshot;
  state = { ...state, snapshot: noProof, preview: { ...state.preview, snapshot: noProof } };
  await act(async () => render()); await click('确认回填原草稿'); expect(actions.applyReviewedTranslation).not.toHaveBeenCalled(); expect(node.querySelector('dialog')).toBeNull();
  const noIdentity = { ...snapshot, editorIdentity: undefined } as unknown as ComposerSnapshot;
  state = { ...state, snapshot: noIdentity, preview: { ...state.preview, snapshot: noIdentity } };
  await act(async () => render()); await click('复制译文'); expect(actions.copyReviewedTranslation).not.toHaveBeenCalled(); expect(node.querySelector('dialog')).toBeNull();
});
it.each(['authGeneration', 'editorIdentity', 'docFingerprint'] as const)('changed %s with identical text invalidates preview', async field => {
  const changed = { ...snapshot, [field]: field === 'authGeneration' ? 2 : 'changed-proof' };
  state = { ...state, snapshot: changed };
  await act(async () => render()); await click('确认回填原草稿'); await click('复制译文');
  expect(actions.applyReviewedTranslation).not.toHaveBeenCalled(); expect(actions.copyReviewedTranslation).not.toHaveBeenCalled(); expect(node.textContent).not.toContain('TEST TRANSLATION');
});
