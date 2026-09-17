import { auditPromptEnriched, isSoftBlock } from '~/utils/metadata/audit';
import type { PromptTrigger } from '~/utils/metadata/audit';

export type TrainingLabelSeverity = 'clean' | 'soft' | 'hard';

export type TrainingLabelAudit = {
  severity: TrainingLabelSeverity;
  /** Deduped, in the order encountered. */
  offendingWords: string[];
  triggerWordInvalid: boolean;
  invalidKeys: string[];
};

type AuditedString = { blockedFor: string[]; triggers: PromptTrigger[]; success: boolean };

/**
 * Each comma-separated tag is audited on its own so a composed pattern cannot match across two
 * unrelated tags ("school_uniform, 1girl" tripping a `school…girl` rule).
 */
export function auditTrainingLabels({
  triggerWord,
  labels,
  checkProfanity,
}: {
  triggerWord: string;
  labels: { key: string; label: string }[];
  checkProfanity: boolean;
}): TrainingLabelAudit {
  const offendingWords: string[] = [];
  const seen = new Set<string>();
  const invalidKeys: string[] = [];
  let hard = false;
  let soft = false;

  const record = ({ blockedFor, triggers }: AuditedString) => {
    // `isSoftBlock` is false for an empty trigger set, so the over-length refusal lands hard.
    if (isSoftBlock(triggers)) soft = true;
    else hard = true;
    for (const word of blockedFor) {
      if (seen.has(word)) continue;
      seen.add(word);
      offendingWords.push(word);
    }
  };

  const audit = (text: string) => auditPromptEnriched(text, undefined, checkProfanity);

  const triggerWordResult = audit(triggerWord);
  const triggerWordInvalid = !triggerWordResult.success;
  if (triggerWordInvalid) record(triggerWordResult);

  for (const { key, label } of labels) {
    const tags = label
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    let invalid = false;
    for (const tag of tags) {
      const result = audit(tag);
      if (result.success) continue;
      invalid = true;
      record(result);
    }
    if (invalid) invalidKeys.push(key);
  }

  return {
    severity: hard ? 'hard' : soft ? 'soft' : 'clean',
    offendingWords,
    triggerWordInvalid,
    invalidKeys,
  };
}
