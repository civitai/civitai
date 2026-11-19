import {
  setRedisCommandHistogramBatchGate,
  setRedisInflightGaugeModeResolver,
} from '@civitai/telemetry/redis-command-metrics';
import { ensureFliptInitialized, FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';

/**
 * Arm the batched `redis_command_duration_seconds` handle behind the `redis-command-metrics-batched`
 * Flipt flag. Called once at boot from src/instrumentation.node.ts. The gate is read once per Redis
 * command, so it is the cached read (at most one Flipt evaluation per 5s); `null` (unknown flag,
 * Flipt not initialized) and a throw read as off, which observes straight into prom-client as before.
 */
export function registerRedisCommandMetricsBatchGate(): void {
  setRedisCommandHistogramBatchGate(
    createCachedFlagGate(readFliptSwitch(() => FLIPT_FEATURE_FLAGS.REDIS_COMMAND_METRICS_BATCHED))
  );
}

/**
 * Decide how `redis_commands_inflight` is counted, from the same `redis-command-metrics-batched`
 * flag: on, locally (set on the gauge at scrape); off, per-command prom-client inc/dec as before.
 *
 * Unlike the histogram, the gauge's mode is LATCHED: @civitai/telemetry reads the resolver installed
 * here once, at the process's first Redis command inc/dec, and never again, so every command's inc
 * and dec go through the same path. A flip of the flag therefore reaches the gauge only on a process
 * restart.
 *
 * Awaited at boot (src/instrumentation.node.ts) BEFORE the server takes traffic, so the resolver is
 * in place and Flipt initialized when the first command latches the mode. Flipt init is bounded by
 * its own init timeout and fails open; an uninitialized client, an unknown flag or a throw reads as
 * off. A command that latches before this resolves (none is expected at boot) latches `direct`.
 */
export async function armRedisInflightGaugeMode(): Promise<void> {
  try {
    await ensureFliptInitialized();
  } catch {
    // Fail open: the resolver below reads null and latches `direct`.
  }
  setRedisInflightGaugeModeResolver(
    () => isFliptSync(FLIPT_FEATURE_FLAGS.REDIS_COMMAND_METRICS_BATCHED) === true
  );
}
