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
    return run.model
      ? await checkDraftModel(run, run.model)
      : await checkTriggerWord(run, run.userId);
  } catch (error) {
    warn('training-model-rules-error', run, error);
    return false;
  }
}

// Name and code only: a Prisma message can echo the held text.
function warn(name: string, run: TrainingRun, error: unknown) {
  logToAxiom({
    name,
    type: 'warning',
    userId: run.userId,
    source: run.source,
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode: (error as { code?: unknown } | null | undefined)?.code,
  }).catch(() => undefined);
}

async function checkDraftModel(run: TrainingRun, model: NonNullable<TrainingRun['model']>) {
  const found = await detectModelRulesLiteral({
    modelId: model.id,
    versionIds: [model.versionId],
    meta: model.meta,
  });
  // The request's trigger word may not be in the stored text yet, and a model with no loadable text has none to check.
  // A rule a moderator cleared for this text stays cleared for the trigger word too.
  const wordMatches =
    found.kind === 'hit'
      ? false
      : await checkTriggerWord(run, model.id, found.kind === 'clean' ? found.cleared : []);
  // The verdict is settled before the write: a hold that cannot be recorded must not let a refused run through.
  const refused = found.kind === 'hit' ? found.detection.mode === 'active' : wordMatches;
  try {
    if (found.kind === 'clean')
      await syncModelRulesHold(model.id, null, { onlySource: 'training' });
    else if (found.kind === 'hit')
      await syncModelRulesHold(model.id, { ...found.detection, source: 'training' });
  } catch (error) {
    warn('training-model-rules-hold-error', run, error);
  }
  return refused;
}

/** `bucketId` picks the rollout bucket: the model when there is one, else the account. */
async function checkTriggerWord(
  { triggerWord, userId, source }: TrainingRun,
  bucketId: number,
  cleared: number[] = []
) {
  const mode = await getTextScanMode('ModelRules', bucketId);
  if (mode === 'off') return false;
  const rules = await getEnabledModelRules();
  const ruleIds = [
    ...new Set(
      findLiteralMatchesInSubject(
        { declared: {}, fields: [{ heading: 'Trigger word', text: triggerWord }] },
        rules
      )
        .map((match) => match.ruleId)
        .filter((ruleId) => !cleared.includes(ruleId))
    ),
  ];
  if (!ruleIds.length) return false;
  if (mode === 'active') return true;
  logToAxiom({ name: 'training-model-rules-match', type: 'info', userId, source, ruleIds }).catch(
    () => undefined
  );
  return false;
}
