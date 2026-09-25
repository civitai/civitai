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

  // Guarded in the WHERE, not by the caller's read: a moderator ruling that lands between
  // the read and this write would otherwise be overwritten. `array_append` in the database
  // for the same reason — writing back the array we read would drop a concurrent lock.
  const flipped = await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET nsfw = TRUE,
        "lockedProperties" = array_append(COALESCE(m."lockedProperties", ARRAY[]::text[]), 'nsfw')
    WHERE m.id = ${model.id}
      AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
  `;
  if (!flipped) return 'declined_race';

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

export async function applyModelNsfwTextScan({
  entityId,
  workflowId,
  outcome,
}: ApplyTextScanArgs): Promise<RatingFloorResult> {
  const nothing: RatingFloorResult = { deferredRatingNotice: null };
  if (!outcome.nsfw?.raised) return nothing;
  const model = await dbWrite.model.findUnique({
    where: { id: entityId },
    select: { id: true, name: true, nsfw: true, nsfwLevel: true, lockedProperties: true, userId: true },
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
