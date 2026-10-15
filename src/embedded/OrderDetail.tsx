import type { WorkbenchState } from './Workbench';
type Detail = NonNullable<WorkbenchState['orderDetail']>;
export function ReadOnlyOrderDetail({ detail, onClose, floating = false }: { detail: Detail; onClose?(): void; floating?: boolean }) {
  const occurrences = new Map<string, number>();
  const fields = detail.fields.map(field => {
    const identity = JSON.stringify([field.label, field.value]);
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return { ...field, key: `${identity}:${occurrence}` };
  });
  return <section className={`card order-detail${floating ? ' order-popover' : ''}`} role={floating ? 'dialog' : undefined} aria-label="只读订单详情">
    <div className="card-head"><strong>订单 · {detail.id}</strong><button onClick={onClose} disabled={!onClose} aria-label="关闭订单详情">关闭</button></div>
    <div className="body"><p className="status-line">来源：{detail.source}<br />归属：{detail.ownership}</p>
      {detail.phase === 'ready' ? <><p className="status-line">状态：{detail.status || '未知'}</p><dl>{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl></> : <p className="status-line" aria-live="polite">{detail.phase === 'loading' ? '正在查询订单详情…' : detail.phase === 'needs_login' ? '查询需要登录，请先完成 tsim_cs 登录。' : detail.message || '订单查询失败，请稍后重试。'}</p>}
      <p className="footnote">只读详情，不提供发送、退款或取消订单操作。</p>
    </div>
  </section>;
}
