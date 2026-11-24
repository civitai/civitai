import { Prisma } from '@prisma/client';
import { imageRoutesHeld, REVIEW_SERVED_ACTIVITY } from '@civitai/shared/review-batch';
import { URL_SIBLING_CAP } from '@civitai/shared/retracted-media-tier';
import { blockedForPatterns } from '~/server/services/blocked-for-patterns';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  readImageSignals,
  readScannerCsamVerdicts,
} from '~/server/services/review-batch/review-batch.service';
import { createJob } from './job';

/** The signals were read when this job ran, not when the batch was routed: labels change between. */
export const ROUTING_MISS_ACTIVITY = 'reviewBatch:routingMiss:recomputedAtVerdictTime';
export const MISS_CHECK_ACTIVITY = 'reviewBatch:routingMissCheck';
const LOOKBACK_HOURS = 48;
/** The account deleted users' content is kept under; owns rows no moderator wrote. */
const SYSTEM_USER_ID = -1;

type Served = { imageId: number; batchHash: string };

/**
 * Each general-tier view within `LOOKBACK_HOURS` whose image is now CSAM-restricted: a batch the
 * server routed general that it would route held today. Records each one once, with the
 * image's CSAM report when there is one, and writes a dated heartbeat row every run, misses or not,
 * so a run that never happened shows as a missing day.
 */
export async function checkReviewBatchRoutingMisses(now = new Date()) {
  const served = await dbWrite.$queryRaw<Served[]>`
    SELECT DISTINCT ma."entityId" AS "imageId", ma."reviewBatchId" AS "batchHash"
    FROM "ModActivity" ma
    WHERE ma."createdAt" > ${now}::timestamptz - make_interval(hours => ${Prisma.raw(
    String(LOOKBACK_HOURS)
  )})
      AND ma.activity = ${REVIEW_SERVED_ACTIVITY}
      AND ma."reviewTier" = 'general'
      AND ma."entityId" IS NOT NULL AND ma."reviewBatchId" IS NOT NULL
  `;

  const ids = [...new Set(served.map((row) => row.imageId))];
  const misses = ids.length
    ? await findMisses(ids)
    : { held: new Set<number>(), scannerRead: true };
  const recorded = misses.held.size ? await alreadyRecorded([...misses.held]) : new Set<string>();
  const fresh = served.filter(
    (row) => misses.held.has(row.imageId) && !recorded.has(`${row.imageId}:${row.batchHash}`)
  );

  for (const miss of fresh) await recordMiss(miss);

  await dbWrite.$executeRaw`
    INSERT INTO "ModActivity" ("userId", "entityType", "entityId", activity)
    VALUES (${SYSTEM_USER_ID}, 'reviewBatchMissCheck', ${dayNumber(now)}, ${MISS_CHECK_ACTIVITY})
    ON CONFLICT DO NOTHING
  `;
  logToAxiom({
    name: 'review-batch-routing-miss-check',
    type: fresh.length || !misses.scannerRead ? 'error' : 'info',
    payload: {
      served: served.length,
      misses: fresh.length,
      batchHashes: [...new Set(fresh.map((miss) => miss.batchHash))],
      scannerRead: misses.scannerRead,
    },
  });
  return { served: served.length, misses: fresh.length, scannerRead: misses.scannerRead };
}

/** `20261114` for that UTC day: one heartbeat row per day, findable by its date. */
const dayNumber = (date: Date) => Number(date.toISOString().slice(0, 10).replaceAll('-', ''));

const CHUNK = 1000;

async function findMisses(ids: number[]) {
  const patterns = blockedForPatterns();
  const held = new Set<number>();
  let scannerRead = true;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const [signals, verdicts] = await Promise.all([
      readImageSignals(part),
      readScannerCsamVerdicts(part),
    ]);
    if (!verdicts) scannerRead = false;
    // A miss is a signal present now. A missing image or row, a missing pattern list, a scan gone back
    // to pending, or a url with more copies than the routing reads is not evidence of one; the
    // routing holds all of those.
    const clean = patterns ?? { signal: [], nonMinor: [/^/] };
    const siblingIds = [
      ...new Set([...signals.values()].flatMap((row) => row.siblings.map((s) => s.id))),
    ];
    const siblingRead = await readScannerCsamVerdicts(siblingIds);
    if (!siblingRead) scannerRead = false;
    const presentHits = async (imageIds: number[]) =>
      new Map(
        imageIds.map((id) => [id, siblingRead?.get(id) === 'hit' ? 'hit' : 'clear'] as const)
      );
    for (const id of part) {
      const row = signals.get(id);
      if (!row) continue;
      const routesHeld = await imageRoutesHeld(
        {
          ...row,
          unreadable: false,
          siblings: row.siblings
            .slice(0, URL_SIBLING_CAP - 1)
            .map((sibling) => ({ ...sibling, unreadable: false })),
        },
        {
          patterns: clean,
          verdict: verdicts?.get(id) === 'hit' ? 'hit' : 'clear',
          readVerdicts: presentHits,
        }
      );
      if (routesHeld) held.add(id);
    }
  }
  return { held, scannerRead };
}

async function alreadyRecorded(imageIds: number[]) {
  const rows = await dbWrite.$queryRaw<Served[]>`
    SELECT "entityId" AS "imageId", "reviewBatchId" AS "batchHash"
    FROM "ModActivity"
    WHERE activity = ${ROUTING_MISS_ACTIVITY} AND "entityType" = 'image'
      AND "entityId" IN (${Prisma.join(imageIds)})
  `;
  return new Set(rows.map((row) => `${row.imageId}:${row.batchHash}`));
}

async function recordMiss({ imageId, batchHash }: Served) {
  const [report] = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT cr.id FROM "CsamReport" cr
    WHERE cr.images @> jsonb_build_array(jsonb_build_object('id', ${imageId}::int))
       OR cr."userId" = (SELECT "userId" FROM "Image" WHERE id = ${imageId})
    ORDER BY cr.id DESC
    LIMIT 1
  `;
  await dbWrite.$executeRaw`
    INSERT INTO "ModActivity" ("userId", "entityType", "entityId", activity, "reviewBatchId", "reviewTier")
    VALUES
      (${SYSTEM_USER_ID}, 'image', ${imageId}, ${ROUTING_MISS_ACTIVITY}, ${batchHash}, 'general')
      ${
        report
          ? Prisma.sql`, (${SYSTEM_USER_ID}, 'csamReport', ${report.id}, ${ROUTING_MISS_ACTIVITY}, ${batchHash}, 'general')`
          : Prisma.empty
      }
    ON CONFLICT DO NOTHING
  `;
}

export const reviewBatchRoutingMissJob = createJob(
  'review-batch-routing-miss',
  '23 7 * * *',
  async () => {
    try {
      return await checkReviewBatchRoutingMisses();
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'review-batch-routing-miss-check',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }
);
