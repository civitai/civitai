import pLimit from 'p-limit';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { classifyPromptExternally } from '~/server/services/orchestrator/promptAuditing';
import { checkFixedWindow } from '~/server/utils/block-catalog-rate-limit';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { MAX_AUDIT_PROMPT_LENGTH } from '~/utils/metadata/audit';
import {
  auditTrainingLabels,
  packCaptionsForAudit,
  type TrainingLabelMemo,
} from '~/utils/metadata/training-label-audit';

// The text rule every training path applies before a run is submitted: the trainer's label rules
// tag by tag (hard hits refuse, soft hits pass, as after the trainer's "Continue anyway"), then the
// external classifier over the joined text.

/** The most files a training dataset holds. */
export const TRAINING_DATASET_MAX_FILES = 5000;
/** The most text one check covers. */
export const TRAINING_TEXT_MAX_CHARS = 4 * 1024 * 1024;
const TEXT_CHECK_BATCHES_PER_HOUR = 600;
/** Text audited per tick of the synchronous word check. */
const AUDIT_CHUNK_CHARS = 100_000;
const CLASSIFY_CONCURRENCY = 4;

const REFUSAL =
  'One or more labels/trigger words have been blocked. Please review these and resubmit.';

/**
 * Refuses (BAD_REQUEST) when the run's text breaks the rule. `captions` are what the model trains
 * on, as the dataset holds them. `classifierFailed` when a classifier batch went unanswered, which
 * passes.
 */
export async function assertTrainingTextAllowed({
  triggerWord,
  captions,
  log,
}: {
  triggerWord: string;
  captions: string[];
  /** Identifies the run in the refusal log. */
  log: { userId: number; source: string } & Record<string, unknown>;
}): Promise<{ classifierFailed: boolean }> {
  const refuse = (reasons: string[], via: 'labels' | 'external'): never => {
    logToAxiom({ name: 'training-text-refused', type: 'info', ...log, via, reasons }).catch(
      () => undefined
    );
    throw throwBadRequestError(`${REFUSAL} Reason: ${reasons.join(', ')}`);
  };

  // Invisible formatting characters are dropped from the checked copy, so they cannot split a word.
  const clean = (text: string) => text.replace(/\p{Cf}/gu, '').trim();
  const trigger = clean(triggerWord);
  const trimmed = captions.map(clean).filter(Boolean);
  // Bounds the classifier calls one check can make, whichever caller sent the text.
  if (
    trigger.length + trimmed.reduce((sum, text) => sum + text.length, 0) >
    TRAINING_TEXT_MAX_CHARS
  )
    throw throwBadRequestError('Your training data has more text than can be checked.');
  // A text is never split across classifier batches, so one over the audit's cap is refused outright.
  if ([trigger, ...trimmed].some((text) => text.length > MAX_AUDIT_PROMPT_LENGTH))
    refuse(['a label is too long'], 'labels');

  // In chunks, yielding between them: the audit is synchronous, and a dataset of distinct tags would
  // otherwise hold the event loop for seconds. The trigger word is audited whole in each.
  const memo: TrainingLabelMemo = new Map();
  let i = 0;
  do {
    const chunk: { key: string; label: string }[] = [];
    for (let chars = 0; i < trimmed.length && chars < AUDIT_CHUNK_CHARS; i++) {
      chunk.push({ key: String(i), label: trimmed[i] });
      chars += trimmed[i].length;
    }
    const audit = auditTrainingLabels({
      triggerWord: trigger,
      labels: chunk,
      // The green-only word list yields soft hits alone, which pass: skipping it changes nothing.
      checkProfanity: false,
      memo,
    });
    if (audit.severity === 'hard') refuse(audit.offendingWords, 'labels');
    await new Promise((resolve) => setImmediate(resolve));
  } while (i < trimmed.length);

  // Batches not yet sent are skipped once one is flagged: the run is refused either way.
  let flagged = false;
  const limit = pLimit(CLASSIFY_CONCURRENCY);
  const verdicts = await Promise.all(
    packCaptionsForAudit([trigger, ...trimmed]).map((batch) =>
      limit(async () => {
        if (flagged) return { categories: [], externalError: null };
        const verdict = await classifyPromptExternally(batch, 'other');
        if (verdict.categories.length > 0) flagged = true;
        return verdict;
      })
    )
  );
  const failed = verdicts.filter((v) => v.externalError).length;
  if (failed > 0)
    logToAxiom({ name: 'training-text-classifier-error', type: 'warning', ...log, failed }).catch(
      () => undefined
    );
  const categories = [...new Set(verdicts.flatMap((v) => v.categories))];
  if (categories.length > 0) refuse(categories, 'external');
  return { classifierFailed: failed > 0 };
}

/** One user's training text checks, counted in classifier batches, so a large dataset spends more
 *  than a small one. Shared by every caller that checks text a user sent. */
export function takeTrainingTextCheckBudget(userId: number, texts: string[]) {
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  return checkFixedWindow(
    `${REDIS_KEYS.TRAINING.TEXT_CHECK_RATE_LIMIT}:${userId}`,
    TEXT_CHECK_BATCHES_PER_HOUR,
    60 * 60,
    Math.max(1, Math.ceil(chars / MAX_AUDIT_PROMPT_LENGTH))
  );
}
