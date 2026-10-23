import { logToAxiom } from '~/server/logging/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import { syncModelRulesHold } from '~/server/services/text-scan/actions/model-rules-hold';
import { getTextScanMode } from '~/server/services/text-scan/mode';
import { getEnabledModelRules } from '~/server/services/text-scan/model-rules';
import { detectModelRulesLiteral } from '~/server/services/text-scan/model-rules-hold';
import { findLiteralMatchesInSubject } from '~/server/services/text-scan/model-rules-literal';

type TrainingRun = {
  triggerWord: string;
  userId: number;
  /** Which path submitted the run. */
  source: string;
  /** The draft model the run trains; absent for a run with no model of ours (Training Studio, App Blocks). */
  model?: { id: number; versionId: number; meta: ModelMeta | null };
};

/**
 * Whether the run must be refused for matching a Model rule. A run with a draft model is checked on
 * the text a publish would check, and a match is recorded as a hold on that model in both modes; a
 * run without one is only matched on its trigger word and, in review mode, logged. Fails open.
 */
export async function trainingMatchesModelRules(run: TrainingRun): Promise<boolean> {
  try {
    return run.model ? await checkDraftModel(run, run.model) : await checkTriggerWord(run);
  } catch (error) {
    logToAxiom({
      name: 'training-model-rules-error',
      type: 'warning',
      userId: run.userId,
      source: run.source,
      // Name and code only: a Prisma message can echo the held text.
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: (error as { code?: unknown } | null | undefined)?.code,
    }).catch(() => undefined);
    return false;
  }
}

async function checkDraftModel(run: TrainingRun, model: NonNullable<TrainingRun['model']>) {
  const found = await detectModelRulesLiteral({
    modelId: model.id,
    versionIds: [model.versionId],
    meta: model.meta,
  });
  if (found.kind === 'skip') return false;
  if (found.kind === 'clean') {
    await syncModelRulesHold(model.id, null, { onlySource: 'training' });
    return false;
  }
  await syncModelRulesHold(model.id, { ...found.detection, source: 'training' });
  return found.detection.mode === 'active';
}

async function checkTriggerWord({ triggerWord, userId, source }: TrainingRun) {
  // There is no model to bucket by, so the account stands in for one.
  const mode = await getTextScanMode('ModelRules', userId);
  if (mode === 'off') return false;
  const rules = await getEnabledModelRules();
  const ruleIds = [
    ...new Set(
      findLiteralMatchesInSubject(
        { declared: {}, fields: [{ heading: 'Trigger word', text: triggerWord }] },
        rules
      ).map((match) => match.ruleId)
    ),
  ];
  if (!ruleIds.length) return false;
  if (mode === 'active') return true;
  logToAxiom({ name: 'training-model-rules-match', type: 'info', userId, source, ruleIds }).catch(
    () => undefined
  );
  return false;
}
