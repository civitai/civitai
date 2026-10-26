import { logToAxiom } from '~/server/logging/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import { classifyPromptExternally } from '~/server/services/orchestrator/promptAuditing';
import { trainingMatchesModelRules } from '~/server/services/text-scan/model-rules-training';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { auditTrainingTriggerWord } from '~/utils/metadata/training-trigger-word';

export const MODEL_RULES_REFUSAL =
  "This training run can't be started: its name or trigger word matches content we don't allow. Please review it and resubmit.";

/**
 * The trigger word check every training path applies before a run is submitted: the trainer's
 * trigger word rule (a hard hit refuses, a soft hit passes, as after the trainer's "Continue
 * anyway"), then the Model rules, then the external classifier, which fails open. Refuses with
 * BAD_REQUEST. `model` is the draft the run trains, when there is one.
 */
export async function assertTrainingTriggerWordAllowed({
  triggerWord,
  log,
  model,
}: {
  triggerWord: string;
  model?: { id: number; versionId: number; meta: ModelMeta | null };
  /** Identifies the run in the refusal log. */
  log: { userId: number; source: string } & Record<string, unknown>;
}): Promise<void> {
  const refuse = (reasons: string[], via: 'rules' | 'external'): never => {
    logToAxiom({ name: 'training-trigger-word-refused', type: 'info', ...log, via, reasons }).catch(
      () => undefined
    );
    throw throwBadRequestError(
      `This trigger word has been blocked. Please review it and resubmit. Reason: ${reasons.join(
        ', '
      )}`
    );
  };

  // The green-only word list yields soft hits alone, which pass: skipping it changes nothing.
  const audit = auditTrainingTriggerWord(triggerWord, false);
  if (audit.severity === 'hard') refuse(audit.offendingWords, 'rules');

  if (
    await trainingMatchesModelRules({ triggerWord, userId: log.userId, source: log.source, model })
  ) {
    logToAxiom({
      name: 'training-trigger-word-refused',
      type: 'info',
      ...log,
      via: 'model-rules',
    }).catch(() => undefined);
    // Names no rule or term: a refusal that did would list what is blocked.
    throw throwBadRequestError(MODEL_RULES_REFUSAL);
  }

  const verdict = await classifyPromptExternally(triggerWord, 'other');
  if (verdict.externalError)
    logToAxiom({ name: 'training-trigger-word-classifier-error', type: 'warning', ...log }).catch(
      () => undefined
    );
  if (verdict.categories.length > 0) refuse(verdict.categories, 'external');
}
