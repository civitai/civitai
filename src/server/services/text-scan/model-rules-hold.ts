import { logToAxiom } from '~/server/logging/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import {
  syncModelRulesHold,
  type ModelRulesHoldDetection,
} from '~/server/services/text-scan/actions/model-rules-hold';
import { getTextScanMode } from '~/server/services/text-scan/mode';
import { getEnabledModelRules } from '~/server/services/text-scan/model-rules';
import { findLiteralMatchesInSubject } from '~/server/services/text-scan/model-rules-literal';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { loadModelScanSubjects } from '~/server/services/text-scan/profiles/model.profile';
import { composeUserText } from '~/server/services/text-scan/segment';
import { sanitizeForPostgres } from '~/utils/string-helpers';

export const MODEL_RULES_HOLD_TEXT_CHARS = 50_000;
const REASON_CHARS = 500;

/** An `active` detection: the caller takes the model to review, then records it with `applied: true`. */
export type ModelRulesLiteralHold = ModelRulesHoldDetection & { ruleIds: number[] };

/**
 * Checks a model's text against the Model rules and records what it finds as a `modelRules` hold.
 * `versionIds` (the versions this publish makes public) and `live` (a public model as it is now)
 * exist so the hash equals the one a rescan computes and a moderator's clearance applies to it.
 * A failing check lets the publish through.
 */
export async function checkModelRulesLiteralHold({
  modelId,
  versionIds = [],
  meta,
  live,
}: {
  modelId: number;
  versionIds?: number[];
  meta?: ModelMeta | null;
  live?: boolean;
}): Promise<ModelRulesLiteralHold | null> {
  try {
    const mode = await getTextScanMode('ModelRules', modelId);
    if (mode === 'off') return null;
    const rules = await getEnabledModelRules();
    if (!rules.length) return null;
    const subject = (
      await loadModelScanSubjects(
        [modelId],
        live ? { publicOnly: true } : { prePublish: { versionIds } }
      )
    ).get(modelId);
    // A model that is not public yet keeps any pending hold: it is the one that took it down.
    if (!subject) return null;

    const textHash = textScanTextHash(subject);
    const cleared =
      meta?.modelRulesCleared?.textHash === textHash ? meta.modelRulesCleared.ruleIds : [];
    // Offsets point into the text as stored, which Postgres may have had to clean.
    const stored = {
      ...subject,
      fields: subject.fields.map((f) => ({
        ...f,
        text: f.text ? sanitizeForPostgres(f.text) : f.text,
      })),
    };
    const matches = findLiteralMatchesInSubject(stored, rules).filter(
      (m) => !cleared.includes(m.ruleId)
    );
    if (!matches.length) {
      await syncModelRulesHold(modelId, null);
      return null;
    }

    const hit = new Set(matches.map((m) => m.ruleId));
    const matched = rules.filter((rule) => hit.has(rule.id));
    const detection: ModelRulesLiteralHold = {
      ruleIds: matched.map((rule) => rule.id),
      textHash,
      userId: subject.userId && subject.userId > 0 ? subject.userId : null,
      // Cut before well-forming, so a pair split by the cap is replaced rather than kept half.
      text: sanitizeForPostgres(composeUserText(subject).slice(0, MODEL_RULES_HOLD_TEXT_CHARS)),
      reason: sanitizeForPostgres(matched.map((rule) => rule.subject).join(', ')).slice(
        0,
        REASON_CHARS
      ),
      fields: stored.fields.map((f) => ({ heading: f.heading, text: f.text ?? '' })),
      matches,
      rules: matched.map(({ id, subject: name, description, aliases }) => ({
        id,
        subject: name,
        description,
        aliases,
      })),
      mode,
      applied: false,
      ...(versionIds.length ? { versionIds } : {}),
    };
    if (mode === 'active') return detection;
    await syncModelRulesHold(modelId, detection);
    return null;
  } catch (error) {
    logToAxiom({
      name: 'text-scan',
      type: 'error',
      message: 'model rules literal check failed',
      entityType: 'ModelRules',
      entityId: modelId,
      // Name and code only: a Prisma message can echo the held text.
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: (error as { code?: unknown } | null | undefined)?.code,
    });
    return null;
  }
}
