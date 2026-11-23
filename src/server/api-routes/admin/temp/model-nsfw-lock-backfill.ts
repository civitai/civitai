/**
 * One-off backfill for the model nsfw lock policy (lock = sexual intent only): lifts the nsfw lock the
 * text scan put on models before it stopped locking, and keeps the rating. Deleted once the backfill
 * is applied.
 *
 * POST /api/admin/temp/model-nsfw-lock-backfill   (moderator session or `Authorization: Bearer <moderator API key>`)
 *   { "bucket": "scan-locks", "dryRun"?: true, "limit"?: 300, "afterId"?: 0 }
 *     Dry run (the default): counts the bucket and each exclusion, and lists the next `limit` ids
 *     after `afterId`. A write run unlocks those same ids, each re-checked against the selector in the
 *     UPDATE itself, and records the prior lockedProperties in `meta.nsfwLockBackfill`.
 *
 * Excluded, and left locked: a model a moderator ruled on since the lock, one with a pending lock
 * review, a minor or poi model, and any model whose owner has a CSAM report, an evidence hold, an
 * account hold or a SexualMinor ban.
 */
import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { ownerHeldSql } from '~/server/services/legal-hold.service';
import { bustPublicModelResponseCache } from '~/server/services/public-model-response-cache';
import { MODERATOR_NSFW_LOCK_ACTIVITIES } from '~/server/services/rating-review.entities';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { SCAN_RATING_SOURCES } from '~/server/utils/minor-flag-meta';

const schema = z.object({
  bucket: z.literal('scan-locks'),
  dryRun: z.boolean().default(true),
  limit: z.number().int().min(1).max(500).default(300),
  afterId: z.number().int().min(0).default(0),
});

/** A model with an nsfw lock whose origin marker is the text scan's. */
const scanLockSql = Prisma.sql`
  m."deletedAt" IS NULL
  AND 'nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[]))
  AND jsonb_typeof(m.meta) = 'object'
  AND m.meta->'systemNsfwLock'->>'source' = ANY(${[...SCAN_RATING_SOURCES]}::text[])
`;

/**
 * Each reason a scan-locked model keeps its lock. Fail closed: a marker with no readable time counts
 * as ruled on, since a ruling after it cannot be ruled out.
 */
const exclusions = {
  moderatorRuled: Prisma.sql`(
    COALESCE(m.meta->'systemNsfwLock'->>'at', '') !~ '^\\d{4}-\\d{2}-\\d{2}T'
    OR EXISTS (
      SELECT 1 FROM "ModActivity" ma
      WHERE ma."entityType" = 'model' AND ma."entityId" = m.id
        AND ma.activity = ANY(${[...MODERATOR_NSFW_LOCK_ACTIVITIES, 'rejectLockReview']}::text[])
        AND ma."userId" IS DISTINCT FROM ${constants.system.user.id}
        AND ma."createdAt" > (m.meta->'systemNsfwLock'->>'at')::timestamptz
    )
  )`,
  pendingLockReview: Prisma.sql`EXISTS (
    SELECT 1 FROM "Appeal" a
    WHERE a."entityType" = 'Model' AND a."entityId" = m.id AND a.status = 'Pending'
  )`,
  minorOrPoi: Prisma.sql`(m.minor OR m.poi)`,
  ownerCsamReport: Prisma.sql`EXISTS (
    SELECT 1 FROM "CsamReport" r
    WHERE r."userId" = m."userId" OR r.details->>'secondaryUserId' = m."userId"::text
  )`,
  ownerEvidenceHold: Prisma.sql`EXISTS (SELECT 1 FROM "EvidenceHold" h WHERE h."userId" = m."userId")`,
  ownerSexualMinorBan: Prisma.sql`EXISTS (
    SELECT 1 FROM "User" u
    WHERE u.id = m."userId" AND u.meta->'banDetails'->>'reasonCode' LIKE 'SexualMinor%'
  )`,
  ownerAccountHold: ownerHeldSql(Prisma.raw('m."userId"')),
} as const;
type Exclusion = keyof typeof exclusions;

/** The models this backfill may unlock: scan-locked, and none of the exclusions. */
export const scanLockEligibleSql = Prisma.sql`${scanLockSql} AND NOT (${Prisma.join(
  Object.values(exclusions),
  ' OR '
)})`;

/** The dry-run count: the bucket, what is eligible, and each exclusion. */
export function scanLockCountSql() {
  const names = Object.keys(exclusions) as Exclusion[];
  const columns = names.map(
    (name) =>
      Prisma.sql`count(*) FILTER (WHERE ${exclusions[name]})::int AS ${Prisma.raw(`"${name}"`)}`
  );
  return Prisma.sql`
    SELECT count(*)::int AS "scanLocked",
      count(*) FILTER (WHERE NOT (${Prisma.join(
        Object.values(exclusions),
        ' OR '
      )}))::int AS "eligible",
      ${Prisma.join(columns, ', ')}
    FROM "Model" m
    WHERE ${scanLockSql}
  `;
}

export async function countScanLocks() {
  const [row] = await dbWrite.$queryRaw<Record<string, number>[]>(scanLockCountSql());
  return row;
}

export async function nextScanLockBatch(afterId: number, limit: number) {
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT m.id FROM "Model" m
    WHERE m.id > ${afterId} AND ${scanLockEligibleSql}
    ORDER BY m.id
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

/** Unlocks `ids` that are still eligible; the rating, the marker and every other lock stay. */
export async function unlockScanLocks(ids: number[]) {
  if (!ids.length) return [];
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "Model" m
    SET "lockedProperties" = array_remove(m."lockedProperties", 'nsfw'),
        meta = m.meta || jsonb_build_object('nsfwLockBackfill', jsonb_build_object(
          'at', now(),
          'bucket', 'scan-locks',
          'priorLockedProperties', to_jsonb(m."lockedProperties")
        ))
    WHERE m.id = ANY(${ids}::int[]) AND ${scanLockEligibleSql}
    RETURNING m.id
  `;
  return rows.map((r) => r.id);
}

export default defineModeratorEndpoint('model.nsfwLockBackfill', {
  summary: 'One-off: lift the nsfw lock the text scan set on models, keeping the rating.',
  returns: '{ bucket, dryRun, counts, ids, unlocked?, nextAfterId }',
  notes: [
    'dryRun defaults to true: counts and the next batch of ids, no writes.',
    'A write run re-checks every id in the UPDATE, so a row that changed since the dry run is skipped.',
  ],
  rateLimit: { max: 10, windowSeconds: 60 },
  input: schema,
  async handler(input) {
    const counts = await countScanLocks();
    const ids = await nextScanLockBatch(input.afterId, input.limit);
    const nextAfterId = ids.length ? ids[ids.length - 1] : input.afterId;
    if (input.dryRun) return { bucket: input.bucket, dryRun: true, counts, ids, nextAfterId };

    const unlocked = await unlockScanLocks(ids);
    if (unlocked.length) await bustPublicModelResponseCache(unlocked);
    logToAxiom({
      type: 'info',
      name: 'model-nsfw-lock-backfill',
      message: 'unlocked',
      payload: {
        bucket: input.bucket,
        requested: ids.length,
        unlocked: unlocked.length,
        firstId: ids[0],
        lastId: nextAfterId,
      },
    });
    return { bucket: input.bucket, dryRun: false, counts, ids, unlocked, nextAfterId };
  },
});
