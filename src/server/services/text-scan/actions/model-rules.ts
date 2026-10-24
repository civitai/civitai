import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { dataForModelsCache } from '~/server/redis/caches';
import type { ModelMeta } from '~/server/schema/model.schema';
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import { syncModelRulesHold } from '~/server/services/text-scan/actions/model-rules-hold';
import {
  checkModelRulesLiteralHold,
  type ModelRulesLiteralHold,
} from '~/server/services/text-scan/model-rules-hold';
import { MODEL_RULES_UNPUBLISH_MESSAGE } from '~/server/services/text-scan/model-rules';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

export { MODEL_RULES_UNPUBLISH_MESSAGE };

// Dynamic: model.service imports the model moderation adapter, which reaches this module.
const loadModelService = () => import('~/server/services/model.service');

async function claimAndUnpublishForModelRules({
  entityId,
  meta,
  modelRules,
}: {
  entityId: number;
  meta: ModelMeta;
  modelRules: NonNullable<ModelMeta['modelRules']>;
}): Promise<boolean> {
  const { workflowId } = modelRules;
  // Claimed in one statement so a model unpublished or deleted meanwhile, or a concurrent duplicate check, is never taken down (or notified) again.
  const claimed = await dbWrite.$executeRaw`
    UPDATE "Model"
    SET meta = ${asJsonbObjectSql('meta')} || jsonb_build_object('modelRules', ${JSON.stringify(
    modelRules
  )}::jsonb)
    WHERE id = ${entityId}
      AND status IN ('Published', 'Scheduled')
      AND availability <> 'Private'
      AND "deletedAt" IS NULL
      AND COALESCE(meta->'modelRules'->>'workflowId', '') <> ${workflowId}
  `;
  if (!claimed) return false;

  await unpublishForModelRules({ entityId, meta, modelRules });
  return true;
}

export async function unpublishForModelRules({
  entityId,
  meta,
  modelRules,
  userId = constants.system.user.id,
  needsReview = true,
}: {
  entityId: number;
  meta: ModelMeta;
  modelRules: NonNullable<ModelMeta['modelRules']>;
  /** Who the take-down is attributed to; the system user for a detection, the moderator for a ruling. */
  userId?: number;
  /** A detection queues the model for review; a moderator's ruling is the review. */
  needsReview?: boolean;
}) {
  const { unpublishModelById } = await loadModelService();
  const { needsReview: _queued, ...kept } = meta;
  await unpublishModelById({
    id: entityId,
    userId,
    isModerator: true,
    reason: 'other',
    customMessage: MODEL_RULES_UNPUBLISH_MESSAGE,
    meta: { ...kept, ...(needsReview ? { needsReview: true } : {}), modelRules },
  });
  await dataForModelsCache.refresh(entityId);
  await bustPublicModelResponseCache(entityId);
}

export function literalModelRules(ruleIds: number[], textHash: string) {
  return {
    ruleIds,
    // The rule ids are part of the claim: a stale claim for the same text (kept through a moderator
    // republish) must not block a rule that was added since.
    workflowId: `literal:${textHash}:${[...ruleIds].sort((a, b) => a - b).join(',')}`,
    textHash,
    at: new Date().toISOString(),
    source: 'literal' as const,
  };
}

// Best effort: the model is already in review, and a failed record only hides it from the queue.
async function recordHold(modelId: number, hold: ModelRulesLiteralHold) {
  try {
    await syncModelRulesHold(modelId, { ...hold, applied: true });
  } catch (error) {
    logToAxiom({
      name: 'text-scan',
      type: 'error',
      message: 'model rules hold not recorded',
      entityType: 'ModelRules',
      entityId: modelId,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: (error as { code?: unknown } | null | undefined)?.code,
    });
  }
}

/**
 * A literal match found before the model went public. It is taken straight to review instead of
 * being published first, so no claim on a public row is needed.
 */
export async function holdModelForLiteralRules({
  modelId,
  meta,
  ...hold
}: ModelRulesLiteralHold & { modelId: number; meta?: ModelMeta }) {
  const modelRules = literalModelRules(hold.ruleIds, hold.textHash);
  await unpublishForModelRules({ entityId: modelId, meta: meta ?? {}, modelRules });
  await recordHold(modelId, hold);
}

/** A literal match found as a version was added to a model that is already public. True when it was taken down. */
export async function unpublishLiveModelForLiteralRules({
  modelId,
  ...hold
}: ModelRulesLiteralHold & { modelId: number }): Promise<boolean> {
  const model = await dbWrite.model.findUnique({ where: { id: modelId }, select: { meta: true } });
  if (!model) return false;
  const modelRules = literalModelRules(hold.ruleIds, hold.textHash);
  const taken = await claimAndUnpublishForModelRules({
    entityId: modelId,
    meta: (model.meta ?? {}) as ModelMeta,
    modelRules,
  });
  if (taken) await recordHold(modelId, hold);
  return taken;
}

/**
 * The scanned text of a public model changed. `shadow` records any match as a hold and leaves the
 * model live; `active` also takes it down for review. Callers decide who is checked (moderators'
 * edits are not).
 */
export async function checkModelRulesOnEdit(modelId: number) {
  const model = await dbWrite.model.findUnique({ where: { id: modelId }, select: { meta: true } });
  if (!model) return;
  const hold = await checkModelRulesLiteralHold({
    modelId,
    live: true,
    meta: (model.meta ?? {}) as ModelMeta,
  });
  if (hold) await unpublishLiveModelForLiteralRules({ modelId, ...hold });
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

/** The meta to publish with: a moderator republishing a model the rules took down approves those matches. */
export function withModelRulesClearance(
  meta: ModelMeta,
  storedMeta: ModelMeta | null | undefined,
  isModerator: boolean | undefined
): ModelMeta {
  const modelRulesCleared = isModerator ? modelRulesClearedOnRepublish(storedMeta) : undefined;
  return modelRulesCleared ? { ...meta, modelRulesCleared } : meta;
}
