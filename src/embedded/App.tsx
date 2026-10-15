import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompanionAPI } from '../shared/types';
import { EMPTY_WORKBENCH, OutboundWorkbench, type WorkbenchActions, type WorkbenchState } from './Workbench';
import { ReadOnlyOrderDetail } from './OrderDetail';

export interface RuntimeWorkbenchAPI {
  getState(): WorkbenchState;
  onState(listener: (state: WorkbenchState) => void): () => void;
  actions: WorkbenchActions;
  dispose(): Promise<void>;
}
export interface EmbeddedAppProps {
  /** Legacy bridge is deliberately not adapted to the outbound runtime contract. */
  api?: CompanionAPI;
  workbench?: RuntimeWorkbenchAPI;
  expanded: boolean;
  isExpanded(): boolean;
  onExpanded(value: boolean): boolean;
  registerCleanup?(cleanup: () => Promise<void>): (() => void) | void;
  onDetach?(): void;
  /** Set only by the runtime's validated order-open event, never by snapshots. */
  orderPresentation?: 'inline' | 'popover';
  onCloseOrder?(): void;
  orderNotice?: string;
}
export function EmbeddedApp({ workbench, expanded, onExpanded, registerCleanup, onDetach, orderPresentation = 'inline', onCloseOrder, orderNotice }: EmbeddedAppProps) {
  const [received, setReceived] = useState<{ provider?: RuntimeWorkbenchAPI; state: WorkbenchState }>(() => ({ provider: workbench, state: workbench?.getState() ?? EMPTY_WORKBENCH }));
  // An API replacement must never pair old preview data with new actions,
  // including the render before the new subscription effect has run.
  const state = received.provider === workbench ? received.state : EMPTY_WORKBENCH;
  const [notice, setNotice] = useState('');
  const cleanup = useRef<{ api: RuntimeWorkbenchAPI | undefined; task: Promise<void> } | undefined>(undefined);
  const dispose = useCallback(() => {
    if (cleanup.current && cleanup.current.api === workbench) return cleanup.current.task;
    const task = Promise.resolve().then(() => workbench?.dispose()).then(() => undefined);
    cleanup.current = { api: workbench, task };
    return task;
  }, [workbench]);
  useEffect(() => registerCleanup?.(dispose), [registerCleanup, dispose]);
  useEffect(() => {
    let active = true;
    setReceived({ provider: workbench, state: workbench?.getState() ?? EMPTY_WORKBENCH });
    const unsubscribe = workbench?.onState(next => { if (active) setReceived({ provider: workbench, state: next }); });
    return () => { active = false; unsubscribe?.(); void dispose().catch(() => {}); };
  }, [workbench, dispose]);
  useEffect(() => { if (!expanded) workbench?.actions.cancel(); }, [expanded, workbench]);
  function changeExpanded(value: boolean) {
    if (!value) workbench?.actions.cancel();
    if (!onExpanded(value)) setNotice('窗口空间不足，请调整原客户端窗口后再展开。'); else setNotice('');
  }
  if (orderPresentation === 'popover' && state.orderDetail) return <div className="panel order-only"><ReadOnlyOrderDetail detail={state.orderDetail} floating onClose={onCloseOrder ?? workbench?.actions.closeOrderDetail} /></div>;
  if (!expanded) return <div className="rail"><button aria-label="展开出站助手" onClick={() => changeExpanded(true)}>翻译 · 订单</button>{notice && <div className="rail-note" role="status">{notice}</div>}{orderNotice && <div className="rail-order-notice" role="status" title={orderNotice}>查询需加宽窗口</div>}{onDetach && <button className="rail-exit" aria-label="退出内嵌助手" onClick={onDetach}>×</button>}</div>;
  return <OutboundWorkbench state={state} actions={workbench?.actions} onCollapse={() => changeExpanded(false)} onDetach={onDetach} />;
}
