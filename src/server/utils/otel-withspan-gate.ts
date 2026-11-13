import { setWithSpanSkipUnsampledGate } from '@civitai/telemetry/otel-helpers';
import {
  ensureFliptInitialized,
  FLIPT_FEATURE_FLAGS,
  getFliptClientSync,
  isFliptSync,
} from '~/server/flipt/client';
import { CACHED_FLAG_GATE_REFRESH_MS, createCachedFlagGate } from '~/server/utils/cached-flag-gate';

// `createCachedFlagGate` lives in its own import-free module so client-reachable code can use it;
// re-exported here for the existing importers.
export { createCachedFlagGate };

/** How long one read of the flag is reused. A flip takes effect within this window. */
export const WITHSPAN_GATE_REFRESH_MS = CACHED_FLAG_GATE_REFRESH_MS;

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
