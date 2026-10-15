import { useState } from 'react';
import { ReadOnlyOrderDetail } from './OrderDetail';
import type { ComposerSnapshot } from '../shared/workbench';
export type { ComposerSnapshot } from '../shared/workbench';
export interface OutboundPreview {
  phase: 'empty' | 'waiting' | 'loading' | 'ready' | 'cancelled' | 'error';
  translatedText?: string;
  message?: string;
  snapshot?: ComposerSnapshot;
  target?: string;
}
export interface WorkbenchState {
  snapshot?: ComposerSnapshot;
  sourceVerified: boolean;
  serviceConnected: boolean;
  writeVerified: boolean;
  copyAvailable: boolean;
  target: string;
  auto: boolean;
  paused: boolean;
  delay: 400 | 800 | 1400;
  preview: OutboundPreview;
  orders: { id: string; label: string }[];
  orderQueryAvailable: boolean;
  orderStatus?: string;
  auth?: 'disconnected' | 'needs_login' | 'connecting' | 'ready' | 'failed';
  orderDetail?: { id: string; phase: 'loading' | 'ready' | 'failed' | 'needs_login'; source: string; ownership: string; status?: string; fields: { label: string; value: string }[]; message?: string };
  reason?: string;
}
export interface WorkbenchActions {
  setTarget(value: string): void;
  setAuto(value: boolean): void;
  setPaused(value: boolean): void;
  setDelay(value: 400 | 800 | 1400): void;
  cancel(): void;
  translateNow(): void;
  applyReviewedTranslation(snapshot: ComposerSnapshot, target: string): Promise<void>;
  copyReviewedTranslation(snapshot: ComposerSnapshot, target: string): Promise<void>;
  openOrderDetail(id: string): Promise<void>;
  closeOrderDetail?(): void;
  openLogin?(): Promise<void>;
}
export const EMPTY_WORKBENCH: WorkbenchState = {
  sourceVerified: false, serviceConnected: false, writeVerified: false, copyAvailable: false,
  target: 'en', auto: true, paused: false, delay: 800, preview: { phase: 'empty' },
  orders: [], orderQueryAvailable: false,
};
const LANGUAGES = [['zh', '中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['ru', 'Русский'], ['pt', 'Português'], ['it', 'Italiano'], ['ar', 'العربية'], ['th', 'ไทย']];
export function sameComposer(a: ComposerSnapshot | undefined, b: ComposerSnapshot | undefined): boolean {
  return !!a && !!b && Number.isSafeInteger(a.authGeneration) && !!a.editorIdentity && !!a.docFingerprint && a.text === b.text && a.conversationId === b.conversationId && a.revision === b.revision && a.scopeGeneration === b.scopeGeneration && a.authGeneration === b.authGeneration && a.editorIdentity === b.editorIdentity && a.docFingerprint === b.docFingerprint && a.isPlainText === b.isPlainText && !a.composing && !b.composing;
}

/** A view only: the runtime controller owns observation, translation and query fences.
 * No native DOM, vendor IPC, fetch or customer-send capability exists here. */
export function OutboundWorkbench({ state, actions, onCollapse, onDetach }: { state: WorkbenchState; actions?: WorkbenchActions; onCollapse(): void; onDetach?(): void }) {
  const [originalOpen, setOriginalOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{ snapshot: ComposerSnapshot; target: string; mode: 'apply' | 'copy' }>();
  const [actionError, setActionError] = useState('');
  const connected = !!actions && state.sourceVerified && state.serviceConnected;
  const ready = connected && state.preview.phase === 'ready' && !!state.preview.translatedText && state.preview.target === state.target && sameComposer(state.preview.snapshot, state.snapshot);
  const confirmCurrent = !!confirmation && ready && confirmation.target === state.target && sameComposer(confirmation.snapshot, state.snapshot);
  const busy = state.preview.phase === 'waiting' || state.preview.phase === 'loading';
  const run = async (task: () => Promise<void>, failureMessage = '操作未完成，请检查连接后重试。') => { setActionError(''); try { await task(); } catch { setActionError(failureMessage); } };
  const confirm = () => {
    if (!confirmCurrent || !confirmation || !actions || (confirmation.mode === 'apply' ? !state.writeVerified || state.snapshot?.isPlainText !== true : !state.copyAvailable)) { setConfirmation(undefined); return; }
    const reviewed = confirmation; setConfirmation(undefined);
    void run(() => reviewed.mode === 'apply' ? actions.applyReviewedTranslation(reviewed.snapshot, reviewed.target) : actions.copyReviewedTranslation(reviewed.snapshot, reviewed.target));
  };
  return <div className="panel workbench">
    <header className="head"><strong>出站翻译</strong><span className="state">{connected ? '草稿已连接' : '未连接'}</span><button aria-label="折叠助手" onClick={onCollapse}>›</button>{onDetach && <button className="exit" onClick={onDetach}>退出</button>}</header>
    <main className="scroll">
      {!connected && <p className="notice warn">{state.reason || '原草稿来源与翻译服务尚未验证，翻译和回填暂不可用。'}<br />原客户端可继续正常使用。</p>}
      {state.auth && state.auth !== 'ready' && <div className="notice"><span>{state.auth === 'connecting' ? '正在连接翻译与订单服务…' : state.auth === 'failed' ? '服务连接失败，请重新登录后重试。' : '请先登录 tsim_cs，认证仅用于翻译与订单查询。'}</span>{actions?.openLogin && <button disabled={state.auth === 'connecting'} onClick={() => void run(() => actions.openLogin!(), '登录页未能打开，请重新尝试。')}>打开登录</button>}</div>}
      <section className="card">
        <div className="card-head"><strong>中文草稿 → 译文预览</strong><span>原稿保持不变</span></div>
        <div className="body">
          <label className="field">目标语种<select aria-label="目标语种" value={state.target} onChange={event => { setConfirmation(undefined); actions?.setTarget(event.target.value); }} disabled={!actions}>{LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <div className="workbench-controls"><label className="check"><input type="checkbox" checked={state.auto} disabled={!actions} onChange={event => actions?.setAuto(event.target.checked)} />自动预览</label><select aria-label="翻译等待时间" value={state.delay} disabled={!actions} onChange={event => actions?.setDelay(Number(event.target.value) as 400 | 800 | 1400)}><option value="400">400 毫秒</option><option value="800">800 毫秒</option><option value="1400">1400 毫秒</option></select></div>
          <p className="footnote">默认英语，语种由你选择。仅中文草稿需要翻译时触发；中文输入法组合期间等待。</p>
          <button className="original-toggle" aria-expanded={originalOpen} onClick={() => setOriginalOpen(value => !value)}>原文 {originalOpen ? '收起' : '展开'}</button>
          {originalOpen && <div className="draft-original">{state.sourceVerified ? state.snapshot?.text || '原编辑器暂无草稿' : '原草稿来源未验证，不读取原编辑器。'}</div>}
          <div className="actions"><button className="primary" disabled={!connected || !state.snapshot?.text.trim() || !!state.snapshot?.composing || state.paused} onClick={() => actions?.translateNow()}>立即翻译</button><button disabled={!actions || !busy && !ready} onClick={() => { setConfirmation(undefined); actions?.cancel(); }}>取消本次</button><button disabled={!actions} onClick={() => actions?.setPaused(!state.paused)}>{state.paused ? '恢复此会话' : '暂停此会话'}</button></div>
        </div>
        <div className={`preview ${state.preview.phase === 'error' ? 'error' : ''}`} aria-live="polite">
          <small>译文预览</small>
          {ready ? <p>{state.preview.translatedText}</p> : <p>{state.preview.phase === 'loading' ? '正在翻译…' : state.preview.phase === 'waiting' ? '等待草稿输入完成…' : state.preview.phase === 'cancelled' ? '本次预览已取消，继续编辑后可重新翻译。' : state.preview.message || '译文将显示在这里。'}</p>}
          <div className="actions"><button disabled={!ready || !state.writeVerified || state.snapshot?.isPlainText !== true} onClick={() => state.snapshot && setConfirmation({ snapshot: { ...state.snapshot }, target: state.target, mode: 'apply' })}>确认回填原草稿</button><button disabled={!ready || !state.copyAvailable} onClick={() => state.snapshot && setConfirmation({ snapshot: { ...state.snapshot }, target: state.target, mode: 'copy' })}>复制译文</button></div>
          <p className="footnote">回填能力须单独验证。请在原客户端核对后自行发送。</p>
        </div>
      </section>
      <section className="card"><div className="card-head"><strong>订单查询</strong><span>点击订单 ID 查看详情</span></div><div className="body">{state.orders.length ? state.orders.map(order => <button className="order-link" key={order.id} disabled={!actions || !state.orderQueryAvailable} onClick={() => void run(() => actions!.openOrderDetail(order.id))}>{order.label} · {order.id}</button>) : <p className="status-line">尚无经过验证的订单 ID。</p>}<p className="status-line" aria-live="polite">{state.orderStatus || (!state.orderQueryAvailable ? '订单来源或查询认证未连接，暂不可查询。' : '仅查询订单详情，不发送客户消息。')}</p></div></section>
      {actionError && <p role="alert" className="notice warn">{actionError}</p>}
      {state.orderDetail && <ReadOnlyOrderDetail detail={state.orderDetail} onClose={actions?.closeOrderDetail} />}
    </main>
    {confirmation && <div className="copy-confirm"><dialog open className="dialog" aria-label="确认译文操作"><h2>{confirmation.mode === 'apply' ? '确认回填原草稿' : '确认复制译文'}</h2><p>{confirmCurrent ? `目标语种：${LANGUAGES.find(([value]) => value === confirmation.target)?.[1] ?? confirmation.target}。仅处理当前会话的这份草稿。` : '草稿、会话或语种已经变化，请关闭并重新核对译文。'}</p><div className="actions"><button onClick={() => setConfirmation(undefined)}>返回</button><button className="primary" disabled={!confirmCurrent || confirmation.mode === 'apply' && (!state.writeVerified || state.snapshot?.isPlainText !== true) || confirmation.mode === 'copy' && !state.copyAvailable} onClick={confirm}>确认{confirmation.mode === 'apply' ? '回填' : '复制'}</button></div></dialog></div>}
  </div>;
}
