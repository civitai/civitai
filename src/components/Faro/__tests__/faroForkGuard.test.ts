import { TracingInstrumentation } from '@grafana/faro-web-tracing';
import faroTracingPkg from '@grafana/faro-web-tracing/package.json';
import { describe, expect, it } from 'vitest';

/**
 * Fork guard for `SampledTracingInstrumentation`.
 *
 * `SampledTracingInstrumentation.initialize()` is a HAND-COPIED 1:1 fork of
 * `@grafana/faro-web-tracing`'s private `initialize()` (2.8.2 exposes no `sampler` option),
 * changing only the WebTracerProvider `sampler`. That fork can silently rot if faro-web-tracing
 * is bumped and its `initialize()` changes. These asserts FAIL LOUDLY on any version drift so
 * whoever bumps faro must diff upstream `initialize()` and re-sync the fork.
 *
 * On failure: open `src/components/Faro/SampledTracingInstrumentation.ts`, diff its
 * `initialize()` against the new faro-web-tracing `dist/.../instrumentation.js`, re-sync, then
 * update the pinned version here.
 */
const FORKED_FARO_TRACING_VERSION = '2.8.2';

describe('faro-web-tracing fork guard', () => {
  it('is pinned to the faro-web-tracing version the initialize() fork was copied from', () => {
    expect(
      faroTracingPkg.version,
      `SampledTracingInstrumentation.initialize() forks @grafana/faro-web-tracing@${FORKED_FARO_TRACING_VERSION}. ` +
        `Installed version is ${faroTracingPkg.version} — re-sync the fork against upstream initialize() before bumping this assertion.`
    ).toBe(FORKED_FARO_TRACING_VERSION);
  });

  it('preserves the SCHEDULED_BATCH_DELAY_MS constant the fork copied (1000ms)', () => {
    // The fork hardcodes this batch delay in its BatchSpanProcessor config. If upstream
    // changes it, the fork drifts from upstream export cadence.
    expect(TracingInstrumentation.SCHEDULED_BATCH_DELAY_MS).toBe(1000);
  });
});
