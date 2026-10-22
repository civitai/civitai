export type RunResult<R> = { ok: true; value: R } | { ok: false; error: unknown };

/** A bounded pool: `enqueue` can be called again while it runs, so a retry shares the same limit. */
export function createRunner<T, R>(opts: {
  concurrency: number;
  worker: (item: T) => Promise<R>;
  onSettled: (item: T, result: RunResult<R>) => void;
}) {
  const waiting: T[] = [];
  const running = new Set<T>();
  let idleWaiters: (() => void)[] = [];

  function settleIdle() {
    if (waiting.length || running.size) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const wake of waiters) wake();
  }

  function pump() {
    while (running.size < opts.concurrency && waiting.length) {
      const item = waiting.shift() as T;
      running.add(item);
      void (async () => {
        let result: RunResult<R>;
        try {
          result = { ok: true, value: await opts.worker(item) };
        } catch (error) {
          result = { ok: false, error };
        }
        running.delete(item);
        try {
          opts.onSettled(item, result);
        } finally {
          pump();
          settleIdle();
        }
      })();
    }
  }

  return {
    enqueue(items: readonly T[]) {
      for (const item of items) if (!running.has(item) && !waiting.includes(item)) waiting.push(item);
      pump();
    },
    /** Drops what has not started and returns it; work already running is left to finish. */
    stop(): T[] {
      return waiting.splice(0);
    },
    idle: () =>
      new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        settleIdle();
      }),
  };
}

export type RuleRunStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed';

export function progressOf(statuses: Iterable<RuleRunStatus>) {
  const progress = { done: 0, failed: 0, remaining: 0, total: 0 };
  for (const status of statuses) {
    if (status === 'idle') continue;
    progress.total++;
    if (status === 'done') progress.done++;
    else if (status === 'failed') progress.failed++;
    else progress.remaining++;
  }
  return progress;
}
