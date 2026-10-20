import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { dataForModelsCache } from '~/server/redis/caches';
import type { ModelMeta } from '~/server/schema/model.schema';
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import {
  MODEL_RULES_UNPUBLISH_MESSAGE,
  getModelRuleSnapshots,
} from '~/server/services/text-scan/model-rules';
import { recordModelRulesLiteralHold } from '~/server/services/text-scan/record';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

export { MODEL_RULES_UNPUBLISH_MESSAGE };

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

  await claimAndUnpublishForModelRules({
    entityId,
    meta,
    modelRules: { ruleIds, workflowId, textHash, at: new Date().toISOString() },
  });
}

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
  // Claimed in one statement so a model the owner unpublished or deleted since the scan, or a second
  // delivery of the same callback, is never taken down (or notified) again.
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

async function unpublishForModelRules({
  entityId,
  meta,
  modelRules,
}: {
  entityId: number;
  meta: ModelMeta;
  modelRules: NonNullable<ModelMeta['modelRules']>;
}) {
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

function literalModelRules(ruleIds: number[], textHash: string) {
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

// Best effort: the hold has already happened, and a failed record only hides it from Matches.
async function recordHold(modelId: number, modelRules: ReturnType<typeof literalModelRules>) {
  try {
    await recordModelRulesLiteralHold({
      entityId: modelId,
      workflowId: modelRules.workflowId,
      textHash: modelRules.textHash,
      literalRuleIds: modelRules.ruleIds,
      snapshot: await getModelRuleSnapshots(modelRules.ruleIds),
    });
  } catch (error) {
    logToAxiom({
      name: 'text-scan',
      type: 'error',
      message: 'model rules literal hold not recorded',
      entityType: 'ModelRules',
      entityId: modelId,
      error: error instanceof Error ? error.message : error,
    });
  }
}

/**
 * A literal match found before the model went public. It is taken straight to review instead of
 * being published first, so no claim on a public row is needed.
 */
export async function holdModelForLiteralRules({
  modelId,
  ruleIds,
  textHash,
  meta,
}: {
  modelId: number;
  ruleIds: number[];
  textHash: string;
  meta?: ModelMeta;
}) {
  const modelRules = literalModelRules(ruleIds, textHash);
  await unpublishForModelRules({ entityId: modelId, meta: meta ?? {}, modelRules });
  await recordHold(modelId, modelRules);
}

/** A literal match found as a version was added to a model that is already public. True when it was taken down. */
export async function unpublishLiveModelForLiteralRules({
  modelId,
  ruleIds,
  textHash,
}: {
  modelId: number;
  ruleIds: number[];
  textHash: string;
}): Promise<boolean> {
  const model = await dbWrite.model.findUnique({ where: { id: modelId }, select: { meta: true } });
  if (!model) return false;
  const modelRules = literalModelRules(ruleIds, textHash);
  const taken = await claimAndUnpublishForModelRules({
    entityId: modelId,
    meta: (model.meta ?? {}) as ModelMeta,
    modelRules,
  });
  if (taken) await recordHold(modelId, modelRules);
  return taken;
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
