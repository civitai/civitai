import { Tracker } from '~/server/clickhouse/tracker';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { ModelTextModerationOutcome } from '~/server/prom/model-moderation.metrics';
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
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

export async function applySystemModelNsfwFlag({
  model,
  source,
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

  // A minor, POI or SFW-only model stays SFW, as the model form and the profanity check keep it: the
  // verdict waits in Needs review for a moderator instead.
  if (model.minor || model.poi || model.sfwOnly) return holdRestrictedVerdict(model.id, source);

  // Guarded in the WHERE, not by the caller's read: a moderator ruling that lands between
  // the read and this write would otherwise be overwritten. `array_append` in the database
  // for the same reason — writing back the array we read would drop a concurrent lock.
  // The marker rides the same guarded write as the lock, merged in jsonb so no other meta key is
  // rewritten from a stale read.
  const flipped = await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET nsfw = TRUE,
        "lockedProperties" = array_append(COALESCE(m."lockedProperties", ARRAY[]::text[]), 'nsfw'),
        meta = ${asJsonbObjectSql('m.meta')} || jsonb_build_object(
          'systemNsfwLock', jsonb_build_object('source', ${source}::text, 'at', now())
        )
    WHERE m.id = ${model.id}
      AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
      AND NOT (m.minor OR m.poi OR m."sfwOnly")
  `;
  if (!flipped) return holdRestrictedVerdict(model.id, source, 'declined_race');

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
        before: { nsfw: model.nsfw, lockedProperties: stored },
        after: { nsfw: true, lockedProperties: [...stored, 'nsfw'] },
        actorRole: 'system',
        systemFields: { nsfw: source, lockedProperties: source },
      })
    )
    .catch(() => null);

  return 'applied';
}

/**
 * Records the verdict as a moderator's lead on a restricted model, without touching nsfw. Guarded on
 * the restriction and on there being no nsfw lock: a moderator's lock is already a ruling. A lead
 * already waiting keeps its time and restriction, so a redelivery does not move it in the queue and
 * an owner who later unticks the flag does not relabel it. `otherwise` is the outcome when the guard
 * matches nothing.
 */
async function holdRestrictedVerdict(
  modelId: number,
  source: string,
  otherwise: ModelTextModerationOutcome = 'declined_race'
): Promise<ModelTextModerationOutcome> {
  const held = await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = ${asJsonbObjectSql('m.meta')} || jsonb_build_object(
          'restrictedNsfwVerdict', COALESCE(
            m.meta->'restrictedNsfwVerdict',
            jsonb_build_object(
              'source', ${source}::text,
              'at', now(),
              'restriction', CASE WHEN m.minor THEN 'minor' WHEN m.poi THEN 'poi' ELSE 'sfwOnly' END
            )
          )
        )
    WHERE m.id = ${modelId}
      AND (m.minor OR m.poi OR m."sfwOnly")
      AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
  `;
  return held ? 'held_restricted' : otherwise;
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
