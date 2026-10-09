import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { dataForModelsCache } from '~/server/redis/caches';
import type { ModelMeta } from '~/server/schema/model.schema';
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';

// Rendered to the owner by the unpublish notification for reason `other`; it must never name the rule.
export const MODEL_RULES_UNPUBLISH_MESSAGE =
  'This model was unpublished because it matched one of our content rules. A moderator will review it.';

// Dynamic: model.service imports the model moderation adapter, which reaches this module.
const loadModelService = () => import('~/server/services/model.service');

export async function applyModelRulesTextScan({
  entityId,
  workflowId,
  outcome,
  textHash,
}: ApplyTextScanArgs) {
  const matched = outcome.modelRules?.matched ?? [];
  if (!matched.length) return;

  const model = await dbWrite.model.findUnique({ where: { id: entityId }, select: { meta: true } });
  if (!model) return;
  const meta = (model.meta ?? {}) as ModelMeta;
  const cleared =
    meta.modelRulesCleared?.textHash === textHash ? meta.modelRulesCleared.ruleIds : [];
  const ruleIds = matched.map((m) => m.ruleId).filter((id) => !cleared.includes(id));
  if (!ruleIds.length) return;

  const modelRules = { ruleIds, workflowId, textHash, at: new Date().toISOString() };
  // Claimed in one statement so a model the owner unpublished or deleted since the scan, or a second
  // delivery of the same callback, is never taken down (or notified) again.
  const claimed = await dbWrite.$executeRaw`
    UPDATE "Model"
    SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('modelRules', ${JSON.stringify(
      modelRules
    )}::jsonb)
    WHERE id = ${entityId}
      AND status IN ('Published', 'Scheduled')
      AND availability <> 'Private'
      AND "deletedAt" IS NULL
      AND COALESCE(meta->'modelRules'->>'workflowId', '') <> ${workflowId}
  `;
  if (!claimed) return;

  const { unpublishModelById } = await loadModelService();
  await unpublishModelById({
    id: entityId,
    userId: constants.system.user.id,
    isModerator: true,
    reason: 'other',
    customMessage: MODEL_RULES_UNPUBLISH_MESSAGE,
    meta: { ...meta, needsReview: true, modelRules },
  });
  await dataForModelsCache.refresh(entityId);
  await bustPublicModelResponseCache(entityId);
}

/** What a moderator approves by republishing a model these rules unpublished. */
export function modelRulesClearedOnRepublish(
  meta: ModelMeta | null | undefined
): ModelMeta['modelRulesCleared'] | undefined {
  const taken = meta?.modelRules;
  if (!taken?.ruleIds?.length || !taken.textHash) return undefined;
  const previous =
    meta?.modelRulesCleared?.textHash === taken.textHash ? meta.modelRulesCleared.ruleIds : [];
  return { ruleIds: [...new Set([...previous, ...taken.ruleIds])], textHash: taken.textHash };
}
