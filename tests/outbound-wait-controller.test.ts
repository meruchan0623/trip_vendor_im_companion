import './outbound-wait-store.test';
import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../runtime/outbound-wait-controller.fixture.json';
import {createOutboundWaitController,type OutboundWaitClock,type OutboundWaitController,type OutboundWaitBounds,type OutboundWaitPersisted,type OutboundResponseOutcome} from '../runtime/outbound-wait-controller';
const fakeClock = () => {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: OutboundWaitClock = {
    now: () => now,
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id as number); },
  };
  const advanceTo = (target: number) => {
    let steps = 0;
    while (true) {
      const timer = [...timers].filter(([, item]) => item.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!timer) break;
      if (++steps > 10000) throw new Error('timer did not quiesce');
      now = timer[1].at; timers.delete(timer[0]); timer[1].fn();
    }
    now = target;
  };
  return { clock, advanceTo, count: () => timers.size };
};

describe('outbound wait shared fixtures', () => {
  for (const item of fixture.cases) it(item.name, () => {
    const fake = fakeClock();
    const due: number[] = [];
    const controller = createOutboundWaitController({
      clock: fake.clock, onDue: () => { due.push(fake.clock.now()); },
      params: { ...fixture.params, ...('params' in item ? item.params : {}) },
      persisted: ('persisted' in item ? item.persisted : null) as OutboundWaitPersisted | null,
    });
    const events = item.events.map((event) => ({ ...event, check: false }));
    const checkpoints = item.expect.waitAfter.map((check) => ({ ...check, check: true }));
    // At equal timestamps, drain timers first, then input events, then assertions.
    const timeline = [...events, ...checkpoints].sort((a, b) => a.t - b.t || Number(a.check) - Number(b.check));
    for (const point of timeline) {
      fake.advanceTo(point.t);
      if ('waitMs' in point) { assert.equal(controller.snapshot().waitMs,point.waitMs); continue; }
      if (!('type' in point)) continue;
      switch (point.type) {
        case 'edit': controller.onEdit(('kind' in point ? point.kind : 'typing') as 'typing' | 'instant'); break;
        case 'compositionStart': controller.onCompositionStart(); break;
        case 'compositionEnd': controller.onCompositionEnd(); break;
        case 'sent': controller.onRequestSent(('id' in point ? point.id : 0) as number); break;
        case 'response': controller.onResponse(('id' in point ? point.id : 0) as number, ('outcome' in point ? point.outcome : 'failed') as OutboundResponseOutcome); break;
        case 'draftSent': controller.onDraftSent(); break;
        case 'cancel': controller.cancel(); break;
        case 'bounds': controller.applyBounds(('bounds' in point ? point.bounds : null) as OutboundWaitBounds | null); break;
        case 'dispose': controller.dispose(); break;
        default: throw new Error(`unknown fixture event: ${point.type}`);
      }
    }
    fake.advanceTo((timeline[timeline.length - 1]?.t ?? 0) + 2000);
    assert.deepEqual(due,item.expect.due);
    Object.entries(item.expect.counters).forEach(([key,value])=>assert.deepEqual(controller.snapshot()[key as keyof ReturnType<OutboundWaitController['snapshot']>],value));
    controller.dispose();
    assert.equal(fake.count(),0);
  });
});
