import { setRedisCommandHistogramBatchGate } from '@civitai/telemetry/redis-command-metrics';
import {
  ensureFliptInitialized,
  FLIPT_FEATURE_FLAGS,
  getFliptClientSync,
  isFliptSync,
} from '~/server/flipt/client';
import { createCachedFlagGate } from '~/server/utils/otel-withspan-gate';

/**
 * Arm the batched `redis_command_duration_seconds` handle behind the `redis-command-metrics-batched`
 * Flipt flag. Called once at boot from src/instrumentation.node.ts. The gate is read once per Redis
 * command, so it is the cached read (at most one Flipt evaluation per 5s); `null` (unknown flag,
 * Flipt not initialized) and a throw read as off, which observes straight into prom-client as before.
 */
export function registerRedisCommandMetricsBatchGate(): void {
  setRedisCommandHistogramBatchGate(
    createCachedFlagGate(() => {
      const on = isFliptSync(FLIPT_FEATURE_FLAGS.REDIS_COMMAND_METRICS_BATCHED);
      // `isFliptSync` answers null until the client is initialized; start it rather than wait for
      // an unrelated async flag read to do so (as ~/server/redis/l1-switches does).
      if (on === null && !getFliptClientSync())
        void ensureFliptInitialized().catch(() => undefined);
      return on;
    })
  );
}
