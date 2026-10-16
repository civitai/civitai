import { logToAxiom } from '~/server/logging/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import { getModelRulesForPrompt } from '~/server/services/text-scan/model-rules';
import { findLiteralHitsInSubject } from '~/server/services/text-scan/model-rules-literal';
import { getTextScanMode } from '~/server/services/text-scan/mode';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { loadModelScanSubjects } from '~/server/services/text-scan/profiles/model.profile';

export type ModelRulesLiteralHold = { ruleIds: number[]; textHash: string };

/**
 * The literal rule hits that must stop a model from going public, or null. Only `active` mode
 * holds; callers decide who is checked (moderators never are). `versionIds` are the versions this publish makes public,
 * so the hash equals the one the post-publish scan computes and a moderator's clearance applies to it.
 * A failing check lets the publish through: the LLM scan that follows is the backstop.
 */
export async function checkModelRulesLiteralHold({
  modelId,
  versionIds,
  meta,
}: {
  modelId: number;
  versionIds: number[];
  meta?: ModelMeta | null;
}): Promise<ModelRulesLiteralHold | null> {
  try {
    if ((await getTextScanMode('ModelRules', modelId)) !== 'active') return null;
    const rules = await getModelRulesForPrompt();
    if (!rules.length) return null;
    const subject = (await loadModelScanSubjects([modelId], { prePublish: { versionIds } })).get(
      modelId
    );
    if (!subject) return null;

    const textHash = textScanTextHash(subject);
    const cleared =
      meta?.modelRulesCleared?.textHash === textHash ? meta.modelRulesCleared.ruleIds : [];
    const ruleIds = findLiteralHitsInSubject(subject, rules).filter((id) => !cleared.includes(id));
    return ruleIds.length ? { ruleIds, textHash } : null;
  } catch (error) {
    logToAxiom({
      name: 'text-scan',
      type: 'error',
      message: 'model rules literal check failed',
      entityType: 'ModelRules',
      entityId: modelId,
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}
