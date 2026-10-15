import { describe, expect, it, vi } from 'vitest';
import { createWindowFollowScheduler } from '../electron/window-follow-scheduler';

function manualScheduler() {
  const jobs: { callback: () => void; cancelled: boolean }[] = [];
  return {
    jobs,
    schedule(callback: () => void) {
      const job = { callback, cancelled: false };
      jobs.push(job);
      return () => { job.cancelled = true; };
    },
    tick() {
      for (const job of jobs.splice(0)) if (!job.cancelled) job.callback();
    },
  };
}

describe('window follow scheduler', () => {
  it('coalesces 120 same-tick moves and reads only the latest position', () => {
    const clock = manualScheduler();
    let latest = 0;
    const positions: number[] = [];
    const follow = vi.fn(() => { positions.push(latest); });
    const scheduler = createWindowFollowScheduler(follow, clock.schedule);
    for (let position = 1; position <= 120; position++) {
      latest = position;
      scheduler.scheduleGeometry();
    }
    expect(clock.jobs).toHaveLength(1);
    expect(follow).not.toHaveBeenCalled();
    clock.tick();
    expect(positions).toEqual([120]);
    expect(follow).toHaveBeenCalledWith(false);
  });

  it('follows each move when moves arrive in separate ticks', () => {
    const clock = manualScheduler();
    const follow = vi.fn();
    const scheduler = createWindowFollowScheduler(follow, clock.schedule);
    for (let tick = 0; tick < 3; tick++) {
      scheduler.scheduleGeometry();
      clock.tick();
    }
    expect(follow.mock.calls).toEqual([[false], [false], [false]]);
  });

  it('flushes context immediately and invalidates a previously queued geometry callback', () => {
    const clock = manualScheduler();
    const follow = vi.fn();
    const scheduler = createWindowFollowScheduler(follow, clock.schedule);
    scheduler.scheduleGeometry();
    const staleCallback = clock.jobs[0].callback;
    scheduler.flushContext();
    expect(clock.jobs[0].cancelled).toBe(true);
    expect(follow.mock.calls).toEqual([[true]]);
    scheduler.scheduleGeometry();
    staleCallback();
    expect(follow).toHaveBeenCalledTimes(1);
    clock.tick();
    expect(follow.mock.calls).toEqual([[true], [false]]);
  });

  it('cancels queued work while allowing a fresh geometry request', () => {
    const clock = manualScheduler();
    const follow = vi.fn();
    const scheduler = createWindowFollowScheduler(follow, clock.schedule);
    scheduler.scheduleGeometry();
    const staleCallback = clock.jobs[0].callback;
    scheduler.cancel();
    scheduler.cancel();
    staleCallback();
    clock.tick();
    expect(follow).not.toHaveBeenCalled();
    scheduler.scheduleGeometry();
    clock.tick();
    expect(follow.mock.calls).toEqual([[false]]);
  });

  it('disposes permanently without replaying queued work or flushing future context', () => {
    const clock = manualScheduler();
    const follow = vi.fn();
    const scheduler = createWindowFollowScheduler(follow, clock.schedule);
    scheduler.scheduleGeometry();
    const staleCallback = clock.jobs[0].callback;
    scheduler.dispose();
    scheduler.dispose();
    scheduler.scheduleGeometry();
    scheduler.flushContext();
    staleCallback();
    clock.tick();
    expect(follow).not.toHaveBeenCalled();
    expect(clock.jobs).toHaveLength(0);
  });

  it('keeps a geometry request made during follow for the next tick', () => {
    const clock = manualScheduler();
    const follow = vi.fn(() => { scheduler.scheduleGeometry(); });
    const scheduler = createWindowFollowScheduler(follow, clock.schedule);
    scheduler.scheduleGeometry();
    clock.tick();
    expect(follow).toHaveBeenCalledTimes(1);
    expect(clock.jobs).toHaveLength(1);
    clock.tick();
    expect(follow).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('uses a cancellable setImmediate by default', () => {
    vi.useFakeTimers();
    try {
      const follow = vi.fn();
      const scheduler = createWindowFollowScheduler(follow);
      scheduler.scheduleGeometry();
      scheduler.scheduleGeometry();
      vi.runAllTimers();
      expect(follow.mock.calls).toEqual([[false]]);
      scheduler.scheduleGeometry();
      scheduler.flushContext();
      vi.runAllTimers();
      expect(follow.mock.calls).toEqual([[false], [true]]);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
