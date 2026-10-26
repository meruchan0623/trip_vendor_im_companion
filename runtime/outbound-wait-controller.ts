// outboundWaitController v1 — 三仓库逐字节同步，改动须同时更新 outboundWaitController.fixture.json
export interface OutboundWaitParams {
  minMs: number; maxMs: number; initialMs: number; stepUpMs: number; stepDownMs: number;
  settleMs: number; rateLimitHoldMs: number; staleAfterMs: number;
}
export const DEFAULT_OUTBOUND_WAIT_PARAMS: OutboundWaitParams = {
  minMs: 300, maxMs: 1000, initialMs: 800, stepUpMs: 150, stepDownMs: 50,
  settleMs: 600, rateLimitHoldMs: 60000, staleAfterMs: 1209600000,
};
export interface OutboundWaitBounds { enabled: boolean; minMs: number; maxMs: number }
// updatedAt uses clock.now()'s domain. Storage adapters must convert to/from wall time.
export interface OutboundWaitPersisted {
  v: 1; waitMs: number; updatedAt: number; sent: number; wasted: number; useful: number;
}
export type OutboundEditKind = 'typing' | 'instant';
export type OutboundResponseOutcome = 'shown' | 'superseded' | 'failed' | 'cancelled' | 'rate_limited';
export interface OutboundWaitSnapshot {
  waitMs: number; effectiveWaitMs: number; pending: boolean; composing: boolean;
  inFlightId: number | null; dueAt: number | null;
  sent: number; wasted: number; useful: number; neutral: number; failed: number;
  // Latest 256 numeric latency samples and total count; counted when shown becomes useful.
  usefulWaitMs: number[]; usefulWaitCount: number;
}
export interface OutboundWaitClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface OutboundWaitController {
  onCompositionStart(): void; onCompositionEnd(): void; onEdit(kind: OutboundEditKind): void;
  onRequestSent(id: number): void; onResponse(id: number, outcome: OutboundResponseOutcome): void;
  onDraftSent(): void; cancel(): void; applyBounds(bounds: OutboundWaitBounds | null): void;
  snapshot(): OutboundWaitSnapshot; persisted(): OutboundWaitPersisted; dispose(): void;
}
export function createOutboundWaitController(options: {
  clock: OutboundWaitClock; onDue: () => void;
  onPersist?: (state: OutboundWaitPersisted) => void;
  params?: Partial<OutboundWaitParams>; persisted?: OutboundWaitPersisted | null;
  bounds?: OutboundWaitBounds | null;
}): OutboundWaitController {
  const { clock } = options;
  const p = { ...DEFAULT_OUTBOUND_WAIT_PARAMS };
  for (const key of Object.keys(p) as (keyof OutboundWaitParams)[]) {
    const value = options.params?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) p[key] = value;
  }
  if (p.minMs > p.maxMs) { p.minMs = 300; p.maxMs = 1000; }
  const normalizeBounds = (b: OutboundWaitBounds | null | undefined): OutboundWaitBounds => (
    b && typeof b.enabled === 'boolean' && Number.isFinite(b.minMs) && Number.isFinite(b.maxMs)
    && b.minMs >= 100 && b.minMs <= b.maxMs && b.maxMs <= 3000
      ? { ...b } : { enabled: true, minMs: p.minMs, maxMs: p.maxMs }
  );
  let bounds = normalizeBounds(options.bounds);
  // A legal but disjoint remote range wins conservatively at its maximum.
  const range = () => {
    const low = Math.max(p.minMs, bounds.minMs);
    const high = Math.min(p.maxMs, bounds.maxMs);
    return low <= high ? [low, high] : [bounds.maxMs, bounds.maxMs];
  };
  const clamp = (value: number) => { const [low, high] = range(); return Math.max(low, Math.min(high, value)); };
  const saved = options.persisted;
  const validSaved = saved?.v === 1 && Number.isFinite(saved.updatedAt)
    && clock.now() >= saved.updatedAt && clock.now() - saved.updatedAt <= p.staleAfterMs
    && Number.isFinite(saved.waitMs) && [saved.sent, saved.wasted, saved.useful].every(
      value => Number.isSafeInteger(value) && value >= 0,
    );
  let waitMs = clamp(validSaved ? saved!.waitMs : p.initialMs);
  let sent = validSaved ? saved!.sent : 0;
  let wasted = validSaved ? saved!.wasted : 0;
  let useful = validSaved ? saved!.useful : 0;
  let neutral = 0;
  let failed = 0;
  let pending = false;
  let composing = false;
  let disposed = false;
  let dueAt: number | null = null;
  let lastEditAt: number | null = null;
  let pendingKind: OutboundEditKind = 'typing';
  let timer: unknown = null;
  let timerGeneration = 0;
  let inFlight: { id: number; editAt: number | null } | null = null;
  let shown: { timer: unknown; latency: number | null } | null = null;
  let rateLimitedUntil = -Infinity;
  const usefulWaitMs: number[] = [];
  let usefulWaitCount = 0;
  const held = () => !bounds.enabled || clock.now() < rateLimitedUntil;
  const effectiveWait = () => !bounds.enabled ? bounds.maxMs : clock.now() < rateLimitedUntil ? range()[1] : waitMs;
  const editWait = () => held() || pendingKind === 'typing' ? effectiveWait() : range()[0];
  const persisted = (): OutboundWaitPersisted => ({ v: 1, waitMs, updatedAt: clock.now(), sent, wasted, useful });
  const persist = () => options.onPersist?.(persisted());
  const clear = () => {
    timerGeneration++;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const adjust = (delta: number) => {
    if (held() || disposed) return;
    const next = clamp(waitMs + delta);
    if (next !== waitMs) { waitMs = next; persist(); }
  };
  const closeShown = (result: 'useful' | 'neutral' | 'none') => {
    const previous = shown;
    if (!previous) return;
    shown = null;
    clock.clearTimeout(previous.timer);
    if (result === 'useful') {
      useful++;
      if (previous.latency !== null) {
        usefulWaitCount++;
        usefulWaitMs.push(previous.latency);
        if (usefulWaitMs.length > 256) usefulWaitMs.shift();
      }
      adjust(-p.stepDownMs);
    } else if (result === 'neutral') neutral++;
  };
  const arm = () => {
    clear();
    if (disposed || !pending || composing || inFlight || dueAt === null) return;
    const generation = timerGeneration;
    timer = clock.setTimeout(() => {
      if (disposed || generation !== timerGeneration) return;
      timer = null;
      if (!pending || composing || inFlight) return;
      pending = false;
      dueAt = null;
      options.onDue();
    }, Math.max(0, dueAt - clock.now()));
  };
  return {
    onCompositionStart() {
      if (disposed) return;
      composing = true; clear(); closeShown('neutral');
    },
    onCompositionEnd() {
      if (disposed) return;
      composing = false;
      if (pending) { lastEditAt = clock.now(); pendingKind = 'typing'; dueAt = clock.now() + effectiveWait(); }
      arm();
    },
    onEdit(kind) {
      if (disposed) return;
      closeShown('neutral');
      pending = true; pendingKind = kind; lastEditAt = clock.now();
      dueAt = clock.now() + editWait(); arm();
    },
    onRequestSent(id) {
      if (disposed || inFlight || !Number.isSafeInteger(id)) return;
      inFlight = { id, editAt: lastEditAt }; sent++; clear();
    },
    onResponse(id, outcome) {
      if (disposed || inFlight?.id !== id) return;
      const request = inFlight;
      inFlight = null;
      if (outcome === 'superseded') { wasted++; adjust(p.stepUpMs); }
      else if (outcome === 'shown') {
        closeShown('none');
        const current = { timer: null as unknown, latency: request.editAt === null ? null : Math.max(0, clock.now() - request.editAt) };
        shown = current;
        current.timer = clock.setTimeout(() => { if (!disposed && shown === current) closeShown('useful'); }, p.settleMs);
      } else {
        failed++;
        if (outcome === 'rate_limited') {
          rateLimitedUntil = clock.now() + p.rateLimitHoldMs;
          if (pending) dueAt = Math.max(dueAt ?? 0, clock.now() + effectiveWait());
        }
      }
      arm();
    },
    onDraftSent() {
      if (disposed) return;
      pending = false; dueAt = null; clear(); closeShown('useful');
    },
    cancel() {
      if (disposed) return;
      pending = false; dueAt = null; clear(); closeShown('none');
    },
    applyBounds(b) {
      if (disposed) return;
      const nextBounds = normalizeBounds(b);
      if (bounds.enabled === nextBounds.enabled && bounds.minMs === nextBounds.minMs
        && bounds.maxMs === nextBounds.maxMs) return;
      bounds = nextBounds;
      const previous = waitMs;
      waitMs = clamp(waitMs);
      if (pending) dueAt = clock.now() + editWait();
      arm();
      if (previous !== waitMs) persist();
    },
    snapshot: () => ({ waitMs, effectiveWaitMs: effectiveWait(), pending, composing,
      inFlightId: inFlight?.id ?? null, dueAt, sent, wasted, useful, neutral, failed,
      usefulWaitMs: [...usefulWaitMs], usefulWaitCount }),
    persisted,
    dispose() {
      if (disposed) return;
      disposed = true; pending = false; dueAt = null; clear(); closeShown('none'); inFlight = null;
    },
  };
}
