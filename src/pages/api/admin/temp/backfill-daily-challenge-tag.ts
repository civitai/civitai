import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { pgDbWrite } from '~/server/db/pgDb';
import { dailyChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { insertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import { sleep } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString, commaDelimitedStringArray } from '~/utils/zod-helpers';

/**
 * Tags daily-challenge entries submitted before their collection carried `autoTagId`, so the
 * "Hide challenge entries" filter hides them too. Re-runnable: already-tagged entries are skipped.
 *
 * Sequential committed batches, resumable from the returned `next` cursor. Before every batch it
 * reads the retained WAL of each logical replication slot in `slots` and stops if one is missing,
 * over `maxLagMb`, or grown more than `maxLagGrowthMb` past the lowest lag that slot has shown.
 * Pass the returned `baselines` back with `next`, or growth is measured from each call's own start.
 *
 *   /api/admin/temp/backfill-daily-challenge-tag?token=$WEBHOOK_TOKEN&dryRun=false&collectionId=0&itemId=0
 */
const MB = 1024 ** 2;

const schema = z.object({
  dryRun: booleanString().default(true),
  collectionId: z.coerce.number().int().min(0).default(0),
  itemId: z.coerce.number().int().min(0).default(0),
  batchSize: z.coerce.number().int().min(1).max(2000).default(1000),
  pauseMs: z.coerce.number().int().min(0).max(60_000).default(2000),
  maxBatches: z.coerce.number().int().min(1).max(1000).default(30),
  slots: commaDelimitedStringArray(z.string().min(1).array().min(1)).default(['mediarank_sub']),
  maxLagMb: z.coerce.number().positive().max(4096).default(1024),
  // Above the sawtooth a healthy slot shows between restart_lsn steps; a stalled one passes it in minutes.
  maxLagGrowthMb: z.coerce.number().positive().max(1024).default(256),
  // "slot:mb,slot:mb", as returned in `baselines`.
  baselines: commaDelimitedStringArray(
    z
      .string()
      .regex(/^[\w.-]+:\d+$/)
      .array()
  ).transform(
    (entries) =>
      Object.fromEntries(
        entries.map((entry) => {
          const [slot, mb] = entry.split(':');
          return [slot, Number(mb) * MB];
        })
      ) as Record<string, number>
  ),
});

type StopReason =
  | 'slot-not-found'
  | 'lag-over-max'
  | 'lag-grew'
  | 'max-batches'
  | 'client-closed'
  | 'error';

/** Retained WAL per slot, or null if any slot is absent or holds no WAL. */
async function getRetainedWalBytes(slots: string[]) {
  const { rows } = await pgDbWrite.query<{ slot: string; lag: string | null }>(
    `SELECT slot_name AS slot, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint AS lag
     FROM pg_replication_slots WHERE slot_name = ANY($1)`,
    [slots]
  );
  const lags: Record<string, number> = {};
  for (const slot of slots) {
    const lag = rows.find((row) => row.slot === slot)?.lag ?? null;
    if (lag === null) return null;
    lags[slot] = Number(lag);
  }
  return lags;
}

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);
  const tagId = dailyChallengeConfig.challengeTagId;

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const {
    rows: [{ lsn: startLsn }],
  } = await pgDbWrite.query<{ lsn: string }>(`SELECT pg_current_wal_lsn()::text AS lsn`);

  const { rows: collections } = await pgDbWrite.query<{ id: number }>(
    `SELECT col.id
     FROM "Challenge" c
     JOIN "Collection" col ON col.id = c."collectionId"
     WHERE c.source = 'System' AND (col.metadata->>'autoTagId')::int = $1 AND col.id >= $2
     ORDER BY col.id`,
    [tagId, params.collectionId]
  );

  const next = { collectionId: params.collectionId, itemId: params.itemId };
  let batches = 0;
  let scanned = 0;
  let untaggedFound = 0;
  let written = 0;
  let wroteLastBatch = false;
  const baselines = { ...params.baselines };
  let lags: Record<string, number> | null = null;
  let stopReason: StopReason | undefined;
  let stopSlot: string | undefined;
  let error: string | undefined;
  let requeueFailed = false;

  outer: for (const { id: collectionId } of collections) {
    let itemId = collectionId === params.collectionId ? params.itemId : 0;
    next.collectionId = collectionId;
    next.itemId = itemId;

    while (true) {
      if (closed) {
        stopReason = 'client-closed';
        break outer;
      }
      if (batches >= params.maxBatches) {
        stopReason = 'max-batches';
        break outer;
      }
      if (wroteLastBatch && params.pauseMs) await sleep(params.pauseMs);
      wroteLastBatch = false;

      lags = await getRetainedWalBytes(params.slots);
      if (!lags) {
        stopReason = 'slot-not-found';
        break outer;
      }
      // Per slot: one slot already holding a lot of WAL must not hide growth on another.
      for (const [slot, lag] of Object.entries(lags)) {
        baselines[slot] = Math.min(baselines[slot] ?? lag, lag);
        if (lag > params.maxLagMb * MB) stopReason = 'lag-over-max';
        else if (lag - baselines[slot] > params.maxLagGrowthMb * MB) stopReason = 'lag-grew';
        if (stopReason) {
          stopSlot = slot;
          break outer;
        }
      }

      const { rows } = await pgDbWrite.query<{ id: number; imageId: number; tagged: boolean }>(
        `SELECT ci.id, ci."imageId",
           EXISTS (
             SELECT 1 FROM "TagsOnImageNew" t WHERE t."imageId" = ci."imageId" AND t."tagId" = $1
           ) AS tagged
         FROM "CollectionItem" ci
         WHERE ci."collectionId" = $2 AND ci.id > $3 AND ci."imageId" IS NOT NULL
         ORDER BY ci.id
         LIMIT $4`,
        [tagId, collectionId, itemId, params.batchSize]
      );
      if (!rows.length) break;

      const untagged = rows.filter((row) => !row.tagged);
      if (!params.dryRun && untagged.length) {
        const imageIds = untagged.map(({ imageId }) => imageId);
        try {
          await insertTagsOnImageNew(
            imageIds.map((imageId) => ({
              imageId,
              tagId,
              source: 'User' as const,
              confidence: 100,
              automated: true,
            }))
          );
        } catch (e) {
          stopReason = 'error';
          error = (e as Error).message;
          // Some chunks may have committed; a rerun skips those as tagged and would never
          // queue them, so they have to reach the index now.
          await queueImageSearchIndexUpdate({
            ids: imageIds,
            action: SearchIndexUpdateQueueAction.Update,
          }).catch(() => {
            requeueFailed = true;
          });
          break outer;
        }
        written += untagged.length;
        wroteLastBatch = true;
      }

      batches++;
      scanned += rows.length;
      untaggedFound += untagged.length;
      itemId = rows[rows.length - 1].id;
      next.itemId = itemId;

      if (rows.length < params.batchSize) break;
    }
  }

  // Best-effort: a failure here must not cost the operator the cursor for writes already committed.
  const walBytes = await pgDbWrite
    .query<{ bytes: string }>(
      `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::bigint AS bytes`,
      [startLsn]
    )
    .then(({ rows }) => Number(rows[0].bytes))
    .catch(() => null);

  const toMb = (bytes: number | null) => (bytes === null ? null : Math.round(bytes / MB));

  return res.status(200).json({
    dryRun: params.dryRun,
    done: !stopReason,
    stopReason,
    stopSlot,
    error,
    requeueFailed,
    next,
    // Floored, so passing it back can only tighten the guard.
    baselines: Object.entries(baselines)
      .map(([slot, bytes]) => `${slot}:${Math.floor(bytes / MB)}`)
      .join(','),
    batches,
    scanned,
    untaggedFound,
    written,
    lagMb: lags && Object.fromEntries(Object.entries(lags).map(([slot, b]) => [slot, toMb(b)])),
    walMb: toMb(walBytes),
  });
});
