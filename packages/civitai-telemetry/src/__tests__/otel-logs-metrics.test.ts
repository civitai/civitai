import client from 'prom-client';
import { describe, expect, it } from 'vitest';

import { instrumentationRegistry, PROM_PREFIX } from '../client';
import {
  emitOtelLog,
  otelLogRecordsEmittedCounter,
  otelLogRecordsSkippedCounter,
} from '../otel-logs';

/**
 * WHERE the bridge's counters are registered, which is the whole reason they were absent
 * from production.
 *
 * The counters shipped on prom-client's DEFAULT registry. This module is only ever loaded
 * from `src/instrumentation.node.ts`, and `/api/metrics` is an API route — a different
 * bundler graph with a different default registry — so the counters incremented into a
 * registry nothing scrapes. Measured on a live pod: `/metrics` returned HTTP 200 with
 * 1,758 lines, 90 of them `nodejs_*` (so the endpoint was healthy and the scrape worked)
 * and ZERO `otel_log*`. The one instrument built to make the bridge's silence legible was
 * itself silent, which is why the 1.3% delivery rate had to be found by reconciling log
 * volumes by hand.
 *
 * `instrumentationRegistry` is pinned on `globalThis`, so it is the same object in every
 * graph, and `src/pages/api/metrics.ts` already merges it into the scrape response.
 *
 * These cases assert the WIRING (which registry), not the arithmetic. A test that only
 * checked `counter.inc()` moves a number would have passed throughout the outage.
 */

const EMITTED = `${PROM_PREFIX}otel_log_records_emitted_total`;
const SKIPPED = `${PROM_PREFIX}otel_log_records_skipped_total`;

/** Render exactly what a scrape of a registry would contain. */
const scrape = (registry: client.Registry) => registry.metrics();

describe('otel-logs counters — registry wiring', () => {
  it('registers BOTH counters on the cross-graph instrumentationRegistry', () => {
    expect(instrumentationRegistry.getSingleMetric(EMITTED)).toBe(otelLogRecordsEmittedCounter);
    expect(instrumentationRegistry.getSingleMetric(SKIPPED)).toBe(otelLogRecordsSkippedCounter);
  });

  it('THE REGRESSION: does NOT register them on the per-graph default registry', () => {
    // This is the assertion that would have failed on the shipped code. The default
    // registry is the one `/api/metrics` scrapes from the REQUEST graph; a counter that
    // lands there from the instrumentation graph is unreachable.
    expect(client.register.getSingleMetric(EMITTED)).toBeUndefined();
    expect(client.register.getSingleMetric(SKIPPED)).toBeUndefined();
  });

  it('POSITIVE CONTROL: an increment is visible in a scrape of the shared registry', async () => {
    // Proves the assertions above are about a LIVE instrument, not merely a registered
    // name: without this, a counter wired to a registry that renders nothing would still
    // satisfy every `getSingleMetric` check.
    const before = await scrape(instrumentationRegistry);
    expect(before).toContain(EMITTED);

    // The dark-launch path is the cheapest way to move a counter without a provider:
    // OTEL_LOGS_ENABLED is unset here, so this counts one `disabled` skip.
    delete process.env.OTEL_LOGS_ENABLED;
    const emitted = emitOtelLog('{"name":"registry-probe"}', { name: 'registry-probe' });
    expect(emitted).toBe(false);

    const after = await scrape(instrumentationRegistry);
    expect(after).toContain(`${SKIPPED}{reason="disabled"}`);

    // ...and the value actually moved, so this is not matching a zero-valued stub series.
    const value = Number(
      /^civitai_app_otel_log_records_skipped_total\{reason="disabled"\} (\d+)/m.exec(after)?.[1]
    );
    expect(value).toBeGreaterThan(0);
  });

  it('carries the civitai_app_ prefix, so the series name matches its siblings', () => {
    // Named explicitly because the fix moved the registration call, and a hand-rolled
    // `new Counter({name: 'otel_log_...'})` at the new site would silently drop the prefix
    // and rename the series out from under any dashboard or alert written against it.
    expect(EMITTED).toBe('civitai_app_otel_log_records_emitted_total');
    expect(SKIPPED).toBe('civitai_app_otel_log_records_skipped_total');
  });
});
