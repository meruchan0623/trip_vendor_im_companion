type ScheduleFollow = (callback: () => void) => () => void;

const scheduleImmediate: ScheduleFollow = callback => {
  const handle = setImmediate(callback);
  return () => clearImmediate(handle);
};

/** Coalesces geometry bursts; follow reads the caller's current window state. */
export function createWindowFollowScheduler(
  follow: (restack: boolean) => void,
  schedule: ScheduleFollow = scheduleImmediate,
) {
  let pending: { cancel: () => void } | undefined;
  let disposed = false;

  function cancel(): void {
    const previous = pending;
    pending = undefined;
    previous?.cancel();
  }

  return {
    scheduleGeometry(): void {
      if (disposed || pending) return;
      const job = { cancel: () => {} };
      pending = job;
      job.cancel = schedule(() => {
        // Cancellation also invalidates callbacks already handed to the loop.
        if (disposed || pending !== job) return;
        pending = undefined;
        follow(false);
      });
    },
    flushContext(): void {
      if (disposed) return;
      cancel();
      follow(true);
    },
    cancel,
    dispose(): void {
      disposed = true;
      cancel();
    },
  };
}
