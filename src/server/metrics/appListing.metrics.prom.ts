// App Store Listings (W13) — the prom-client half of the AppListing rollup's
// soft-degrade signal.
//
// WHY IT IS ITS OWN MODULE. `appListing.metrics.ts` (the processor) imports the
// heavy metric framework — clickhouse / db / redis clients via base.metrics — so a
// test that wanted to drive the REAL prom registry through it would have to boot or
// mock all of that first. `appListing.metrics.sql.ts` is dependency-free by
// contract and cannot import prom-client either. This module imports prom-client
// and nothing else, so the emitter is exercisable against the real default registry
// (the one `/api/metrics` scrapes) in a plain unit test. Same shape as
// app-block-runtime.metrics.ts, and tested the same way.
//
// prom-client GOTCHA: Next.js can import a module twice (hot reload / route
// bundling) and prom-client throws on a duplicate metric name, so the getter below
// is a get-or-create guard against the DEFAULT global registry.
import client, { type Counter, type Registry } from 'prom-client';

/**
 * Every run in which the `App_Open` play-DISCOVERY read could not be answered by
 * ClickHouse and the rollup degraded to "no new plays this run".
 *
 * 🔴 WHAT IT DISTINGUISHES, AND WHY A LOG LINE COULD NOT. The discovery read fails
 * SOFT by design (see `fetchRecentlyOpenedBlockIds`): on failure the rollup returns
 * an empty candidate set, so the play arm of the affected query does not fire and a
 * listing whose ONLY change is new plays is not recomputed. One run of that is
 * self-healing — the next run's watermark still covers the gap. A WEEK of it is a
 * silently frozen `open_count` on every app whose installs never move.
 *
 * The degraded state is by construction indistinguishable from "nobody played
 * anything": both produce an empty list and an unchanged column. So the only thing
 * that can tell a blip from a stuck rollup is the RATE of this counter over time,
 * which is exactly what a `logToAxiom({ type: 'warning' })` per run cannot express
 * as an alert. Alert on persistence, not on presence — e.g.
 * `increase(civitai_app_listing_open_discovery_degraded_total[1h])` staying at the
 * run rate, rather than on any single increment.
 *
 * 🔴 IT DOES NOT COUNT THE COUNT READ. `getAllTimeOpenCounts` fails HARD on purpose
 * and surfaces as a failed job; there is nothing to degrade and nothing to hide.
 * This counter is only ever incremented on the soft path.
 *
 * UNLABELLED, so a healthy pod that has loaded this module reports an observable 0
 * rather than `no data` (prom-client materialises an unlabelled counter's single
 * series at registration). Honest caveat, since an absent series is otherwise
 * ambiguous: the series exists on a pod only once the AppListing processor has been
 * loaded there, i.e. on the pool that actually runs metric jobs.
 */
const OPEN_DISCOVERY_DEGRADED = 'civitai_app_listing_open_discovery_degraded_total';

export type AppListingPromBundle = {
  openDiscoveryDegradedTotal: Counter<string>;
};

/** Get-or-create this module's metrics on `reg`, idempotently. */
export function ensureRegisterAppListingMetrics(
  reg: Registry = client.register
): AppListingPromBundle {
  const existing = reg.getSingleMetric(OPEN_DISCOVERY_DEGRADED) as Counter<string> | undefined;
  const openDiscoveryDegradedTotal =
    existing ??
    new client.Counter({
      name: OPEN_DISCOVERY_DEGRADED,
      help: 'AppListing metric runs whose ClickHouse App_Open play-discovery read failed, degrading that run to install_count only',
      registers: [reg],
    });
  return { openDiscoveryDegradedTotal };
}

/**
 * Fail-soft emit of one degraded discovery run.
 *
 * 🔴 TOTAL, like every emitter of its kind here. The thing it instruments is the
 * fallback path of a metric job: a metrics error (registry collision, a name
 * claimed elsewhere with a different labelset) must never propagate out of a
 * `catch` whose entire job is to keep `install_count` running through a ClickHouse
 * outage. Losing the count is survivable; converting a degrade into a failed run is
 * the regression the soft path exists to prevent.
 */
export function recordAppListingOpenDiscoveryDegrade(): void {
  try {
    ensureRegisterAppListingMetrics().openDiscoveryDegradedTotal.inc();
  } catch {
    /* instrument-only — never let a metrics error fail the run it is observing */
  }
}

// 🔴 EAGER REGISTRATION AT MODULE SCOPE, AND IT IS LOAD-BEARING RATHER THAN TIDY.
// Registration inside the emitter alone means the series does not exist until the
// FIRST degrade — so a healthy pod scrapes `no data`, which is exactly the ambiguity
// this counter was added to remove: absent reads as "nothing ever degraded" when it
// may equally mean "the instrument was never wired". Measured while writing the
// processor seam test: on a healthy run `getSingleMetric` returned undefined, not a
// 0. The processor imports this module, so this line is what makes the 0 real on any
// pod that runs the AppListing rollup.
//
// Guarded because it runs at module scope: the get-or-create's cast is unchecked, so
// if this name is ever claimed elsewhere with a different type, an unguarded throw
// here would break the IMPORT of the metric processor — a far worse outcome than a
// missing series.
try {
  ensureRegisterAppListingMetrics();
} catch {
  /* seeding is a readability nicety; losing it must not cost the module load */
}
