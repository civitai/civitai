/**
 * One-off backfill for the model nsfw lock policy (lock = sexual intent only): lifts the nsfw lock the
 * text scan put on models before it stopped locking, and keeps the rating. Deleted once the backfill
 * is applied.
 *
 * POST /api/admin/temp/model-nsfw-lock-backfill   (moderator session or `Authorization: Bearer <moderator API key>`)
 *   { "bucket": "scan-locks", "action"?: "unlock", "dryRun"?: true, "limit"?: 300, "afterId"?: 0 }
 *     Dry run (the default): counts the bucket and each exclusion, and lists the next `limit` ids
 *     after `afterId`. A write run unlocks those same ids, each re-checked against the selector in the
 *     UPDATE itself, and records the prior lockedProperties in `meta.nsfwLockBackfill`.
 *   { "bucket": "scan-locks", "action": "revert", ... }
 *     Puts back the locks an unlock lifted, from `meta.nsfwLockBackfill.priorLockedProperties`, and
 *     marks the model reverted so a later unlock run skips it. Dry run by default too.
 *
 * Excluded, and left locked: a model a moderator ruled on since the lock, one with a pending lock
 * review, a minor or poi model, one already reverted, and any model whose owner, now or before, has a
 * CSAM report, an evidence hold, an account hold or a SexualMinor ban.
 */
import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { modelRowHeldSql } from '~/server/services/legal-hold.service';
import { bustPublicModelResponseCache } from '~/server/services/public-model-response-cache';
import { MODERATOR_NSFW_LOCK_ACTIVITIES } from '~/server/services/rating-review.entities';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { SCAN_RATING_SOURCES } from '~/server/utils/minor-flag-meta';

export const backfillSchema = z.object({
  bucket: z.literal('scan-locks'),
  action: z.enum(['unlock', 'revert']).default('unlock'),
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

/** Every user who has owned the model aliased `m`: its owner now, and each owner "ModelOwnership" records. */
const everyOwnerSql = Prisma.sql`(
  SELECT m."userId" AS "ownerId"
  UNION SELECT o."userId" FROM "ModelOwnership" o WHERE o."modelId" = m.id
)`;

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
  reverted: Prisma.sql`(m.meta->'nsfwLockBackfill'->>'revertedAt') IS NOT NULL`,
  ownerCsamReport: Prisma.sql`EXISTS (
    SELECT 1 FROM ${everyOwnerSql} ow
    JOIN "CsamReport" r
      ON r."userId" = ow."ownerId" OR r.details->>'secondaryUserId' = ow."ownerId"::text
  )`,
  ownerEvidenceHold: Prisma.sql`EXISTS (
    SELECT 1 FROM ${everyOwnerSql} ow JOIN "EvidenceHold" h ON h."userId" = ow."ownerId"
  )`,
  ownerSexualMinorBan: Prisma.sql`EXISTS (
    SELECT 1 FROM ${everyOwnerSql} ow JOIN "User" u ON u.id = ow."ownerId"
    WHERE u.meta->'banDetails'->>'reasonCode' LIKE 'SexualMinor%'
  )`,
  // The shared model-data hold: every owner's account hold, and the placeholder owner.
  ownerAccountHold: modelRowHeldSql(),
} as const;
export type Exclusion = keyof typeof exclusions;

/** Which exclusions apply to model `id`, for the tests: one leg each, so a narrowed leg shows. */
export async function exclusionsFor(id: number) {
  const names = Object.keys(exclusions) as Exclusion[];
  const [row] = await dbWrite.$queryRaw<Record<Exclusion, boolean>[]>`
    SELECT ${Prisma.join(
      names.map((name) => Prisma.sql`(${exclusions[name]}) AS ${Prisma.raw(`"${name}"`)}`),
      ', '
    )}
    FROM "Model" m WHERE m.id = ${id}
  `;
  return names.filter((name) => row?.[name]);
}

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

/** A model an unlock run changed and no revert has put back yet. */
const revertableSql = Prisma.sql`
  m.meta->'nsfwLockBackfill'->>'bucket' = 'scan-locks'
  AND (m.meta->'nsfwLockBackfill'->>'revertedAt') IS NULL
  AND jsonb_typeof(m.meta->'nsfwLockBackfill'->'priorLockedProperties') = 'array'
`;

export async function nextRevertBatch(afterId: number, limit: number) {
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT m.id FROM "Model" m
    WHERE m.id > ${afterId} AND ${revertableSql}
    ORDER BY m.id
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

/**
 * Puts back the locks the unlock lifted: the prior locks, in their order, then any lock set since.
 * Marks the record reverted, so neither a second revert nor a later unlock run touches the model.
 */
export async function revertScanLocks(ids: number[]) {
  if (!ids.length) return [];
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "Model" m
    SET "lockedProperties" = ARRAY(
          SELECT p FROM (
            SELECT p, min(o) AS o FROM unnest(
              ARRAY(SELECT jsonb_array_elements_text(m.meta->'nsfwLockBackfill'->'priorLockedProperties'))
                || COALESCE(m."lockedProperties", ARRAY[]::text[])
            ) WITH ORDINALITY AS t(p, o)
            GROUP BY p
          ) merged ORDER BY o
        ),
        meta = jsonb_set(m.meta, '{nsfwLockBackfill,revertedAt}', to_jsonb(now()))
    WHERE m.id = ANY(${ids}::int[]) AND ${revertableSql}
    RETURNING m.id
  `;
  return rows.map((r) => r.id);
}

/** The endpoint's work, apart from auth and parsing. */
export async function runBackfill(input: z.infer<typeof backfillSchema>) {
  const { bucket, action, dryRun, afterId, limit } = input;
  const ids =
    action === 'revert'
      ? await nextRevertBatch(afterId, limit)
      : await nextScanLockBatch(afterId, limit);
  const nextAfterId = ids.length ? ids[ids.length - 1] : afterId;
  // The bucket count scans every scan-locked model, so only an unlock dry run pays for it.
  if (dryRun) {
    const counts = action === 'unlock' ? await countScanLocks() : undefined;
    return { bucket, action, dryRun: true as const, counts, ids, nextAfterId };
  }

  const changed = action === 'revert' ? await revertScanLocks(ids) : await unlockScanLocks(ids);
  if (changed.length) await bustPublicModelResponseCache(changed);
  logToAxiom({
    type: 'info',
    name: 'model-nsfw-lock-backfill',
    message: action === 'revert' ? 'reverted' : 'unlocked',
    payload: { bucket, action, requested: ids.length, changed: changed.length, ids: changed },
  });
  return { bucket, action, dryRun: false as const, ids, changed, nextAfterId };
}

export default defineModeratorEndpoint('model.nsfwLockBackfill', {
  summary:
    'One-off: lift the nsfw lock the text scan set on models, keeping the rating; or revert it.',
  returns: '{ bucket, action, dryRun, counts?, ids, changed?, nextAfterId }',
  notes: [
    'dryRun defaults to true: the next batch of ids (and, for unlock, the counts), no writes.',
    'A write run re-checks every id in the UPDATE, so a row that changed since the dry run is skipped.',
    'action "revert" restores meta.nsfwLockBackfill.priorLockedProperties and marks the model reverted.',
  ],
  rateLimit: { max: 10, windowSeconds: 60 },
  input: backfillSchema,
  handler: runBackfill,
});
