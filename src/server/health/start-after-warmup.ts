// The boot sequence instrumentation.node.ts runs for the route warmer and the dependency-health
// metrics loop, taken out so it can be tested. It takes the two modules as (dynamic-import)
// promises so instrumentation.node.ts keeps them out of its static graph, and so a test can pass
// fakes. Type-only imports here: this module must not pull either one in.
import type * as MetricsLoopModule from '~/server/health/metrics-loop';
import type * as WarmupModule from '~/server/warmup';

type Warmup = Pick<typeof WarmupModule, 'runWarmup' | 'isWarm'>;
type MetricsLoop = Pick<typeof MetricsLoopModule, 'startHealthMetricsLoopWhenWarm'>;

/**
 * Kick the warmer (fire-and-forget) and start the metrics loop once the pod is WARM: the loop
 * waits on the warm flag (`isWarm`), never on `runWarmup()` resolving, which a hung warm request
 * can delay indefinitely. If the warmer module fails to load, the loop starts at once. Never
 * rejects; failures are logged and boot carries on.
 */
export function startWarmupAndHealthMetricsLoop({
  warmup,
  metricsLoop,
  logError = console.error,
}: {
  warmup: Promise<Warmup>;
  metricsLoop: Promise<MetricsLoop>;
  logError?: (message: string, err: unknown) => void;
}): Promise<void> {
  void warmup
    .then((m) => m.runWarmup())
    .catch((err) => {
      logError('[instrumentation.node] warmup kick failed (fail-open):', err);
    });
  return Promise.all([metricsLoop, warmup.catch(() => null)])
    .then(([loop, w]) => {
      loop.startHealthMetricsLoopWhenWarm(w ? w.isWarm : () => true);
    })
    .catch((err) => {
      logError('[instrumentation.node] health metrics loop start failed (fail-open):', err);
    });
}
