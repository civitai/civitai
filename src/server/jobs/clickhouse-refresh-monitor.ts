import client from 'prom-client';
import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { PROM_PREFIX } from '~/server/prom/client';
import { createJob } from './job';

/**
 * Staleness monitor for ClickHouse refreshable materialized views. Nothing watched
 * any of the seven before this job existed.
 *
 * ── Why staleness, not status ─────────────────────────────────────────────
 * `status` is 'Scheduled' both for a view that refreshed ten seconds ago and for one
 * whose scheduler stopped advancing, so a stuck view reads healthy on it. The primary
 * signal here is `now() - last_success_time`, computed server-side: a number that has
 * to keep moving, checked against a differently-derived one (the view's own period).
 * `exception` and `retry` come along as leading indicators; neither is the alert.
 *
 * ── Why a missed refresh is worse than a failed job ───────────────────────
 * Six of the seven `APPEND` rather than replace, but APPEND is not the property that
 * decides whether a miss is repairable — the TARGET ENGINE is. Read from
 * `system.tables` 2026-08-17:
 *
 *   target                            engine                     re-running the refresh
 *   image_views_daily_by_owner        SharedSummingMergeTree     ADDS. doubles, forever.
 *   impressions_daily_by_owner        SharedSummingMergeTree     ADDS. doubles, forever.
 *   buzzTransactions                  SharedReplacingMergeTree   dedupes on the key
 *   entityMetricDailyAgg_history_v2   SharedReplacingMergeTree   dedupes on the key
 *   entityMetricTotal_v3              SharedReplacingMergeTree   dedupes on the key
 *   entityMetricDailyAgg_today_v2     SharedMergeTree (`TO`)     replaced atomically
 *
 * So only the two Summing targets cannot be repaired by re-running: a second run adds
 * to the first and the number silently doubles (seen 2026-08-16: 5,524,768 reported
 * against a true 2,762,384, which read as entirely plausible). Repair there is a manual
 * `DROP PARTITION` plus a single re-insert. On the four Replacing targets a re-run is
 * recoverable — duplicate rows collapse on the sorting key, and a pre-merge read without
 * FINAL sees both transiently rather than permanently.
 *
 * `unrepairable_by_rerun` below is that distinction and nothing else. It deliberately
 * does NOT mean "appends": keying severity off APPEND would mark six views unrepairable
 * when two are.
 *
 * The recovery WINDOW differs again, which is why `severity` is not decoration either:
 *   - `impressions_daily_by_owner_mv` — PAGE. Unrepairable by re-run AND its source
 *     `default.impressions` has a 30-day TTL, so a miss nobody notices for a month
 *     cannot be rebuilt by anyone.
 *   - everything else — TICKET. Either repairable by re-running, or re-derivable from a
 *     source that still holds the rows (`image_views_daily_by_owner_mv` is the other
 *     Summing target, but rebuilds from `daily_views` back to 2023).
 *
 * ── Thresholds ────────────────────────────────────────────────────────────
 * Peak staleness in a healthy view is period + refresh duration, reached just before
 * the next success. Both measured against production 2026-08-17, period read from each
 * view's own `create_table_query` rather than from documentation:
 *
 *   view                                     period   duration   healthy peak   limit
 *   transactions_final_mv                       15s      0.13s          ~15s     5m
 *   entityMetricTotal_v3_refresher               1m      3.20s          ~63s    10m
 *   entityMetricTotal_v3_refresher_additive      1m      9.59s          ~70s    10m
 *   entityMetricDaily_today_v2_mv                2m      2.21s         ~122s    15m
 *   entityMetricDailySeal_v2_mv                  1d      3.80s          ~24h    27h
 *   image_views_daily_by_owner_mv                1d      4.33s          ~24h    27h
 *   impressions_daily_by_owner_mv                1d      0.06s          ~24h    27h
 *
 * Sub-minute and minute views get roughly 10x their period, which absorbs a CH restart
 * or a deploy blip without paging while still catching a stop inside one poll of the
 * budget. All three daily views get period + 3h. The page-severity one deliberately does
 * NOT get a tighter budget than the ticket ones: 26h vs 27h is indistinguishable against
 * a 30-day recovery window, so the only thing a tighter number buys is a page during a
 * ClickHouse maintenance window.
 *
 * A single global threshold cannot work across a 15s-to-1d range, so the limit is
 * published as its own gauge and the alert compares the two series. That keeps the
 * numbers here, next to the evidence for them, instead of in an infra rule.
 *
 * ── The alert rule, written down because a bare max() is WRONG ─────────────
 * Every gauge here is per-pod, and prom-client never resets. A pod that served one run
 * and then stopped serving them keeps exporting that run's numbers for as long as it
 * lives, so `max by (view)(staleness_seconds)` reads the abandoned pod and keeps a
 * resolved incident firing until that pod is rolled. Select the freshest pod first:
 *
 *   max by (view) (
 *     (staleness_seconds / staleness_limit_seconds)
 *     and on(pod) topk(1, monitor_last_run_timestamp_seconds != 0)
 *   ) > 1
 *
 * The division happens per-pod, before the selection, so a deploy that tightens a limit
 * takes effect immediately instead of being masked by an old pod's looser value. The
 * `!= 0` sits inside topk because the anchor is unlabelled and therefore registers as 0
 * on every pod that never ran, which would otherwise tie.
 *
 * Liveness is a separate rule, and it is the ONLY thing covering a monitor that stops:
 * a throwing ClickHouse query, an unconfigured client, or a cron that was never created
 * all leave every gauge frozen at its last healthy value.
 *
 *   (time() - max_over_time((max(monitor_last_run_timestamp_seconds != 0))[24h:1m])) > 900
 *
 * Both rules ship in talos-infra#1072 with promtool tests.
 */

const HOUR = 3600;

type Severity = 'page' | 'ticket';

type MonitoredView = {
  /** Seconds since the last SUCCESSFUL refresh above which the view is considered stuck. */
  stalenessLimit: number;
  severity: Severity;
  /**
   * True when the target is a SummingMergeTree, so re-running a missed refresh ADDS to
   * what already landed instead of repairing it. NOT the same as "appends" — six of these
   * append and only two are unrepairable.
   */
  unrepairableByRerun: boolean;
};

/**
 * Keyed by `database.view` — `transactions_final_mv` lives in `buzz`, the rest in
 * `default`, and the bare names are not unique by construction.
 *
 * This list is deliberately hardcoded rather than discovered. A view that disappears
 * from `system.view_refreshes` (dropped, renamed, or replaced by a differently-named
 * successor) is exactly the failure that a discovery-driven monitor cannot report: it
 * would simply stop emitting, and prom-client never resets, so the last healthy value
 * would sit there forever and a firing alert would silently resolve.
 */
const MONITORED_VIEWS: Record<string, MonitoredView> = {
  'buzz.transactions_final_mv': {
    stalenessLimit: 5 * 60,
    severity: 'ticket',
    unrepairableByRerun: false,
  },
  'default.entityMetricTotal_v3_refresher': {
    stalenessLimit: 10 * 60,
    severity: 'ticket',
    unrepairableByRerun: false,
  },
  'default.entityMetricTotal_v3_refresher_additive': {
    stalenessLimit: 10 * 60,
    severity: 'ticket',
    unrepairableByRerun: false,
  },
  'default.entityMetricDaily_today_v2_mv': {
    stalenessLimit: 15 * 60,
    severity: 'ticket',
    unrepairableByRerun: false,
  },
  'default.entityMetricDailySeal_v2_mv': {
    stalenessLimit: 27 * HOUR,
    severity: 'ticket',
    unrepairableByRerun: false,
  },
  'default.image_views_daily_by_owner_mv': {
    stalenessLimit: 27 * HOUR,
    severity: 'ticket',
    unrepairableByRerun: true,
  },
  'default.impressions_daily_by_owner_mv': {
    stalenessLimit: 27 * HOUR,
    severity: 'page',
    unrepairableByRerun: true,
  },
};

/**
 * Published for a view that is absent from `system.view_refreshes`, or present but never
 * once successful. Both mean "no refresh has landed", and neither has a real elapsed time
 * to report — leaving the gauge at its last value would read as healthy, and 0 would read
 * as perfectly fresh. Ten years is past every limit above, so the ordinary staleness rule
 * fires and no second alert has to exist for the case.
 */
const NO_SUCCESSFUL_REFRESH_SECONDS = 10 * 365 * 24 * HOUR;

// HMR re-evaluates this module, and prom-client throws on duplicate registration.
declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var clickhouseRefreshGauges: Record<GaugeName, client.Gauge<string>> | undefined;
}

type GaugeName = keyof typeof LABELED_GAUGE_HELP | keyof typeof GLOBAL_GAUGE_HELP;

const LABELED_GAUGE_HELP = {
  staleness_seconds:
    'Seconds since the last successful refresh of this view. The alert signal — compare against ch_refresh_staleness_limit_seconds',
  staleness_limit_seconds:
    'Seconds of staleness above which this view is stuck. Emitted so the alert rule needs no per-view thresholds of its own',
  errored:
    '1 when the last refresh attempt left an exception on the view. Leading indicator only — a view can be stuck with this at 0',
  retries:
    'Consecutive retries the view is currently on. Resets to 0 on success, so it is informational and NOT worth alerting on by itself',
  present:
    '1 when the view exists in system.view_refreshes. 0 means dropped or renamed, and its staleness gauge is a placeholder, not a measurement',
  unrepairable_by_rerun:
    '1 when the target is a SummingMergeTree, so re-running a missed refresh doubles the number instead of repairing it. Static; read this BEFORE re-running anything',
} as const;

const GLOBAL_GAUGE_HELP = {
  monitor_last_run_timestamp_seconds:
    'Unix time this monitor last completed. Alert on it going stale — the per-view gauges cannot report their own absence',
  views_monitored: 'Number of views this build expects to find',
  views_missing: 'Expected views absent from system.view_refreshes (non-zero = dropped or renamed)',
} as const;

const gauges = (global.clickhouseRefreshGauges ??= {
  ...(Object.fromEntries(
    Object.entries(LABELED_GAUGE_HELP).map(([name, help]) => [
      name,
      new client.Gauge({ name: `${PROM_PREFIX}ch_refresh_${name}`, help, labelNames: ['view'] }),
    ])
  ) as Record<keyof typeof LABELED_GAUGE_HELP, client.Gauge<string>>),
  ...(Object.fromEntries(
    Object.entries(GLOBAL_GAUGE_HELP).map(([name, help]) => [
      name,
      new client.Gauge({ name: `${PROM_PREFIX}ch_refresh_${name}`, help }),
    ])
  ) as Record<keyof typeof GLOBAL_GAUGE_HELP, client.Gauge<string>>),
});

type RefreshRow = {
  view: string;
  status: string;
  exception: string;
  retries: string | number;
  stalenessSeconds: string | number | null;
};

type ViewObservation = {
  view: string;
  present: boolean;
  status: string | null;
  errored: boolean;
  /** The text itself, not just the flag: it is the one field triage starts from. */
  exception: string | null;
  retries: number;
  stalenessSeconds: number;
  /** False when `stalenessSeconds` is the placeholder rather than an elapsed time. */
  measured: boolean;
  breached: boolean;
  severity: Severity;
};

/**
 * `now()` and `last_success_time` are both evaluated by ClickHouse, so the difference is
 * immune to the app's timezone and to clock skew between the two hosts. Doing the same
 * subtraction in JS would have to parse a naive `DateTime` and guess its zone.
 */
async function fetchRefreshRows() {
  if (!clickhouse) return undefined;
  return clickhouse.$query<RefreshRow>`
    SELECT
      concat(database, '.', view) AS view,
      status,
      exception,
      retry AS retries,
      dateDiff('second', last_success_time, now()) AS stalenessSeconds
    FROM system.view_refreshes
  `;
}

function observe(rows: RefreshRow[]): ViewObservation[] {
  const byName = new Map(rows.map((row) => [row.view, row]));

  return Object.entries(MONITORED_VIEWS).map(([view, config]) => {
    const row = byName.get(view);
    const rawStaleness = row?.stalenessSeconds;
    const measured = row !== undefined && rawStaleness !== null && rawStaleness !== undefined;
    // A non-finite value must fall back to the placeholder, not be clamped: `Math.max(0,
    // NaN)` is NaN, `NaN > limit` is false, and prom-client exports it happily — so a
    // garbage reading would publish as permanently NOT breached.
    const raw = measured ? Number(rawStaleness) : Number.NaN;
    const stalenessSeconds = Number.isFinite(raw)
      ? Math.max(0, raw)
      : NO_SUCCESSFUL_REFRESH_SECONDS;

    return {
      view,
      present: row !== undefined,
      status: row?.status ?? null,
      errored: Boolean(row?.exception),
      exception: row?.exception || null,
      retries: Number(row?.retries ?? 0),
      stalenessSeconds,
      measured,
      breached: stalenessSeconds > config.stalenessLimit,
      severity: config.severity,
    };
  });
}

function publish(observations: ViewObservation[]) {
  for (const observation of observations) {
    const config = MONITORED_VIEWS[observation.view];
    const labels = { view: observation.view };
    gauges.staleness_seconds.set(labels, observation.stalenessSeconds);
    gauges.staleness_limit_seconds.set(labels, config.stalenessLimit);
    gauges.errored.set(labels, observation.errored ? 1 : 0);
    gauges.retries.set(labels, observation.retries);
    gauges.present.set(labels, observation.present ? 1 : 0);
    gauges.unrepairable_by_rerun.set(labels, config.unrepairableByRerun ? 1 : 0);
  }
  gauges.views_monitored.set(observations.length);
  gauges.views_missing.set(observations.filter((o) => !o.present).length);
}

/**
 * The cron string is real, not decoration: the scheduler reads the whole `jobs` array —
 * names and crons — from `src/pages/api/internal/get-jobs.ts` and registers a recurring
 * job per entry, so adding this to that array IS the scheduling. Worth stating because
 * the three hand-written CronJobs in talos-infra
 * (`civitai-dp-prod/cronjob.yaml`) look like the general mechanism and are not; a
 * reviewer read those comments and concluded this job would never run.
 */
export const clickhouseRefreshMonitorJob = createJob(
  'clickhouse-refresh-monitor',
  '*/1 * * * *',
  async () => {
    const rows = await fetchRefreshRows();
    // No ClickHouse configured (local, or a build): publish nothing. Setting the anchor
    // here would report a monitor that is running while every view gauge stays untouched.
    if (!rows) return { skipped: 'clickhouse-unavailable' };

    const observations = observe(rows);
    publish(observations);
    // Only on a complete run. A throwing query leaves every view gauge frozen at its last
    // healthy value, and this anchor going stale is the only signal that says so.
    gauges.monitor_last_run_timestamp_seconds.set(Date.now() / 1000);

    const unhealthy = observations.filter((o) => o.breached || o.errored || !o.present);
    if (unhealthy.length > 0) {
      await logToAxiom({
        type: 'clickhouse-refresh-monitor',
        name: 'view-refresh-health',
        // Alerting lives on the gauges. This exists so the on-call has the exception
        // text and the status string, which no gauge can carry.
        level: unhealthy.some((o) => o.severity === 'page' && o.breached) ? 'error' : 'warn',
        message: `${unhealthy.length} refreshable view(s) unhealthy: ${unhealthy
          .map((o) => o.view)
          .join(', ')}`,
        error: JSON.stringify(unhealthy),
      }).catch(() => undefined);
    }

    return {
      views: observations.length,
      missing: observations.filter((o) => !o.present).length,
      breached: observations.filter((o) => o.breached).map((o) => o.view),
      errored: observations.filter((o) => o.errored).map((o) => o.view),
    };
  },
  { dedicated: true, lockExpiration: 2 * 60 }
);

export const clickhouseRefreshJobs = [clickhouseRefreshMonitorJob];
