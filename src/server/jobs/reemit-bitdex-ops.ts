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
} from '~/server/prom/client';
import { createJob } from './job';

// BitDex publish re-emitter — the safety net under engine-driven activation.
//
// Every <cadence> it re-asserts, for every image whose parent Post was published
// in the trailing <lookback> window, the per-image publish values AND the ingested
// sortAt, by calling the SAME two shared PG functions the W1-1 sync triggers call
// (bitdex_post_fanout_ops + bitdex_image_sortat_ops). When BitDex already holds the
// right values the ops are no-ops (the >=99% success case); when a write was missed
// (dropped op / activation miss / reschedule straggler / silent sortAt recompute
// failure) the re-emit heals it from PG's authoritative values within one window.
//
// Correctness rests on TWO structural properties — do not weaken either:
//   1. SINGLE-STATEMENT emission (§3.1, the [PR-M3] fence). The INSERT and its
//      selection share one MVCC snapshot and the BitdexOps BIGSERIAL id is
//      allocated inside that statement, which is what keeps a concurrent unpublish
//      from being re-ordered into a ghost re-publish. Splitting this into a
//      per-row emit loop takes a fresh snapshot per row and REINTRODUCES the ghost.
//   2. Shape parity via the SHARED functions. The re-emit's op shape cannot drift
//      from the triggers' because it calls the identical functions; that is what
//      preserves the "no-op = success" signal. Never re-spell the op JSON here.
//
// See docs/design/publish-reemitter.md (bitdex-v2 repo) for the full argument.

const DEFAULT_LOOKBACK_SECS = 15 * 60; // §4: dominates poller/WAL lag by >10x.
const DEFAULT_SETTLE_SECS = 10; // §3.3: unpublish-race belt; must be << lookback.
const CADENCE_CRON = '*/5 * * * *'; // §6.1: cadence < lookback → ~3 heal attempts.

function parsePositiveSecs(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type ReemitConfig = { lookbackSecs: number; settleSecs: number };

// Config knobs (§8 item 6). Env-overridable so the window can be retuned without a
// code change; the enable/disable switch is the Flipt flag (no redeploy needed).
export function getReemitConfig(): ReemitConfig {
  return {
    lookbackSecs: parsePositiveSecs(process.env.REEMIT_LOOKBACK_SECS, DEFAULT_LOOKBACK_SECS),
    settleSecs: parsePositiveSecs(process.env.REEMIT_SETTLE_SECS, DEFAULT_SETTLE_SECS),
  };
}

export type ReemitResult = { postsScanned: number; imagesEmitted: number };

// The emit is one data-modifying-CTE statement (fence property #1): `scanned`,
// the INSERT, and the count read all execute under a single snapshot. The counts
// are read via RETURNING/aggregate in the SAME statement so posts_scanned is
// honest (no second snapshot) — it is still one statement, so the fence holds.
//
//   - publishedAt <= now()  → excludes still-scheduled (future) posts; a scheduled
//     post enters the window only once its clock passes, which is exactly when a
//     missed activation needs healing.
//   - updatedAt < now() - settle → the settle belt: a post being (un)published
//     right now has a fresh updatedAt and is skipped until it settles, so the
//     re-emit and a live publish/unpublish op never coexist in a processable window.
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

// Run the emit. Any PG error — notably a MISSING bitdex_post_fanout_ops /
// bitdex_image_sortat_ops (the functions are created by the sync-trigger deploy,
// not here) — propagates out of $queryRaw and is NOT swallowed, so createJob's
// wrapper logs a `job-error` to Axiom and marks the run failed. Loud, never silent.
export async function runReemit(config: ReemitConfig): Promise<ReemitResult> {
  const rows = await dbWrite.$queryRaw<ReemitResult[]>(buildReemitQuery(config));
  const row = rows[0];
  return {
    postsScanned: row?.postsScanned ?? 0,
    imagesEmitted: row?.imagesEmitted ?? 0,
  };
}

export const reemitBitdexOps = createJob(
  'reemit-bitdex-ops',
  CADENCE_CRON,
  async () => {
    // DEFAULT-OFF gate. Registered + scheduled but no-ops every run until the flag
    // is flipped ON for the W4 shadow window. An unknown/undefined flag → false.
    const enabled = await isFlipt(FLIPT_FEATURE_FLAGS.BITDEX_PUBLISH_REEMITTER);
    if (!enabled) return;

    // Count the ATTEMPT before the emit — so a run that fails (e.g. a missing
    // shared PG function) still moves a counter. runs_total stays success-only, so
    // attempts - runs = the error count and the W4 "counter increments" check can't
    // be ambiguous between flag-off / erroring / not-scheduled.
    reemitAttemptsCounter?.inc();

    const config = getReemitConfig();
    const start = Date.now();
    let postsScanned: number;
    let imagesEmitted: number;
    try {
      ({ postsScanned, imagesEmitted } = await runReemit(config));
    } catch (e) {
      reemitErrorsCounter?.inc();
      throw e; // createJob's wrapper logs job-error to Axiom + marks the run failed.
    }
    const durationSec = (Date.now() - start) / 1000;

    reemitRunsCounter?.inc();
    reemitPostsScannedCounter?.inc(postsScanned);
    reemitImagesEmittedCounter?.inc(imagesEmitted);
    reemitRunDurationHistogram?.observe(durationSec);

    logToAxiom(
      {
        type: 'job',
        name: 'reemit-bitdex-ops',
        message: 'reemit-complete',
        postsScanned,
        imagesEmitted,
        durationSec,
        lookbackSecs: config.lookbackSecs,
        settleSecs: config.settleSecs,
      },
      'webhooks'
    ).catch(() => undefined);

    return { postsScanned, imagesEmitted, durationSec };
  },
  // Cheap statement; keep the single-runner lock short.
  { lockExpiration: 5 * 60 }
);
