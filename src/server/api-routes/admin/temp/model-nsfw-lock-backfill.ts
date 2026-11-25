/**
 * One-off backfill for the model nsfw lock policy (lock = sexual intent only): lifts the nsfw lock a
 * system check put on models before the policy changed, and keeps the rating. Deleted once the
 * backfill is applied.
 *
 * POST /api/admin/temp/model-nsfw-lock-backfill   (moderator session or `Authorization: Bearer <moderator API key>`)
 *   { "bucket": "scan-locks" | "profanity-locks", "action"?: "unlock", "dryRun"?: true, "limit"?: 300, "afterId"?: 0 }
 *     Dry run (the default): counts the bucket and each exclusion, and lists the next `limit` ids
 *     after `afterId`. A write run unlocks those same ids, each re-checked against the selector in the
 *     UPDATE itself, and records the prior state in `meta.nsfwLockBackfill`.
 *   { "bucket": ..., "action": "revert", ... }
 *     Puts back what an unlock lifted, from `meta.nsfwLockBackfill`, and marks the model reverted so a
 *     later unlock run skips it. Dry run by default too.
 *
 * The buckets:
 * - `scan-locks`: the text scan's locks. The lock goes; the scan's marker stays, as on any unlocked
 *   scan rating, so the owner still cannot untick mature while the text stands.
 * - `profanity-locks`: the save-time profanity filter's locks. The lock and the filter's marker go
 *   (the marker is parked in the record), and the same call submits a forced text scan of each changed
 *   id (the scan's earlier verdict was skipped under the lock), at most 200 a call. An R+ read stamps
 *   the scan's own marker; a clean read leaves the rating as it is. Each scan's outcome is recorded on
 *   the row (`meta.nsfwLockBackfill.scan`); an id not submitted is locked again in the same call and
 *   listed in `scans.notSubmitted` and `scans.relocked`. Its dry run counts `unlockedUnscanned`.
 *   A model not rated mature keeps its lock: a re-scan would rate it. A revert skips a model whose
 *   rating changed since the unlock, and reports it in `skippedRatingChanged`.
 *
 * Excluded, and left locked: a model a moderator ruled on since the lock, one with a pending lock
 * review, a minor or poi model, one with a real-person or minor detection still pending, one already
 * reverted, and any model whose owner, now or before, has a CSAM report, an evidence hold, an account
 * hold or a SexualMinor ban.
 */
import { Prisma } from '@prisma/client';
import pLimit from 'p-limit';
import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { modelDetectionHeldSql } from '~/server/services/lock-review.service';
import { pendingMinorHashMatchIdsSql } from '~/server/services/minor-hash.service';
import { updateModelNsfwLevels } from '~/server/services/nsfwLevels.service';
import { bustPublicModelResponseCache } from '~/server/services/public-model-response-cache';
import { MODERATOR_NSFW_LOCK_ACTIVITIES } from '~/server/services/rating-review.entities';
import { getTextScanMode } from '~/server/services/text-scan/mode';
import { scanEntity } from '~/server/services/text-scan/submit';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { SCAN_RATING_SOURCES } from '~/server/utils/minor-flag-meta';

const BUCKETS = ['scan-locks', 'profanity-locks'] as const;
export type Bucket = (typeof BUCKETS)[number];

export const backfillSchema = z.object({
  bucket: z.enum(BUCKETS),
  action: z.enum(['unlock', 'revert']).default('unlock'),
  dryRun: z.boolean().default(true),
  limit: z.number().int().min(1).max(500).default(300),
  afterId: z.number().int().min(0).default(0),
});

/** The marker sources each bucket's locks carry, and the name its dry run counts them under. */
const BUCKET_LOCKS: Record<Bucket, { sources: readonly string[]; counted: string }> = {
  'scan-locks': { sources: SCAN_RATING_SOURCES, counted: 'scanLocked' },
  'profanity-locks': { sources: ['profanity-filter'], counted: 'profanityLocked' },
};

const lockSql = (bucket: Bucket) => Prisma.sql`
  m."deletedAt" IS NULL
  AND 'nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[]))
  AND jsonb_typeof(m.meta) = 'object'
  AND m.meta->'systemNsfwLock'->>'source' = ANY(${[...BUCKET_LOCKS[bucket].sources]}::text[])
`;

/** Every user who has owned the model aliased `m`: its owner now, and each owner "ModelOwnership" records. */
const everyOwnerSql = Prisma.sql`(
  SELECT m."userId" AS "ownerId"
  UNION SELECT o."userId" FROM "ModelOwnership" o WHERE o."modelId" = m.id
)`;

/**
 * Whether a moderator ruled on the nsfw lock of the model aliased `m` after the time `at` (a text
 * SQL expression). Fail closed: a time that cannot be read counts as ruled on, since a ruling after it
 * cannot be ruled out.
 */
const moderatorRuledSinceSql = (at: Prisma.Sql) => Prisma.sql`(
  COALESCE(${at}, '') !~ '^\\d{4}-\\d{2}-\\d{2}T'
  OR EXISTS (
    SELECT 1 FROM "ModActivity" ma
    WHERE ma."entityType" = 'model' AND ma."entityId" = m.id
      AND ma.activity = ANY(${[...MODERATOR_NSFW_LOCK_ACTIVITIES, 'rejectLockReview']}::text[])
      AND ma."userId" IS DISTINCT FROM ${constants.system.user.id}
      AND ma."createdAt" > (${at})::timestamptz
  )
)`;

/** Each reason a locked model keeps its lock, in every bucket; each fails closed. */
export const exclusions = {
  moderatorRuled: moderatorRuledSinceSql(Prisma.sql`m.meta->'systemNsfwLock'->>'at'`),
  pendingLockReview: Prisma.sql`EXISTS (
    SELECT 1 FROM "Appeal" a
    WHERE a."entityType" = 'Model' AND a."entityId" = m.id AND a.status = 'Pending'
  )`,
  minorOrPoi: Prisma.sql`(m.minor OR m.poi)`,
  // A real-person or minor detection a moderator has not ruled on: what stops a lock review's approval.
  pendingDetection: Prisma.sql`(${modelDetectionHeldSql} OR m.id IN (${pendingMinorHashMatchIdsSql()}))`,
  reverted: Prisma.sql`(m.meta->'nsfwLockBackfill'->>'revertedAt') IS NOT NULL`,
  // Two EXISTS rather than one OR, so the subject leg can use the CsamReport userId index.
  ownerCsamReport: Prisma.sql`(EXISTS (
    SELECT 1 FROM ${everyOwnerSql} ow JOIN "CsamReport" r ON r."userId" = ow."ownerId"
  ) OR EXISTS (
    SELECT 1 FROM ${everyOwnerSql} ow
    JOIN "CsamReport" r ON r.details->>'secondaryUserId' = ow."ownerId"::text
  ))`,
  ownerSexualMinorBan: Prisma.sql`EXISTS (
    SELECT 1 FROM ${everyOwnerSql} ow JOIN "User" u ON u.id = ow."ownerId"
    WHERE u.meta->'banDetails'->>'reasonCode' LIKE 'SexualMinor%'
  )`,
} as const;

/** The bucket's exclusions: every shared one, and for profanity locks a model not rated mature,
 *  which the re-scan after the unlock would rate. */
function exclusionsOf(bucket: Bucket): Record<string, Prisma.Sql> {
  if (bucket === 'scan-locks') return exclusions;
  return { ...exclusions, notMature: Prisma.sql`NOT m.nsfw` };
}

/** Which exclusions apply to model `id`, for the tests: one leg each, so a narrowed leg shows. */
export async function exclusionsFor(id: number, bucket: Bucket) {
  const legs = exclusionsOf(bucket);
  const names = Object.keys(legs);
  const [row] = await dbWrite.$queryRaw<Record<string, boolean>[]>`
    SELECT ${Prisma.join(
      names.map((name) => Prisma.sql`(${legs[name]}) AS ${Prisma.raw(`"${name}"`)}`),
      ', '
    )}
    FROM "Model" m WHERE m.id = ${id}
  `;
  return names.filter((name) => row?.[name]);
}

export const eligibleSql = (bucket: Bucket) =>
  Prisma.sql`${lockSql(bucket)} AND NOT (${Prisma.join(
    Object.values(exclusionsOf(bucket)),
    ' OR '
  )})`;

/** The dry-run count: the bucket, what is eligible, and each exclusion. */
export function lockCountSql(bucket: Bucket) {
  const legs = exclusionsOf(bucket);
  const columns = Object.entries(legs).map(
    ([name, leg]) => Prisma.sql`count(*) FILTER (WHERE ${leg})::int AS ${Prisma.raw(`"${name}"`)}`
  );
  return Prisma.sql`
    SELECT count(*)::int AS ${Prisma.raw(`"${BUCKET_LOCKS[bucket].counted}"`)},
      count(*) FILTER (WHERE NOT (${Prisma.join(Object.values(legs), ' OR ')}))::int AS "eligible",
      ${Prisma.join(columns, ', ')}
    FROM "Model" m
    WHERE ${lockSql(bucket)}
  `;
}

export async function countLocks(bucket: Bucket) {
  const [row] = await dbWrite.$queryRaw<Record<string, number>[]>(lockCountSql(bucket));
  return row;
}

export async function nextUnlockBatch(bucket: Bucket, afterId: number, limit: number) {
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT m.id FROM "Model" m
    WHERE m.id > ${afterId} AND ${eligibleSql(bucket)}
    ORDER BY m.id
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

/**
 * Unlocks `ids` that are still eligible; the rating and every other lock stay. The record keeps the
 * prior locks, rating and marker. A scan lock keeps its marker; a profanity lock's marker is parked in
 * the record, so the re-scan can stamp the scan's own.
 */
export async function unlockLocks(bucket: Bucket, ids: number[]) {
  if (!ids.length) return [];
  const meta =
    bucket === 'profanity-locks' ? Prisma.sql`(m.meta - 'systemNsfwLock')` : Prisma.sql`m.meta`;
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "Model" m
    SET "lockedProperties" = array_remove(m."lockedProperties", 'nsfw'),
        meta = ${meta} || jsonb_build_object('nsfwLockBackfill', jsonb_build_object(
          'at', now(),
          'bucket', ${bucket}::text,
          'priorLockedProperties', to_jsonb(m."lockedProperties"),
          'priorNsfw', m.nsfw,
          'priorSystemNsfwLock', m.meta->'systemNsfwLock'
        ))
    WHERE m.id = ANY(${ids}::int[]) AND ${eligibleSql(bucket)}
    RETURNING m.id
  `;
  return rows.map((r) => r.id);
}

/**
 * A profanity unlock whose model has a different rating now. A moderator who changes only the rating
 * logs no ModActivity, so a change since the unlock, by anyone, wins over a revert: such a model is
 * left as it is and reported in `skippedRatingChanged`. Compared as jsonb, so an unreadable
 * `priorNsfw` counts as changed and never throws.
 */
const ratingChangedSql = Prisma.sql`(m.meta->'nsfwLockBackfill'->'priorNsfw') IS DISTINCT FROM to_jsonb(m.nsfw)`;

/**
 * What a revert of the bucket still finds as the unlock left it. A scan lock: its scan marker is
 * there. A profanity lock: the rating it had, no nsfw lock since, and no marker but the one the
 * re-scan stamped after the unlock (an unreadable time counts as not).
 */
const unlockedStateSql = (bucket: Bucket) =>
  bucket === 'scan-locks'
    ? Prisma.sql`m.meta->'systemNsfwLock'->>'source' = ANY(${[...SCAN_RATING_SOURCES]}::text[])`
    : Prisma.sql`
      NOT ${ratingChangedSql}
      AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
      AND jsonb_typeof(m.meta->'nsfwLockBackfill'->'priorSystemNsfwLock') = 'object'
      AND (
        m.meta->'systemNsfwLock' IS NULL
        OR (
          m.meta->'systemNsfwLock'->>'source' = ANY(${[...SCAN_RATING_SOURCES]}::text[])
          AND CASE WHEN COALESCE(m.meta->'systemNsfwLock'->>'at', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
            THEN (m.meta->'systemNsfwLock'->>'at')::timestamptz
              >= (m.meta->'nsfwLockBackfill'->>'at')::timestamptz
            ELSE false END
        )
      )`;

/**
 * A model an unlock run of the bucket changed and no revert has put back yet. A moderator's decision
 * since the unlock wins over a revert: a model they ruled on since is left as it is, and so is one
 * no longer as the unlock left it (`unlockedStateSql`). A model now minor, poi or SFW-only is left too,
 * in both buckets: a lock put back on it would hold a rating it may not carry.
 */
const revertableSql = (bucket: Bucket) => Prisma.sql`
  jsonb_typeof(m.meta) = 'object'
  AND NOT (m.minor OR m.poi OR m."sfwOnly")
  AND m.meta->'nsfwLockBackfill'->>'bucket' = ${bucket}
  AND (m.meta->'nsfwLockBackfill'->>'revertedAt') IS NULL
  AND jsonb_typeof(m.meta->'nsfwLockBackfill'->'priorLockedProperties') = 'array'
  AND ${unlockedStateSql(bucket)}
  AND NOT ${moderatorRuledSinceSql(Prisma.sql`m.meta->'nsfwLockBackfill'->>'at'`)}
`;

/** Profanity unlocks a revert skips because their rating changed since; at most 100 of their ids. */
export async function ratingChangedSinceUnlock() {
  const rows = await dbWrite.$queryRaw<{ id: number; total: number }[]>`
    SELECT m.id, count(*) OVER ()::int AS total FROM "Model" m
    WHERE jsonb_typeof(m.meta) = 'object'
      AND m.meta->'nsfwLockBackfill'->>'bucket' = 'profanity-locks'
      AND (m.meta->'nsfwLockBackfill'->>'revertedAt') IS NULL
      AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
      AND ${ratingChangedSql}
    ORDER BY m.id
    LIMIT 100
  `;
  return { count: rows[0]?.total ?? 0, ids: rows.map((r) => r.id) };
}

export async function nextRevertBatch(bucket: Bucket, afterId: number, limit: number) {
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT m.id FROM "Model" m
    WHERE m.id > ${afterId} AND ${revertableSql(bucket)}
    ORDER BY m.id
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

/** The locks the unlock recorded, in their order, then any lock set since. */
const priorLocksMergedSql = Prisma.sql`ARRAY(
  SELECT p FROM (
    SELECT p, min(o) AS o FROM unnest(
      ARRAY(SELECT jsonb_array_elements_text(m.meta->'nsfwLockBackfill'->'priorLockedProperties'))
        || COALESCE(m."lockedProperties", ARRAY[]::text[])
    ) WITH ORDINALITY AS t(p, o)
    GROUP BY p
  ) merged ORDER BY o
)`;

/**
 * Puts back what the unlock lifted: the prior locks, in their order, then any lock set since. A
 * profanity lock also gets back its exact marker; its rating is the prior one, or it is not reverted.
 * Marks the record reverted, so neither a second revert nor a later unlock run touches the model.
 */
export async function revertLocks(bucket: Bucket, ids: number[]) {
  if (!ids.length) return [];
  const meta =
    bucket === 'profanity-locks'
      ? Prisma.sql`(m.meta || jsonb_build_object('systemNsfwLock', m.meta->'nsfwLockBackfill'->'priorSystemNsfwLock'))`
      : Prisma.sql`m.meta`;
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "Model" m
    SET "lockedProperties" = ${priorLocksMergedSql},
        meta = jsonb_set(${meta}, '{nsfwLockBackfill,revertedAt}', to_jsonb(now()))
    WHERE m.id = ANY(${ids}::int[]) AND ${revertableSql(bucket)}
    RETURNING m.id
  `;
  return rows.map((r) => r.id);
}

/** The profanity-locks batch: one forced scan per changed id, as many as one text-scan-rescan call. */
export const PROFANITY_BATCH_LIMIT = 200;

/**
 * A forced text scan of model `id`, as `text-scan-rescan` submits it: `submitted`, or why not. Only
 * an `active` model is submitted; elsewhere the save-time profanity filter still runs on each save.
 */
async function scanModelText(id: number): Promise<string> {
  const mode = await getTextScanMode('Model', id);
  if (mode !== 'active') return `not-active/${mode}`;
  try {
    const scan = await scanEntity({ entityType: 'Model', entityId: id, force: true });
    return scan.status === 'skipped' ? `skipped/${scan.reason}` : scan.status;
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'model-nsfw-lock-backfill',
      message: 'scan submit threw',
      payload: { id, error: (e as Error).message },
    });
    return 'threw';
  }
}

/**
 * Records each scan outcome on the unlock's record (`meta.nsfwLockBackfill.scan`), so a model whose
 * scan was not submitted shows on the row as well as in the response.
 */
export async function recordScans(outcomes: { id: number; status: string }[]) {
  if (!outcomes.length) return;
  await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = jsonb_set(m.meta, '{nsfwLockBackfill,scan}',
      jsonb_build_object('status', o.status, 'at', now()))
    FROM unnest(${outcomes.map((o) => o.id)}::int[], ${outcomes.map((o) => o.status)}::text[])
      AS o(id, status)
    WHERE m.id = o.id AND jsonb_typeof(m.meta->'nsfwLockBackfill') = 'object'
  `;
}

/**
 * Locks again, in the same call, a profanity unlock whose forced scan was not submitted: nothing else
 * holds its rating (`assertScanRatingKept` needs the lock or a scan marker). The prior locks, the
 * filter's marker and the prior rating come back (an owner may have unticked mature since the unlock,
 * and a lock must not hold that). The record's `scan` says `failed-relocked`, or
 * `relocked-nsfw-restored` where the rating had to come back, with the reason. A later
 * run from `afterId: 0` picks the model up again; a revert never does, since it is locked.
 */
/** The rating the unlock recorded, or the current one where the record holds none readable. */
const priorNsfwSql = Prisma.sql`CASE WHEN jsonb_typeof(m.meta->'nsfwLockBackfill'->'priorNsfw') = 'boolean'
  THEN (m.meta->'nsfwLockBackfill'->>'priorNsfw')::boolean ELSE m.nsfw END`;

export async function relockUnscanned(outcomes: { id: number; status: string }[]) {
  if (!outcomes.length) return [];
  const rows = await dbWrite.$queryRaw<{ id: number; ratingRestored: boolean }[]>`
    UPDATE "Model" m
    SET "lockedProperties" = ${priorLocksMergedSql},
        nsfw = ${priorNsfwSql},
        meta = jsonb_set(
          m.meta || jsonb_build_object('systemNsfwLock', m.meta->'nsfwLockBackfill'->'priorSystemNsfwLock'),
          '{nsfwLockBackfill,scan}',
          jsonb_build_object(
            'status',
            CASE WHEN m.nsfw IS DISTINCT FROM ${priorNsfwSql}
              THEN 'relocked-nsfw-restored' ELSE 'failed-relocked' END,
            'reason', o.status, 'at', now()
          )
        )
    FROM unnest(${outcomes.map((o) => o.id)}::int[], ${outcomes.map((o) => o.status)}::text[])
      AS o(id, status), "Model" old
    WHERE m.id = o.id AND old.id = o.id
      AND jsonb_typeof(m.meta) = 'object'
      AND m.meta->'nsfwLockBackfill'->>'bucket' = 'profanity-locks'
      AND (m.meta->'nsfwLockBackfill'->>'revertedAt') IS NULL
      AND jsonb_typeof(m.meta->'nsfwLockBackfill'->'priorLockedProperties') = 'array'
      AND jsonb_typeof(m.meta->'nsfwLockBackfill'->'priorSystemNsfwLock') = 'object'
    RETURNING m.id, old.nsfw IS DISTINCT FROM m.nsfw AS "ratingRestored"
  `;
  return rows;
}

/**
 * Profanity unlocks neither scanned nor locked again: a call that died between its unlock and its
 * scans, or before its relock. Only a dry run reads it, for the operator to relock or re-scan those ids.
 */
export async function countUnlockedUnscanned() {
  const [row] = await dbWrite.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "Model" m
    WHERE jsonb_typeof(m.meta) = 'object'
      AND m.meta->'nsfwLockBackfill'->>'bucket' = 'profanity-locks'
      AND (m.meta->'nsfwLockBackfill'->>'revertedAt') IS NULL
      AND COALESCE(m.meta->'nsfwLockBackfill'->'scan'->>'status', '') NOT IN ('submitted', 'failed-relocked', 'relocked-nsfw-restored')
  `;
  return row?.count ?? 0;
}

const writeEffects = { bustPublicModelResponseCache, scanModelText, updateModelNsfwLevels };

/**
 * Submits the forced scan of every model a profanity unlock changed, in the same call, since its owner
 * can untick mature once the lock and the filter's marker are gone and until a scan stamps its own.
 */
async function scanUnlocked(
  ids: number[],
  {
    scanModelText,
    updateModelNsfwLevels,
  }: Pick<typeof writeEffects, 'scanModelText' | 'updateModelNsfwLevels'>
) {
  const limit = pLimit(2);
  const outcomes = await Promise.all(
    ids.map((id) =>
      limit(async () => ({ id, status: await scanModelText(id).catch(() => 'threw') }))
    )
  );
  await recordScans(outcomes);
  const byStatus = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});
  const failed = outcomes.filter((o) => o.status !== 'submitted');
  const rows = await relockUnscanned(failed);
  const ratingRestored = rows.filter((r) => r.ratingRestored).map((r) => r.id);
  if (ratingRestored.length) await updateModelNsfwLevels(ratingRestored);
  const relocked = rows.map((r) => r.id);
  return {
    byStatus,
    notSubmitted: failed.map((o) => o.id),
    relocked,
    relockedCount: relocked.length,
    ratingRestored,
    ratingRestoredCount: ratingRestored.length,
  };
}

export async function runBackfill(
  input: z.infer<typeof backfillSchema>,
  effects: typeof writeEffects = writeEffects
) {
  const { bustPublicModelResponseCache } = effects;
  const { bucket, action, dryRun, afterId } = input;
  const profanity = bucket === 'profanity-locks';
  const limit = profanity ? Math.min(input.limit, PROFANITY_BATCH_LIMIT) : input.limit;
  const ids =
    action === 'revert'
      ? await nextRevertBatch(bucket, afterId, limit)
      : await nextUnlockBatch(bucket, afterId, limit);
  const nextAfterId = ids.length ? ids[ids.length - 1] : afterId;
  const skippedRatingChanged =
    // A scan of every unlocked model, so once per pass: on its first call.
    profanity && action === 'revert' && afterId === 0
      ? await ratingChangedSinceUnlock()
      : undefined;
  // The bucket count scans every locked model of the bucket, so only an unlock dry run pays for it.
  if (dryRun) {
    const counts =
      action === 'unlock'
        ? {
            ...(await countLocks(bucket)),
            ...(profanity ? { unlockedUnscanned: await countUnlockedUnscanned() } : {}),
          }
        : undefined;
    return {
      bucket,
      action,
      dryRun: true as const,
      limit,
      counts,
      skippedRatingChanged,
      ids,
      nextAfterId,
    };
  }

  const changed =
    action === 'revert' ? await revertLocks(bucket, ids) : await unlockLocks(bucket, ids);
  const scans =
    profanity && action === 'unlock' && changed.length
      ? await scanUnlocked(changed, effects)
      : undefined;
  if (changed.length) await bustPublicModelResponseCache(changed);
  logToAxiom({
    type: scans?.notSubmitted.length ? 'error' : 'info',
    name: 'model-nsfw-lock-backfill',
    message: action === 'revert' ? 'reverted' : 'unlocked',
    payload: {
      bucket,
      action,
      requested: ids.length,
      changed: changed.length,
      ids: changed,
      scans,
      skippedRatingChanged,
    },
  });
  return {
    bucket,
    action,
    dryRun: false as const,
    limit,
    ids,
    changed,
    scans,
    skippedRatingChanged,
    nextAfterId,
  };
}

export default defineModeratorEndpoint('model.nsfwLockBackfill', {
  summary:
    'One-off: lift the nsfw lock the text scan or the profanity filter set on models, keeping the rating; or revert it.',
  returns:
    '{ bucket, action, dryRun, limit, counts?, ids, changed?, scans?, skippedRatingChanged?, nextAfterId }',
  notes: [
    'dryRun defaults to true: the next batch of ids (and, for unlock, the counts), no writes.',
    'A write run re-checks every id in the UPDATE, so a row that changed since the dry run is skipped.',
    'action "revert" restores what meta.nsfwLockBackfill recorded and marks the model reverted.',
    'profanity-locks: at most 200 ids a call; an unlock submits a forced text scan of each changed id; one not submitted is locked again at its prior rating (scans.relocked; scans.ratingRestored where an owner change was undone). Benign skips (not-public, too-short) relock on every pass.',
    'profanity-locks revert: a model whose rating changed since the unlock is skipped and counted in skippedRatingChanged.',
  ],
  rateLimit: { max: 10, windowSeconds: 60 },
  input: backfillSchema,
  handler: (input) => runBackfill(input),
});
