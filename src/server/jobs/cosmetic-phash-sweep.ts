import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  COSMETIC_PHASH_LANE,
  markCosmeticHashFailed,
  storeCosmeticPerceptualHash,
} from '~/server/services/cosmetic-phash.service';
import { getPerceptualHash } from '~/server/services/orchestrator/orchestrator.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createJob } from './job';

/**
 * Keeps `Cosmetic.pHashHex` complete and current.
 *
 * Three things put a cosmetic back in scope, and the third is the upgrade path:
 *  - it has never been hashed (write-path failures, and anything created before
 *    a path learned to hash);
 *  - its artwork changed, so `pHashUrl` no longer matches `data.url` and the
 *    stored hash describes an image nobody can see;
 *  - it was hashed in a different lane, so `pHashVersion` is not the one the app
 *    now asks for. Raising `COSMETIC_PHASH_LANE.version` therefore drains the
 *    whole corpus on its own, one batch per tick, with no separate backfill.
 *
 * `pHashFailedAt` is stamped on FAILURE ONLY and cleared on success, and that
 * asymmetry is load-bearing. Artwork that can never be hashed (dead CDN objects)
 * would otherwise match the predicate forever and starve the rows behind it, so
 * failures need suppressing — but stamping successes too would make the retry
 * window suppress every recently-hashed row for a day, which is precisely the
 * population a lane change needs re-hashed first.
 */

// One tick's worth. The 2026-08-01 run measured ~10.5 hashes/s at this
// concurrency, so a batch is ~20s of orchestrator time and a full re-hash of the
// ~1,200-row corpus drains in a handful of ticks.
const BATCH_SIZE = 200;
const CONCURRENCY = 5;

// A row that failed is not retried again inside this window. Long enough that a
// permanently-dead url costs one attempt a day, short enough that a transient
// orchestrator outage heals the same day.
const RETRY_AFTER_HOURS = 24;

type SweepRow = { id: number; url: string };

export async function sweepCosmeticPerceptualHashes({
  batchSize = BATCH_SIZE,
  concurrency = CONCURRENCY,
}: { batchSize?: number; concurrency?: number } = {}) {
  const rows = await dbRead.$queryRaw<SweepRow[]>`
    SELECT id, data->>'url' AS url
    FROM "Cosmetic"
    WHERE data->>'url' IS NOT NULL
      AND (
        "pHashHex" IS NULL
        OR "pHashVersion" IS DISTINCT FROM ${COSMETIC_PHASH_LANE.version}
        OR "pHashUrl" IS DISTINCT FROM data->>'url'
      )
      AND (
        "pHashFailedAt" IS NULL
        OR "pHashFailedAt" < NOW() - (${RETRY_AFTER_HOURS} * INTERVAL '1 hour')
      )
    ORDER BY "pHashFailedAt" ASC NULLS FIRST, id ASC
    LIMIT ${batchSize}
  `;

  if (!rows.length) return { scanned: 0, hashed: 0, failed: 0 };

  let hashed = 0;
  let failed = 0;
  await limitConcurrency(
    rows.map((row) => async () => {
      // Counted once, at the end, from what actually happened. Incrementing
      // inside both the try and its catch double-counts a row whose failure
      // stamp itself throws (a cosmetic deleted mid-sweep, say), and the tally
      // is the only thing anyone reads about this job — `scanned` must stay
      // equal to `hashed + failed` or it reports nothing trustworthy.
      let stored = false;
      try {
        const hex = await getPerceptualHash(row.url, COSMETIC_PHASH_LANE.hashType);
        if (hex !== undefined) {
          await storeCosmeticPerceptualHash({ id: row.id, url: row.url, hex });
          stored = true;
        }
      } catch (error) {
        // Fall through to the failure stamp — but say which row and why first.
        // Everything downstream sees only the aggregate `failed` count, and that
        // count already conflates a dead CDN object with a hash the store
        // REFUSED (a width that disagrees with the lane). Without this line the
        // second is indistinguishable from the first, on every row, forever.
        // Fire-and-forget with its own catch: a logger that throws inside a catch
        // would convert a diagnosable failure into a lost row, which is the thing
        // this line exists to prevent.
        logToAxiom({
          type: 'error',
          name: 'cosmetic-phash-sweep',
          message: `Could not store a hash for cosmetic ${row.id} (${row.url})`,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => null);
      }
      if (stored) hashed++;
      else {
        failed++;
        // Best effort: if even the stamp fails the row simply comes back next
        // tick, which is the same outcome as before this job existed.
        await markCosmeticHashFailed(row.id).catch(() => null);
      }
    }),
    concurrency
  );

  return { scanned: rows.length, hashed, failed };
}

/**
 * FAIL-OPEN: a hash is a review signal, not a gate. A sweep that throws must not
 * mark the runner failed — the next tick retries, and nothing downstream breaks
 * in the meantime beyond a review panel reporting that a cosmetic has no hash.
 */
export const cosmeticPerceptualHashSweepJob = createJob(
  'cosmetic-phash-sweep',
  '*/15 * * * *',
  async () => {
    try {
      const result = await sweepCosmeticPerceptualHashes();
      if (result.scanned > 0)
        logToAxiom({ type: 'cosmetic-phash-sweep', ...result }, 'webhooks').catch(() => undefined);
      return result;
    } catch (error) {
      logToAxiom(
        {
          type: 'cosmetic-phash-sweep',
          level: 'error',
          message: (error as Error)?.message,
          stack: (error as Error)?.stack,
        },
        'webhooks'
      ).catch(() => undefined);
      return { scanned: 0, hashed: 0, failed: 0, error: true as const };
    }
  }
);
