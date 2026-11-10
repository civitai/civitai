import { setWithSpanSkipUnsampledGate } from '@civitai/telemetry/otel-helpers';
import {
  ensureFliptInitialized,
  FLIPT_FEATURE_FLAGS,
  getFliptClientSync,
  isFliptSync,
} from '~/server/flipt/client';

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

type FlagKey = (typeof FLIPT_FEATURE_FLAGS)[keyof typeof FLIPT_FEATURE_FLAGS];

/**
 * A synchronous read of a global boolean Flipt switch, for `createCachedFlagGate`. `isFliptSync`
 * answers null until the client is initialized; the read starts it rather than wait for an
 * unrelated async flag read to do so. `flag` is a thunk so nothing touches the Flipt module before
 * the first read (a test mock without the key then reads as off, via the gate's throw handling).
 */
export function readFliptSwitch(flag: () => FlagKey): () => boolean | null {
  return () => {
    const on = isFliptSync(flag());
    if (on === null && !getFliptClientSync()) void ensureFliptInitialized().catch(() => undefined);
    return on;
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
