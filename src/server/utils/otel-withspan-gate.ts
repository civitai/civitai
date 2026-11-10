import { setWithSpanSkipUnsampledGate } from '@civitai/telemetry/otel-helpers';
import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';

/** How long one read of the flag is reused. A flip takes effect within this window. */
export const WITHSPAN_GATE_REFRESH_MS = 5_000;

/**
 * Wrap a synchronous flag read so it runs at most once per `refreshMs`. `withSpan` consults the
 * gate on every call that has an unsampled parent — several times per request — so even the
 * Flipt eval-cache lookup (a key build plus a map read) is paid once per window instead.
 * `null` (unknown flag, or Flipt not initialized yet) and any throw read as OFF.
 */
export function createCachedFlagGate(
  read: () => boolean | null,
  refreshMs: number = WITHSPAN_GATE_REFRESH_MS,
  now: () => number = Date.now
): () => boolean {
  let value = false;
  let expiresAt = Number.NEGATIVE_INFINITY;
  return () => {
    const t = now();
    if (t >= expiresAt) {
      try {
        value = read() === true;
      } catch {
        value = false;
      }
      expiresAt = t + refreshMs;
    }
    return value;
  };
}

/**
 * Arm `withSpan`'s unsampled-parent shortcut behind the `otel-withspan-skip-unsampled` Flipt
 * flag. Called once at boot from src/instrumentation.node.ts, only when the OTel SDK is started
 * (without the SDK there is no sampled/unsampled distinction to act on).
 */
export function registerWithSpanSkipUnsampledGate(): void {
  setWithSpanSkipUnsampledGate(
    createCachedFlagGate(() => isFliptSync(FLIPT_FEATURE_FLAGS.OTEL_WITHSPAN_SKIP_UNSAMPLED))
  );
}
