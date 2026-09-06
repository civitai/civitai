import client from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ensureRegisterAppListingMetrics,
  recordAppListingOpenDiscoveryDegrade,
} from '../appListing.metrics.prom';

/**
 * The REAL prom-client side of the AppListing play-discovery degrade signal.
 *
 * 🔴 WHY THIS SIGNAL EXISTS AT ALL. `fetchRecentlyOpenedBlockIds` fails SOFT: when
 * ClickHouse cannot answer, the run recomputes `install_count` only and returns an
 * empty play-candidate set. That degraded state is by construction
 * INDISTINGUISHABLE from a quiet cycle — both produce an empty list and an
 * unchanged `open_count` — so "blipped once" and "dead for a week" look identical
 * from the outside. One Axiom warning per run cannot express that difference as an
 * alert; a counter's rate over time can.
 *
 * 🔴 WHY IT IS TESTED AGAINST THE REAL REGISTRY. A metric-name typo or a registry
 * the scrape does not read would produce an alert rule that silently never fires —
 * the same class of defect the counter exists to remove. So this file drives the
 * actual default registry that `/api/metrics` collects, rather than a spy.
 */

const METRIC = 'civitai_app_listing_open_discovery_degraded_total';

/**
 * 🔴 CAPTURED AT MODULE SCOPE, ON PURPOSE — this is the ONLY place the eager
 * registration is observable.
 *
 * ES imports are evaluated before this line, so this records the registry state
 * produced by NOTHING BUT importing the module. Every `it` below runs after a
 * `beforeEach` that removes the metric, and the first one to call the emitter
 * registers it again — so inside a test body "is it registered?" is answered by
 * whatever ran earlier in the file, not by the module. Measured: deleting the
 * module-scope `ensureRegisterAppListingMetrics()` call left the whole suite GREEN
 * until this capture existed.
 */
const REGISTERED_BY_IMPORT_ALONE = client.register.getSingleMetric(METRIC) !== undefined;

/** Read the counter's single (unlabelled) series from the default registry. */
async function read(): Promise<number> {
  const metric = client.register.getSingleMetric(METRIC) as
    | { get(): Promise<{ values: Array<{ value: number }> }> }
    | undefined;
  if (!metric) return Number.NaN;
  const { values } = await metric.get();
  return values[0]?.value ?? Number.NaN;
}

beforeEach(() => {
  // Full isolation, not `resetMetrics()`: two tests below deliberately re-register
  // the name (once absent, once with an incompatible TYPE), and `resetMetrics` only
  // zeroes values — it would leave those registrations standing for the next test.
  client.register.removeSingleMetric(METRIC);
});

describe(METRIC, () => {
  it('is registered on the DEFAULT registry — the one /api/metrics scrapes', () => {
    ensureRegisterAppListingMetrics();
    expect(client.register.getSingleMetric(METRIC)).toBeDefined();
  });

  it('🔴 is registered by IMPORTING the module — a never-degraded pod is 0, not absent', () => {
    // If registration only happened inside the emitter, the series would not exist
    // until the first degrade: a healthy pod would scrape `no data`, which reads as
    // "nothing ever degraded" but equally means "the instrument was never wired" —
    // precisely the ambiguity this counter exists to remove. The processor imports
    // this module, so import-time registration is what makes the 0 real in prod.
    expect(REGISTERED_BY_IMPORT_ALONE).toBe(true);
  });

  it('reports an observable 0 before anything degrades, not `no data`', async () => {
    // An absent series is ambiguous — it reads as "nothing ever went wrong" when it
    // may equally mean "nobody loaded the module". An unlabelled prom-client counter
    // materialises its single series at registration, which is what removes that.
    ensureRegisterAppListingMetrics();
    expect(await read()).toBe(0);
  });

  it('increments once per degraded run', async () => {
    ensureRegisterAppListingMetrics();
    expect(await read()).toBe(0);
    recordAppListingOpenDiscoveryDegrade();
    expect(await read()).toBe(1);
    recordAppListingOpenDiscoveryDegrade();
    recordAppListingOpenDiscoveryDegrade();
    expect(await read()).toBe(3);
  });

  it('registers itself when the emitter is the first caller', async () => {
    // The processor's onDegrade calls only the emitter — it never calls the
    // ensure-register helper first. If registration were left to some other module,
    // the very first degrade would be lost.
    client.register.removeSingleMetric(METRIC);
    expect(client.register.getSingleMetric(METRIC)).toBeUndefined();
    recordAppListingOpenDiscoveryDegrade();
    expect(await read()).toBe(1);
  });

  it('🔴 declares NO labels — persistence is read from the rate, attribution from the log', async () => {
    // Asserted against the DECLARED labelNames, not the emitted series: prom-client
    // omits a declared-but-never-supplied label from the output, so inspecting
    // `values[].labels` stays green while the metric is declared wide open. The
    // natural label here would be the ClickHouse error message — an unbounded
    // population that would blow the cardinality budget. It lives in the Axiom
    // warning instead.
    const metric = ensureRegisterAppListingMetrics().openDiscoveryDegradedTotal as unknown as {
      labelNames: string[];
    };
    expect([...metric.labelNames]).toEqual([]);

    recordAppListingOpenDiscoveryDegrade();
    const values = await (
      client.register.getSingleMetric(METRIC) as unknown as {
        get(): Promise<{ values: Array<{ labels: Record<string, string> }> }>;
      }
    ).get();
    expect(values.values).toHaveLength(1);
    expect(values.values[0].labels).toEqual({});
  });

  it('is get-or-create — a second import reuses the instance instead of throwing', () => {
    const first = ensureRegisterAppListingMetrics().openDiscoveryDegradedTotal;
    const second = ensureRegisterAppListingMetrics().openDiscoveryDegradedTotal;
    expect(second).toBe(first);
  });

  it('🔴 NEVER THROWS — a metrics failure must not fail the run it is observing', () => {
    // The emitter sits inside the catch that keeps `install_count` running through a
    // ClickHouse outage, so a registry collision must not convert a degrade into a
    // failed run. Claim the name with an INCOMPATIBLE type (a Histogram has
    // `observe`, not `inc`), so the get-or-create's unchecked cast hands the emitter
    // an object whose `.inc` is undefined.
    new client.Histogram({ name: METRIC, help: 'collision', registers: [client.register] });
    // Positive control: without this, a future prom-client where the collision does
    // NOT produce a throwing call site would make the assertion below vacuous.
    const claimed = client.register.getSingleMetric(METRIC) as unknown as { inc?: unknown };
    expect(typeof claimed.inc).toBe('undefined');

    expect(() => recordAppListingOpenDiscoveryDegrade()).not.toThrow();
  });
});
