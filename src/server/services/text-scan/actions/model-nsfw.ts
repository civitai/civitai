import { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { Tracker } from '~/server/clickhouse/tracker';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { ModelTextModerationOutcome } from '~/server/prom/model-moderation.metrics';
import type { ModelMeta } from '~/server/schema/model.schema';
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
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

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
  };
  source: string;
  /** The flip applies a lead held while the model was minor or POI (`applyHeldRestrictedVerdict`). */
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
    if (model.nsfw && model.nsfwLevel !== nsfwBrowsingLevelsFlag) {
      await updateModelNsfwLevels([model.id]);
      return 'repaired';
    }
    return 'skipped_locked';
  }

  // A minor or POI model stays SFW, as the model form and the profanity check keep it: the verdict
  // waits in Needs review for a moderator instead. Held from the caller's read, which can be stale: an
  // owner who cleared the flag since falls through to the flip, whose guard has the final say.
  if (model.minor || model.poi) {
    const held = await holdRestrictedVerdict(model.id, source);
    if (held) return 'held_restricted';
  }

  // Guarded in the WHERE, not by the caller's read: a moderator ruling that lands between
  // the read and this write would otherwise be overwritten. `array_append` in the database
  // for the same reason — writing back the array we read would drop a concurrent lock.
  // The marker rides the same guarded write as the lock, merged in jsonb so no other meta key is
  // rewritten from a stale read.
  // An SFW-only model is rated as any other, with SFW-only cleared (the two cannot stand together),
  // and also gets a lead that records what was replaced, so a moderator can put the owner's rating
  // back; so does a lead held while the model was minor or POI, applied once the owner cleared the
  // flag. The lead and its ruling record are decided on the row as written, not on the read.
  const flipped = await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET nsfw = TRUE,
        "sfwOnly" = FALSE,
        "lockedProperties" = array_append(COALESCE(m."lockedProperties", ARRAY[]::text[]), 'nsfw'),
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
    WHERE m.id = ${model.id}
      AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
      AND NOT (m.minor OR m.poi)
  `;
  if (!flipped)
    return (await holdRestrictedVerdict(model.id, source)) ? 'held_restricted' : 'declined_race';

  // From the read: the lead and its record above are the row's own, this is the audit trail beside them.
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
        after: { nsfw: true, sfwOnly: false, lockedProperties: [...stored, 'nsfw'] },
        actorRole: 'system',
        systemFields: { nsfw: source, sfwOnly: source, lockedProperties: source },
      })
    )
    .catch(() => null);

  return 'applied';
}

/**
 * Records the verdict as a moderator's lead on a minor or POI model, without touching nsfw. Guarded on
 * the restriction and on there being no nsfw lock: a moderator's lock is already a ruling. A lead
 * already waiting keeps its time and restriction, so a redelivery does not move it in the queue and
 * an owner who later unticks the flag does not relabel it. True when it wrote.
 */
async function holdRestrictedVerdict(modelId: number, source: string): Promise<boolean> {
  const held = await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = ${asJsonbObjectSql('m.meta')} || jsonb_build_object(
          'restrictedNsfwVerdict', COALESCE(
            m.meta->'restrictedNsfwVerdict',
            jsonb_build_object(
              'source', ${source}::text,
              'at', now(),
              'restriction', CASE WHEN m.minor THEN 'minor' ELSE 'poi' END
            )
          )
        )
    WHERE m.id = ${modelId}
      AND (m.minor OR m.poi)
      AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
  `;
  return held > 0;
}

/**
 * Applies a lead held while the model was minor or POI, after a save cleared both flags: left held,
 * the model would be listed at SFW until a moderator ruled. Rated as any unrestricted model, with what
 * it replaced recorded on the lead so a Keep can undo it. Null when there is nothing to apply.
 */
export async function applyHeldRestrictedVerdict(
  modelId: number
): Promise<ModelTextModerationOutcome | null> {
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
      meta: true,
    },
  });
  if (!found) return null;
  const { meta, ...model } = found;
  const lead = (meta as ModelMeta | null)?.restrictedNsfwVerdict;
  if (!lead || lead.applied || model.minor || model.poi) return null;
  return applySystemModelNsfwFlag({ model, source: lead.source, heldLead: true });
}

export async function applyModelNsfwTextScan({
  entityId,
  workflowId,
  outcome,
}: ApplyTextScanArgs): Promise<RatingFloorResult> {
  const nothing: RatingFloorResult = { deferredRatingNotice: null };
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
  if (result !== 'applied') return nothing;

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
