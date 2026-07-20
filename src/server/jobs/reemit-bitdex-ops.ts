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

// BitDex publish re-emitter: a periodic job that re-asserts the per-image publish
// values and ingested sortAt for every image whose parent Post was published in the
// trailing lookback window, by calling the same two shared PG functions the sync
// triggers use. When BitDex already holds the right values the ops are no-ops; when
// a write was missed, the re-emit heals it from PG within one window.

const DEFAULT_LOOKBACK_SECS = 15 * 60;
const DEFAULT_SETTLE_SECS = 10; // must stay << lookback
const CADENCE_CRON = '*/5 * * * *';

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

export type ReemitResult = { postsScanned: number; imagesEmitted: number };

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

// bitdex_post_fanout_ops / bitdex_image_sortat_ops are created by the sync-trigger
// deploy, not this repo. A missing function propagates out of $queryRaw rather than
// being swallowed, so the run fails loudly instead of silently healing nothing.
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
    // Default-off: registered and scheduled but no-ops until the flag is flipped on.
    const enabled = await isFlipt(FLIPT_FEATURE_FLAGS.BITDEX_PUBLISH_REEMITTER);
    if (!enabled) return;

    // Count the attempt before the emit so a failing run still moves a counter;
    // runs_total stays success-only (attempts - runs = the error count).
    reemitAttemptsCounter?.inc();

    const config = getReemitConfig();
    const start = Date.now();
    let postsScanned: number;
    let imagesEmitted: number;
    try {
      ({ postsScanned, imagesEmitted } = await runReemit(config));
    } catch (e) {
      reemitErrorsCounter?.inc();
      throw e; // createJob logs job-error to Axiom and marks the run failed
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
