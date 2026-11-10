import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { HookPool } from './pool.ts';

/**
 * The runner's Prometheus metrics, on their own registry (served on the metrics port, never on
 * the request port). `app` is a blockId and `collection` a collection name: both bounded by the
 * set of apps that declare hooks, and only a signed caller can supply them.
 */
export function createMetrics() {
  const registry = new Registry();

  const calls = new Counter({
    name: 'storage_hook_runner_calls_total',
    help: 'Hook evaluations by result outcome (allow, deny, or an author-fault cause).',
    labelNames: ['app', 'collection', 'op', 'outcome'],
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'storage_hook_runner_call_duration_seconds',
    help: 'Wall time of one hook evaluation inside its worker, by outcome.',
    labelNames: ['outcome'],
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  });
  const sigRejected = new Counter({
    name: 'storage_hook_runner_sig_rejected_total',
    help: 'Requests refused 401: bad signature or a timestamp outside the skew window.',
    labelNames: ['reason'],
    registers: [registry],
  });
  const refused = new Counter({
    name: 'storage_hook_runner_requests_refused_total',
    help: 'Requests refused with a non-2xx error (bad request, sha mismatch, overload, worker faults). `app` is empty until the request is authenticated and validated.',
    labelNames: ['reason', 'app'],
    registers: [registry],
  });
  const workerTerminated = new Counter({
    name: 'storage_hook_runner_worker_terminated_total',
    help: 'Workers terminated by the backstop (a call outran timeoutMs + backstop), by app.',
    labelNames: ['app'],
    registers: [registry],
  });

  let pool: HookPool | null = null;
  new Gauge({
    name: 'storage_hook_runner_pool_workers',
    help: 'Pool workers by state.',
    labelNames: ['state'],
    registers: [registry],
    collect() {
      if (!pool) return;
      const s = pool.stats();
      this.set({ state: 'ready' }, s.ready);
      this.set({ state: 'busy' }, s.busy);
    },
  });
  new Gauge({
    name: 'storage_hook_runner_queue_depth',
    help: 'Calls waiting for a free worker.',
    registers: [registry],
    collect() {
      if (pool) this.set(pool.stats().queued);
    },
  });

  return {
    registry,
    calls,
    duration,
    sigRejected,
    refused,
    workerTerminated,
    attachPool(p: HookPool) {
      pool = p;
    },
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
