import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import {
  reemitAttemptsCounter,
  reemitErrorsCounter,
  reemitImagesEmittedCounter,
  reemitPostsScannedCounter,
  reemitRunDurationHistogram,
  reemitRunsCounter,
  reemitScheduledImagesEmittedCounter,
  reemitScheduledPostsScannedCounter,
  reemitSkippedRateLimitCounter,
} from '~/server/prom/client';
import { createJob, getJobDate } from './job';

// BitDex publish re-emitter: a periodic job that re-asserts the per-image publish
// values and ingested sortAt by calling the same two shared PG functions the sync
// triggers use. When BitDex already holds the right values the ops are no-ops; when
// a write was missed, the re-emit heals it from PG within one window.
//
// Two scopes, one run:
//   1. published window — images whose parent Post published inside the trailing
//      lookback window (the original scan).
//   2. scheduled sweep  — images whose parent Post is scheduled to publish in the
//      FUTURE. Nothing else can heal these; see buildScheduledReemitQuery.

const DEFAULT_LOOKBACK_SECS = 15 * 60;
const DEFAULT_SETTLE_SECS = 10; // must stay << lookback
const CADENCE_CRON = '*/5 * * * *';

// The job body is written for the */5 cadence above, but the external scheduler
// currently fires it every 1-2 minutes. Each fire emits 600-1300 same-value ops
// that BitDex has to churn through bucket-maintenance for, so an over-firing
// scheduler amplifies load with no healing benefit. A little under the cron
// period so a run that lands slightly early on the intended */5 tick still passes.
const DEFAULT_MIN_INTERVAL_SECS = 270;

// keyValue key holding the epoch-ms of the last successful emit. Shared across
// pods (DB-backed), so the rate-limit spaces out emits fleet-wide, not per pod —
// the cross-pod run lock only serializes concurrent runs, it does not space them.
const REEMIT_LAST_RUN_KEY = 'reemit-bitdex-ops:last-run';

function parsePositiveSecs(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type ReemitConfig = { lookbackSecs: number; settleSecs: number };

// Env-overridable so the window can be retuned without a redeploy.
export function getReemitConfig(): ReemitConfig {
  return {
    lookbackSecs: parsePositiveSecs(process.env.REEMIT_LOOKBACK_SECS, DEFAULT_LOOKBACK_SECS),
    settleSecs: parsePositiveSecs(process.env.REEMIT_SETTLE_SECS, DEFAULT_SETTLE_SECS),
  };
}

// Kept separate from ReemitConfig so the SQL builder and its tests stay untouched;
// this knob only gates whether the job runs, it is not part of the emit statement.
export function getReemitMinIntervalSecs(): number {
  return parsePositiveSecs(process.env.REEMIT_MIN_INTERVAL_SECS, DEFAULT_MIN_INTERVAL_SECS);
}

// Same reasoning as the min-interval knob: this gates whether the second (scheduled)
// scan runs at all, it is not a parameter of either emit statement. Default ON —
// the sweep is the only healer that can reach a future-scheduled post, so it has to
// be on by default; the env var exists to shed the ~94K-image scan under load.
export function getScheduledSweepEnabled(): boolean {
  const raw = process.env.REEMIT_SCHEDULED_SWEEP_ENABLED?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  return true;
}

// The sweep's own cadence, decoupled from the job's 5-min fire. BitDex suppresses
// identical sortAt re-sets, but the publish REMOVE ops have no no-op suppression:
// each of the ~94K rows costs a real bitmap remove + exists_boolean shadow writes +
// cache invalidation on isPublished/publishedAt — fields nearly every cached feed
// entry filters on. At 5-min cadence that is standing cache-maintenance churn for
// a corruption class that needs an ops-loss window to occur at all. Hourly keeps
// the heal SLA (stale scheduled state visible for at most ~1h) at 1/12th the churn.
const SCHEDULED_SWEEP_LAST_RUN_KEY = 'reemit-bitdex-ops:scheduled-sweep-last-run';
const DEFAULT_SCHEDULED_SWEEP_INTERVAL_SECS = 60 * 60;
export function getScheduledSweepIntervalSecs(): number {
  return parsePositiveSecs(
    process.env.REEMIT_SCHEDULED_SWEEP_INTERVAL_SECS,
    DEFAULT_SCHEDULED_SWEEP_INTERVAL_SECS
  );
}

export type ReemitResult = {
  postsScanned: number;
  imagesEmitted: number;
  scheduledPostsScanned: number;
  scheduledImagesEmitted: number;
};

// The counts the two scans return individually, before they are folded into a
// ReemitResult. Both scans return the same column pair.
type ScanCounts = { postsScanned: number; imagesEmitted: number };

// This must stay a single data-modifying-CTE statement: the scan, the INSERT, and
// the count all run under one snapshot, and the BitdexOps id is allocated inside the
// INSERT. Splitting it into a per-row emit loop takes a fresh snapshot per row and
// lets a concurrent unpublish be re-ordered into a ghost re-publish.
//
// The updatedAt < now() - settle clause skips a post that is being (un)published
// right now (fresh updatedAt) until it settles, so a re-emit never coexists with a
// live publish/unpublish op.
export function buildReemitQuery({ lookbackSecs, settleSecs }: ReemitConfig): Prisma.Sql {
  return Prisma.sql`
    WITH scanned AS (
      SELECT
        p.id AS post_id,
        i.id AS image_id,
        bitdex_post_fanout_ops(p) || bitdex_image_sortat_ops(i) AS ops
      FROM "Post" p
      JOIN "Image" i ON i."postId" = p.id
      WHERE p."publishedAt" >= now() - make_interval(secs => ${lookbackSecs})
        AND p."publishedAt" <= now()
        AND p."updatedAt"  <  now() - make_interval(secs => ${settleSecs})
    ),
    ins AS (
      INSERT INTO "BitdexOps" (entity_id, ops)
      SELECT image_id, ops FROM scanned
      RETURNING entity_id
    )
    SELECT
      (SELECT count(*) FROM ins)::int AS "imagesEmitted",
      (SELECT count(DISTINCT post_id) FROM scanned)::int AS "postsScanned"
  `;
}

// Second scan, for posts scheduled to publish in the FUTURE (publishedAt > now()).
//
// The published-window scan above can only reach a post whose publishedAt already
// fell inside a trailing PAST window, so a future-scheduled post whose BitDex state
// is wrong is unreachable by any healer — that gap is what let the 2026-08-06 leak
// (posts rescheduled Jul-31 -> Aug-31 whose reschedule ops were lost, then activated
// by the deferred sweep when the stale Jul-31 date passed) persist for two weeks.
//
// Emitting the same two shared functions is correct for this scope precisely because
// they are shared: bitdex_post_fanout_ops' CASE guard turns a future publishedAt into
// REMOVE ops, so a correctly-indexed scheduled post gets a no-op reassert and a
// wrongly-visible one gets pulled back out. There is no future-specific op shape here
// and there must not be — the shape stays owned by the PG functions.
//
// Same single data-modifying-CTE and settle-belt requirements as the scan above; see
// that comment for why splitting either into a per-row loop reintroduces the ghost
// re-publish race. No lookback bound: the whole future-scheduled set is the scope
// (~94K images / ~12K posts as of 2026-08-06), which is why this scan is separately
// gateable via REEMIT_SCHEDULED_SWEEP_ENABLED.
export function buildScheduledReemitQuery({
  settleSecs,
}: Pick<ReemitConfig, 'settleSecs'>): Prisma.Sql {
  return Prisma.sql`
    WITH scanned AS (
      SELECT
        p.id AS post_id,
        i.id AS image_id,
        bitdex_post_fanout_ops(p) || bitdex_image_sortat_ops(i) AS ops
      FROM "Post" p
      JOIN "Image" i ON i."postId" = p.id
      WHERE p."publishedAt" > now()
        AND p."updatedAt"  <  now() - make_interval(secs => ${settleSecs})
    ),
    ins AS (
      INSERT INTO "BitdexOps" (entity_id, ops)
      SELECT image_id, ops FROM scanned
      RETURNING entity_id
    )
    SELECT
      (SELECT count(*) FROM ins)::int AS "imagesEmitted",
      (SELECT count(DISTINCT post_id) FROM scanned)::int AS "postsScanned"
  `;
}

// bitdex_post_fanout_ops / bitdex_image_sortat_ops are created by the sync-trigger
// deploy, not this repo. A missing function propagates out of $queryRaw rather than
// being swallowed, so the run fails loudly instead of silently healing nothing.
//
// The two scans are deliberately separate statements rather than one UNIONed scan:
// each has to stay a single data-modifying CTE, and keeping them apart means the
// scheduled sweep can be switched off without touching the published-window SQL.
// They run sequentially — the published window is the latency-sensitive one, so it
// goes first and is never delayed by the larger scheduled scan.
export async function runReemit(
  config: ReemitConfig,
  // The job passes false when the sweep's own interval hasn't elapsed; the
  // published-window scan runs regardless. Defaults true so direct callers
  // (tests, manual heals) get the full behavior.
  runScheduledSweep = true
): Promise<ReemitResult> {
  const rows = await dbWrite.$queryRaw<ScanCounts[]>(buildReemitQuery(config));
  const row = rows[0];

  let scheduled: ScanCounts = { postsScanned: 0, imagesEmitted: 0 };
  if (runScheduledSweep && getScheduledSweepEnabled()) {
    const scheduledRows = await dbWrite.$queryRaw<ScanCounts[]>(
      buildScheduledReemitQuery({ settleSecs: config.settleSecs })
    );
    const scheduledRow = scheduledRows[0];
    scheduled = {
      postsScanned: scheduledRow?.postsScanned ?? 0,
      imagesEmitted: scheduledRow?.imagesEmitted ?? 0,
    };
  }

  return {
    postsScanned: row?.postsScanned ?? 0,
    imagesEmitted: row?.imagesEmitted ?? 0,
    scheduledPostsScanned: scheduled.postsScanned,
    scheduledImagesEmitted: scheduled.imagesEmitted,
  };
}

export const reemitBitdexOps = createJob(
  'reemit-bitdex-ops',
  CADENCE_CRON,
  async () => {
    // Self rate-limit, ahead of the flag check: an over-firing scheduler is
    // wasteful whether or not the feature is on, and lastRun is only written
    // after a successful emit — so the skip can only ever trip while enabled.
    const minIntervalSecs = getReemitMinIntervalSecs();
    const [lastRun, setLastRun] = await getJobDate(REEMIT_LAST_RUN_KEY);
    const sinceLastRunSecs = (Date.now() - lastRun.getTime()) / 1000;
    if (sinceLastRunSecs < minIntervalSecs) {
      reemitSkippedRateLimitCounter?.inc();
      return;
    }

    // Default-off: registered and scheduled but no-ops until the flag is flipped on.
    const enabled = await isFlipt(FLIPT_FEATURE_FLAGS.BITDEX_PUBLISH_REEMITTER);
    if (!enabled) return;

    // Count the attempt before the emit so a failing run still moves a counter;
    // runs_total stays success-only (attempts - runs = the error count).
    reemitAttemptsCounter?.inc();

    // The sweep runs on its own, longer clock (see getScheduledSweepIntervalSecs).
    const [sweepLastRun, setSweepLastRun] = await getJobDate(SCHEDULED_SWEEP_LAST_RUN_KEY);
    const sweepDue =
      (Date.now() - sweepLastRun.getTime()) / 1000 >= getScheduledSweepIntervalSecs();

    const config = getReemitConfig();
    const start = Date.now();
    let postsScanned: number;
    let imagesEmitted: number;
    let scheduledPostsScanned: number;
    let scheduledImagesEmitted: number;
    try {
      ({ postsScanned, imagesEmitted, scheduledPostsScanned, scheduledImagesEmitted } =
        await runReemit(config, sweepDue));
    } catch (e) {
      reemitErrorsCounter?.inc();
      throw e; // createJob logs job-error to Axiom and marks the run failed
    }
    const durationSec = (Date.now() - start) / 1000;

    // Only a successful emit advances the rate-limit window: a failed run leaves
    // lastRun untouched so the next fire can retry immediately instead of waiting.
    await setLastRun();
    // Same success-only rule for the sweep clock. scheduledPostsScanned stays 0 when
    // the sweep was skipped (due or not), so only an actually-executed sweep counts.
    if (sweepDue && getScheduledSweepEnabled()) await setSweepLastRun();

    reemitRunsCounter?.inc();
    // The scheduled scan gets its own counters rather than being folded into the
    // published-window ones: its volume is ~100x larger and steady, so summing them
    // would swamp the published-window emission signal the existing alerts read.
    reemitPostsScannedCounter?.inc(postsScanned);
    reemitImagesEmittedCounter?.inc(imagesEmitted);
    reemitScheduledPostsScannedCounter?.inc(scheduledPostsScanned);
    reemitScheduledImagesEmittedCounter?.inc(scheduledImagesEmitted);
    // Duration covers both scans — it is the guard on the whole emit getting slow.
    reemitRunDurationHistogram?.observe(durationSec);

    logToAxiom(
      {
        type: 'job',
        name: 'reemit-bitdex-ops',
        message: 'reemit-complete',
        postsScanned,
        imagesEmitted,
        scheduledPostsScanned,
        scheduledImagesEmitted,
        scheduledSweepEnabled: getScheduledSweepEnabled(),
        durationSec,
        lookbackSecs: config.lookbackSecs,
        settleSecs: config.settleSecs,
      },
      'webhooks'
    ).catch(() => undefined);

    return {
      postsScanned,
      imagesEmitted,
      scheduledPostsScanned,
      scheduledImagesEmitted,
      durationSec,
    };
  },
  // Cheap statement; keep the single-runner lock short.
  { lockExpiration: 5 * 60 }
);
