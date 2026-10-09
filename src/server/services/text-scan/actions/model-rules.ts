import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { dataForModelsCache } from '~/server/redis/caches';
import type { ModelMeta } from '~/server/schema/model.schema';
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { ModelStatus } from '~/shared/utils/prisma/enums';

// Rendered to the owner by the unpublish notification for reason `other`; it must never name the rule.
export const MODEL_RULES_UNPUBLISH_MESSAGE =
  'This model was unpublished because it matched one of our content rules. A moderator will review it.';

const PUBLIC_STATUSES: ModelStatus[] = [ModelStatus.Published, ModelStatus.Scheduled];

// Dynamic: model.service imports the model moderation adapter, which reaches this module.
const loadModelService = () => import('~/server/services/model.service');

export async function applyModelRulesTextScan({
  entityId,
  workflowId,
  outcome,
}: ApplyTextScanArgs) {
  const matched = outcome.modelRules?.matched ?? [];
  if (!matched.length) return;

  const model = await dbWrite.model.findUnique({
    where: { id: entityId },
    select: { status: true, meta: true },
  });
  if (!model || !PUBLIC_STATUSES.includes(model.status)) return;

  const meta = (model.meta ?? {}) as ModelMeta;
  const cleared = new Set(meta.modelRulesCleared ?? []);
  const ruleIds = matched.map((m) => m.ruleId).filter((id) => !cleared.has(id));
  if (!ruleIds.length) return;

  const { unpublishModelById } = await loadModelService();
  await unpublishModelById({
    id: entityId,
    userId: constants.system.user.id,
    isModerator: true,
    reason: 'other',
    customMessage: MODEL_RULES_UNPUBLISH_MESSAGE,
    meta: {
      ...meta,
      needsReview: true,
      modelRules: { ruleIds, workflowId, at: new Date().toISOString() },
    },
  });
  await dataForModelsCache.refresh(entityId);
  await bustPublicModelResponseCache(entityId);
}

/** Rule ids a moderator approves by republishing a model these rules unpublished. */
export function modelRulesClearedOnRepublish(meta: ModelMeta | null | undefined) {
  const ruleIds = meta?.modelRules?.ruleIds;
  if (!ruleIds?.length) return undefined;
  return [...new Set([...(meta?.modelRulesCleared ?? []), ...ruleIds])];
}
