import { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import { Tracker } from '~/server/clickhouse/tracker';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { ModelTextModerationOutcome } from '~/server/prom/model-moderation.metrics';
import type { ModelMeta, RestrictedNsfwVerdict } from '~/server/schema/model.schema';
import { enqueueJobs } from '~/server/services/job-queue.service';
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { updateModelNsfwLevels } from '~/server/services/nsfwLevels.service';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import {
  notifyTextScanRatingRaised,
  type NotifyTextScanRatingRaisedArgs,
} from '~/server/services/text-scan/notify';
import type { RatingFloorResult } from '~/server/services/text-scan/rated-entities';
import { diffEntityChanges } from '~/server/utils/entity-change-helpers';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';
import { SCAN_RATING_SOURCES } from '~/server/utils/minor-flag-meta';
import { recordVerdictUnderIntentLock } from '~/server/services/model-com-face-intent.service';
import {
  holdRestrictedVerdict,
  holdsRatingSql,
} from '~/server/services/text-scan/actions/hold-restricted-verdict';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { hasCompleteSfwFace } from '~/shared/utils/model-sfw-face';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

const SYSTEM_USER_ID = constants.system.user.id;

/** What an automatic flip on a restricted model replaced, read from the row being written. */
const appliedRecord = Prisma.sql`jsonb_build_object(
  'at', now(),
  'prior', jsonb_build_object(
    'nsfw', m.nsfw,
    'sfwOnly', m."sfwOnly",
    'lockedProperties', to_jsonb(COALESCE(m."lockedProperties", ARRAY[]::text[])),
    'systemNsfwLock', m.meta->'systemNsfwLock'
  )
)`;

type RawDb = Pick<typeof dbWrite, '$executeRaw' | '$queryRaw'>;

export async function applySystemModelNsfwFlag({
  model,
  source,
  heldLead = false,
}: {
  model: {
    id: number;
    nsfw: boolean;
    nsfwLevel: number;
    lockedProperties: string[] | null;
    userId: number;
    minor: boolean;
    poi: boolean;
    sfwOnly: boolean;
    availability?: string;
    sfwName?: string | null;
    sfwCoverImageId?: number | null;
  };
  source: string;
  /** The flip applies a held lead (`applyHeldRestrictedVerdict`). */
  heldLead?: boolean;
}): Promise<ModelTextModerationOutcome> {
  const stored = model.lockedProperties ?? [];
  // A stored lock is a moderator's call: minor-flagging sets nsfw:false and locks it.
  if (stored.includes('nsfw')) {
    // A prior callback may have written nsfw:true and died before recomputing levels —
    // EntityModeration is already Succeeded by then, so nothing else revisits the row.
    // Gated on the level actually being wrong: `updateModelNsfwLevels` matches every
    // `nsfw = true` row unconditionally, so calling it on a correct row still writes,
    // fires the model row trigger, and queues a Meilisearch re-render.
    // Under the intent check's own lock, the verdict is recorded for whoever lifts it.
    await recordVerdictUnderIntentLock(dbWrite, model.id, source);
    if (model.nsfw && model.nsfwLevel !== nsfwBrowsingLevelsFlag) {
      await updateModelNsfwLevels([model.id]);
      return 'repaired';
    }
    return 'skipped_locked';
  }

  // The caller's read can be stale; the flip's guard decides.
  if (model.minor || model.poi || model.availability === 'Private' || stored.includes('sfwOnly')) {
    const held = await holdRestrictedVerdict(dbWrite, model.id, source);
    if (held) return 'held_restricted';
  }

  // Already mature: nothing to flip. The verdict is still recorded as the origin marker, so the
  // owner cannot undo it alone while the text it was read from stands (`assertScanRatingKept`).
  if (!heldLead && model.nsfw && !locksRating(source)) {
    await markScanRating(dbWrite, model.id, source);
    return 'skipped_nsfw';
  }

  const flipped = await flipRow(dbWrite, model.id, source, heldLead);
  if (!flipped)
    return (await holdRestrictedVerdict(dbWrite, model.id, source))
      ? 'held_restricted'
      : 'declined_race';

  if (model.sfwOnly || heldLead)
    await trackModActivity(SYSTEM_USER_ID, {
      entityType: 'model',
      entityId: model.id,
      activity: 'restrictedNsfwVerdict:autoApply',
    }).catch(() => null);

  await updateModelNsfwLevels([model.id]);
  // The origin-side public response cache keys off browsing level and is otherwise only
  // busted by `upsertModel`.
  await bustPublicModelResponseCache(model.id);

  await new Tracker()
    .entityChanges(
      diffEntityChanges({
        entityType: 'Model',
        entityId: model.id,
        ownerId: model.userId,
        before: { nsfw: model.nsfw, sfwOnly: model.sfwOnly, lockedProperties: stored },
        after: {
          nsfw: true,
          sfwOnly: false,
          ...(locksRating(source) && { lockedProperties: [...stored, 'nsfw'] }),
        },
        actorRole: 'system',
        systemFields: {
          nsfw: source,
          sfwOnly: source,
          ...(locksRating(source) && { lockedProperties: source }),
        },
      })
    )
    .catch(() => null);

  return 'applied';
}

/**
 * Only the text scan rates mature without the lock, so the owner can add a .com face; a rescan that
 * reads the text as not mature releases it (`assertScanRatingKept`). Every other source (xguard, a
 * held profanity-filter lead) locks the rating with its marker, also on a model already mature, and
 * the owner's way out is the lock or rating review.
 */
const locksRating = (source: string) => !SCAN_RATING_SOURCES.includes(source);

/**
 * Drops the text scan's own origin marker after it reads the text as not mature: the owner's way
 * out of `assertScanRatingKept`. Never under a lock, nor another check's marker.
 */
async function dropScanRatingMarker(db: RawDb, modelId: number) {
  await db.$executeRaw`
    UPDATE "Model" m
    SET meta = m.meta - 'systemNsfwLock'
    WHERE m.id = ${modelId}
      AND jsonb_typeof(m.meta) = 'object'
      AND m.meta->'systemNsfwLock'->>'source' = ANY(${[...SCAN_RATING_SOURCES]}::text[])
      AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
  `;
}

/** Stamps the origin marker on a model the scan rated mature but left as it was; an earlier
 *  marker keeps its time. Not on a locked rating, which is a moderator's. */
async function markScanRating(db: RawDb, modelId: number, source: string) {
  await db.$executeRaw`
    UPDATE "Model" m
    SET meta = ${asJsonbObjectSql('m.meta')} || jsonb_build_object(
      'systemNsfwLock', jsonb_build_object('source', ${source}::text, 'at', now())
    )
    WHERE m.id = ${modelId}
      AND NOT (${asJsonbObjectSql('m.meta')} ? 'systemNsfwLock')
      AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
  `;
}

/**
 * Rates the model NSFW, with the `meta.systemNsfwLock` origin marker, and locks it for every source
 * but the text scan (`locksRating`). Guarded in the WHERE, not by a caller's read: a
 * moderator lock or ruling landing in between would otherwise be overwritten. SFW-only is cleared,
 * as it cannot stand with nsfw, and a lead records what it replaced so a moderator can put the
 * owner's rating back. `heldLead`: only while the lead is still there and unapplied, so a ruling
 * made since stands.
 */
async function flipRow(db: RawDb, modelId: number, source: string, heldLead: boolean) {
  const heldLeadGuard = heldLead
    ? Prisma.sql`AND jsonb_typeof(m.meta->'restrictedNsfwVerdict') = 'object'
      AND NOT (m.meta->'restrictedNsfwVerdict' ? 'applied')
      AND NOT (m.meta->'restrictedNsfwVerdict' ? 'liftedBy')`
    : Prisma.empty;
  return db.$executeRaw`
    UPDATE "Model" m
    SET nsfw = TRUE,
        "sfwOnly" = FALSE,
        "lockedProperties" = ${
          locksRating(source)
            ? Prisma.sql`array_append(COALESCE(m."lockedProperties", ARRAY[]::text[]), 'nsfw')`
            : Prisma.sql`m."lockedProperties"`
        },
        meta = ${asJsonbObjectSql('m.meta')} || CASE
          WHEN m."sfwOnly" OR ${asJsonbObjectSql(
            'm.meta'
          )} ? 'restrictedNsfwVerdict' THEN jsonb_build_object(
          'restrictedNsfwVerdict', COALESCE(
            m.meta->'restrictedNsfwVerdict',
            jsonb_build_object('source', ${source}::text, 'at', now(), 'restriction', 'sfwOnly')
          ) || jsonb_build_object('applied', ${appliedRecord}),
          'restrictedNsfwVerdictRulings',
            (CASE WHEN jsonb_typeof(m.meta->'restrictedNsfwVerdictRulings') = 'array'
              THEN m.meta->'restrictedNsfwVerdictRulings' ELSE '[]'::jsonb END)
            || jsonb_build_array(${appliedRecord} || jsonb_build_object(
              'ruling', 'autoApply', 'by', ${SYSTEM_USER_ID}::int,
              'restriction', COALESCE(m.meta->'restrictedNsfwVerdict'->>'restriction', 'sfwOnly')))
        ) ELSE '{}'::jsonb END || jsonb_build_object(
          'systemNsfwLock', jsonb_build_object('source', ${source}::text, 'at', now())
        )
    WHERE m.id = ${modelId}
      AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
      AND NOT ${holdsRatingSql}
      ${heldLeadGuard}
  `;
}

/**
 * Applies a lead held while the model was minor or POI, after a save cleared both flags: left held,
 * the model would be listed at SFW until a moderator ruled. Rated as any unrestricted model, with what
 * it replaced recorded on the lead so a Keep can undo it. A verdict a moderator kept while the flag
 * held the rating is revived as that lead first. A Private model keeps it held: it applies when the
 * model leaves Private (`applyHeldVerdictLeavingPrivate`). Null when there is nothing to apply.
 */
export async function applyHeldRestrictedVerdict(
  modelId: number,
  { ownerCleared = false }: { ownerCleared?: boolean } = {}
): Promise<ModelTextModerationOutcome | null> {
  // The owner's own untick is the latest lift: an earlier moderator or revert lift no longer holds it.
  if (ownerCleared) await dropLiftedBy(dbWrite, modelId, { flagged: false });
  const found = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: {
      id: true,
      nsfw: true,
      nsfwLevel: true,
      lockedProperties: true,
      userId: true,
      minor: true,
      poi: true,
      sfwOnly: true,
      availability: true,
      meta: true,
    },
  });
  if (!found) return null;
  const { meta, ...model } = found;
  if (model.minor || model.poi) return null;
  const stored = meta as ModelMeta | null;
  const lead =
    stored?.restrictedNsfwVerdict ??
    (stored?.restrictedNsfwVerdictDormant && (await reviveDormantVerdict(dbWrite, modelId))
      ? stored.restrictedNsfwVerdictDormant
      : undefined);
  if (!lead || lead.applied || lead.liftedBy) return null;
  if (model.availability === 'Private') return 'held_restricted';
  return applySystemModelNsfwFlag({ model, source: lead.source, heldLead: true });
}

/**
 * Applies a waiting lead (or a kept dormant verdict) on a model whose availability just left Private,
 * in the caller's transaction after its availability write, so the model is never listed at SFW with
 * the verdict unapplied. True when it applied: call `finishHeldVerdictApply` once committed.
 */
export async function applyHeldVerdictLeavingPrivate(db: RawDb, modelId: number) {
  await reviveDormantVerdict(db, modelId);
  const [lead] = await db.$queryRaw<{ source: string | null }[]>`
    SELECT m.meta->'restrictedNsfwVerdict'->>'source' AS source
    FROM "Model" m
    WHERE m.id = ${modelId}
      AND jsonb_typeof(m.meta->'restrictedNsfwVerdict') = 'object'
      AND NOT (m.meta->'restrictedNsfwVerdict' ? 'applied')
      AND NOT (m.meta->'restrictedNsfwVerdict' ? 'liftedBy')
  `;
  if (!lead) return false;
  // A lead with no source is not the text scan's, so it keeps the lock (`locksRating`).
  if (!(await flipRow(db, modelId, lead.source ?? 'unknown', true))) return false;
  await trackModActivity(
    SYSTEM_USER_ID,
    { entityType: 'model', entityId: modelId, activity: 'restrictedNsfwVerdict:autoApply' },
    db
  );
  return true;
}

/** The level and the public cache, after `applyHeldVerdictLeavingPrivate` committed. The write it
 *  follows has committed, so a failure is queued for the nsfw-level job and logged, not thrown. */
export async function finishHeldVerdictApply(modelId: number) {
  await updateModelNsfwLevels([modelId])
    .then(() => bustPublicModelResponseCache(modelId))
    .catch(async (error: Error) => {
      await enqueueJobs([
        { entityId: modelId, entityType: EntityType.Model, type: JobQueueType.UpdateNsfwLevel },
      ]).catch(() => null);
      await logToAxiom({
        name: 'text-scan',
        type: 'error',
        message: 'held restricted nsfw verdict applied; level refresh queued',
        modelId,
        error: error.message,
      }).catch(() => null);
    });
}

/**
 * After a lift other than the owner's save, in its transaction: a kept verdict comes back as a held
 * lead, and a held lead records who lifted the flag. Neither applies, here or on a later save or
 * publish: lifting minor or POI is not a ruling on the rating, so the lead waits for a moderator.
 */
export async function holdLeadAfterFlagLift(
  db: RawDb,
  modelId: number,
  liftedBy: NonNullable<RestrictedNsfwVerdict['liftedBy']>
) {
  await reviveDormantVerdict(db, modelId);
  await stampWaitingLeadLiftedBy(
    db,
    modelId,
    liftedBy,
    Prisma.sql`m.meta->'restrictedNsfwVerdict'->>'restriction' IN ('minor', 'poi')
      AND NOT (m.minor OR m.poi)`
  );
}

async function stampWaitingLeadLiftedBy(
  db: RawDb,
  modelId: number,
  liftedBy: NonNullable<RestrictedNsfwVerdict['liftedBy']>,
  condition: Prisma.Sql
) {
  await db.$executeRaw`
    UPDATE "Model" m
    SET meta = jsonb_set(m.meta, '{restrictedNsfwVerdict,liftedBy}', to_jsonb(${liftedBy}::text))
    WHERE m.id = ${modelId}
      AND jsonb_typeof(m.meta->'restrictedNsfwVerdict') = 'object'
      AND NOT (m.meta->'restrictedNsfwVerdict' ? 'applied')
      AND ${condition}
  `;
}

/**
 * After a moderator lifts a model's SFW-only lock, in its transaction: a waiting lead records the lift,
 * so it waits for a moderator's ruling rather than applying on the owner's next save. Only where
 * nothing else holds the rating now.
 */
export async function holdLeadAfterSfwOnlyLift(db: RawDb, modelId: number) {
  await stampWaitingLeadLiftedBy(db, modelId, 'moderator', Prisma.sql`NOT ${holdsRatingSql}`);
}

/**
 * Forgets who lifted the flag on a waiting lead: a flag set again (`flagged`) or the owner's own untick
 * makes that lift history, so the lead takes the ordinary owner path and its note names the last lift.
 */
export async function dropLiftedBy(db: RawDb, modelId: number, { flagged }: { flagged: boolean }) {
  await db.$executeRaw`
    UPDATE "Model" m
    SET meta = m.meta #- '{restrictedNsfwVerdict,liftedBy}'
    WHERE m.id = ${modelId}
      AND m.meta->'restrictedNsfwVerdict' ? 'liftedBy'
      AND (m.minor OR m.poi) = ${flagged}
  `;
}

/** Moves a dormant verdict back to a held lead, in the queue again. Guarded on the model being
 *  unrestricted and having no lead of its own, so a concurrent ruling or re-tick wins. */
async function reviveDormantVerdict(db: RawDb, modelId: number): Promise<boolean> {
  const revived = await db.$executeRaw`
    UPDATE "Model" m
    SET meta = (m.meta - 'restrictedNsfwVerdictDormant')
      || jsonb_build_object('restrictedNsfwVerdict', m.meta->'restrictedNsfwVerdictDormant')
    WHERE m.id = ${modelId}
      AND jsonb_typeof(m.meta->'restrictedNsfwVerdictDormant') = 'object'
      AND NOT (m.meta ? 'restrictedNsfwVerdict')
      AND NOT (m.minor OR m.poi)
  `;
  return revived > 0;
}

export async function applyModelNsfwTextScan({
  entityId,
  workflowId,
  outcome,
}: ApplyTextScanArgs): Promise<RatingFloorResult> {
  const nothing: RatingFloorResult = { deferredRatingNotice: null };
  // Read as not mature (an edit since the rating): the scan's own marker goes, so the owner can
  // change the rating again. The rating itself stays as it is.
  if (outcome.nsfw && outcome.nsfw.detectedLevel <= NsfwLevel.PG13) {
    await dropScanRatingMarker(dbWrite, entityId);
    return nothing;
  }
  if (!outcome.nsfw?.raised) return nothing;
  const model = await dbWrite.model.findUnique({
    where: { id: entityId },
    select: {
      id: true,
      name: true,
      nsfw: true,
      nsfwLevel: true,
      lockedProperties: true,
      userId: true,
      minor: true,
      poi: true,
      sfwOnly: true,
      availability: true,
      sfwName: true,
      sfwCoverImageId: true,
    },
  });
  if (!model) return nothing;

  const result = await applySystemModelNsfwFlag({ model, source: 'text-scan' });
  logToAxiom({
    name: 'text-scan',
    type: 'info',
    message: 'model nsfw verdict',
    modelId: entityId,
    result,
    level: outcome.nsfw.detectedLevel,
  }).catch(() => null);
  // A complete .com face already lists it on .com: the notice's advice to add one does not apply.
  if (result !== 'applied' || hasCompleteSfwFace(model)) return nothing;

  const notice: NotifyTextScanRatingRaisedArgs = {
    entityType: 'Model',
    entityId,
    userId: model.userId,
    level: outcome.nsfw.detectedLevel,
    title: model.name,
    url: `/models/${entityId}`,
    workflowId,
  };
  if (outcome.poi?.detected || outcome.minor?.detected) return { deferredRatingNotice: notice };
  await notifyTextScanRatingRaised(notice);
  return nothing;
}
