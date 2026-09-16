import client from 'prom-client';
import { PROM_PREFIX } from '@civitai/telemetry/client';

/**
 * WHICH SOURCE ACTUALLY SERVED A WINDOWED App-Blocks COLLECTION REQUEST.
 *
 * ## Why this exists
 *
 * `GET /api/v1/blocks/collections?period=…` answers 200 with a full grid of
 * collections whether ClickHouse ranked them or the request quietly fell back to the
 * all-time Postgres ordering. From outside the service those two responses differ by
 * ONE optional string in a body that needs a block JWT to fetch at all — so "the
 * popular-this-month tab is serving all-time" was, for the whole of 2026-09-11,
 * answerable only by reading a user's browser network tab.
 *
 * 🔴 AND FOUR OF THE FIVE FALLBACK REASONS EMITTED NO SERVER-SIDE SIGNAL WHATSOEVER.
 * Only `clickhouse-error` logged (`block-collection-ranking-degraded`, in
 * `~/server/services/blocks/block-collection-popularity.service`). `empty-window`,
 * `clickhouse-disabled` and the two period-ignored reasons wrote nothing anywhere, so
 * a flat absence of degrade logs was indistinguishable from a healthy feed — which is
 * exactly the inference that cost an hour of the investigation that produced this
 * file. A counter that increments on EVERY windowed request, success included, cannot
 * be read that way: a zero in the `clickhouse` series is a positive statement.
 *
 * ## The signal
 *
 * `civitai_app_block_collection_ranking_total{period, source, reason}` — one
 * increment per request that SUPPLIED a `period`, labelled with what served it.
 *
 *   - `source` is `clickhouse` (the windowed ranking was used) or `postgres`
 *     (the pre-existing all-time ordering was used instead).
 *   - `reason` is `none` on the ClickHouse path, and otherwise names WHY Postgres
 *     served it: `clickhouse-disabled`, `clickhouse-error`, `empty-window`,
 *     `all-time-served-from-postgres`, `period-ignored-outside-public-discovery`,
 *     `period-ignored-for-non-popularity-sort`.
 *
 * Bounded by construction: `period` is a validated `MetricTimeframe` (5 values) and
 * `reason` comes from a closed set, so the series count cannot grow with traffic.
 *
 * 🔴 TWO OF THE `reason` VALUES ARE NOT FAULTS AND MUST NOT BE ALERTED ON.
 * `all-time-served-from-postgres` is the designed answer for `period=AllTime` (the
 * ClickHouse history begins 2025-11-06, so it has no all-time to give), and the two
 * `period-ignored-*` values are a caller sending a period where it cannot apply. The
 * fault signature is `reason` in {`clickhouse-error`, `clickhouse-disabled`,
 * `empty-window`} against a WINDOWED `period` — i.e. anything but `AllTime`.
 *
 * ## What it cannot see
 *
 * A request that never supplied a `period` at all. That is deliberate: such a request
 * takes the code path that existed before the parameter did, and counting it here
 * would put the endpoint's whole legacy traffic into a denominator that is not about
 * ranking.
 *
 * Pinned on globalThis so an HMR re-eval / a second request-graph eval reuse the one
 * instance instead of throwing prom-client's duplicate-registration error (the same
 * trap documented on the store-scope and http-error counters).
 */

declare global {
  // eslint-disable-next-line no-var
  var __civitaiBlockCollectionRankingMetrics: { ranking: client.Counter<string> } | undefined;
}

const metrics =
  globalThis.__civitaiBlockCollectionRankingMetrics ??
  (globalThis.__civitaiBlockCollectionRankingMetrics = {
    ranking: new client.Counter({
      name: PROM_PREFIX + 'block_collection_ranking_total',
      help:
        'Cumulative App-Blocks collection-discovery requests that supplied a `period`, by the ' +
        'requested period, the source that actually served them (clickhouse|postgres) and, for ' +
        'a Postgres answer, the reason. `reason="none"` is the ClickHouse path. Monotonic; use ' +
        'rate(). A windowed period (anything but AllTime) served from postgres with reason ' +
        'clickhouse-error / clickhouse-disabled / empty-window is the degraded state the app ' +
        'renders as "ranking isn\'t available right now".',
      labelNames: ['period', 'source', 'reason'],
    }),
  });

/**
 * Record which source served one windowed-discovery request.
 *
 * `reason` is recorded as the literal `none` when absent, never omitted: a label that
 * sometimes disappears splits one series in two and makes `sum by (source)` disagree
 * with itself across a deploy.
 *
 * Never throws — telemetry must not be able to fail the read it observes.
 */
export function recordBlockCollectionRankingSource({
  period,
  source,
  reason,
}: {
  period: string;
  source: 'clickhouse' | 'postgres';
  reason?: string;
}): void {
  try {
    metrics.ranking.inc({ period, source, reason: reason ?? 'none' });
  } catch {
    /* never throw from telemetry */
  }
}
