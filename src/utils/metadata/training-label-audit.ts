import { auditPromptEnriched, isSoftBlock, MAX_AUDIT_PROMPT_LENGTH } from '~/utils/metadata/audit';
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
/** Audit results by tag, reusable across calls over one dataset. */
export type TrainingLabelMemo = Map<string, AuditedString>;

/**
 * The trainer's label rules, shared by the browser check and the submit-time check: changing a
 * rule here changes what the API refuses.
 *
 * Each comma-separated tag is audited on its own so a composed pattern cannot match across two
 * unrelated tags.
 */
export function auditTrainingLabels({
  triggerWord,
  labels,
  checkProfanity,
  memo = new Map(),
}: {
  triggerWord: string;
  labels: { key: string; label: string }[];
  checkProfanity: boolean;
  memo?: TrainingLabelMemo;
}): TrainingLabelAudit {
  const offendingWords: string[] = [];
  const seen = new Set<string>();
  const invalidKeys: string[] = [];
  let hard = false;
  let soft = false;

  const record = ({ blockedFor, triggers }: AuditedString) => {
    // `isSoftBlock` is false for an empty trigger set and for the hard `over_length` trigger.
    if (isSoftBlock(triggers)) soft = true;
    else hard = true;
    for (const word of blockedFor) {
      if (seen.has(word)) continue;
      seen.add(word);
      offendingWords.push(word);
    }
  };

  // Memoised per distinct tag: datasets repeat tags across labels, and the audit is synchronous.
  const audit = (text: string) => {
    let result = memo.get(text);
    if (!result) {
      result = auditPromptEnriched(text, undefined, checkProfanity);
      memo.set(text, result);
    }
    return result;
  };

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
      // The trigger word starts every label as trained, and is reported on its own above.
      if (tag === triggerWord) continue;
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

/**
 * A label as the trainer writes it into the dataset: led by the trigger word, joined the way the
 * label type reads.
 */
export function labelAsTrained(
  label: string,
  triggerWord: string,
  labelType: 'caption' | 'tag'
): string {
  if (!triggerWord) return label;
  if (!label) return triggerWord;
  const separator = labelType === 'caption' ? ' ' : ',';
  if (label === triggerWord || label.startsWith(triggerWord + separator)) return label;
  return labelType === 'caption' ? `${triggerWord} ${label}` : `${triggerWord}, ${label}`;
}

/**
 * Pack captions into newline-joined batches of at most `max` characters, because the audit
 * hard-refuses any input over `MAX_AUDIT_PROMPT_LENGTH`. Greedy, order-preserving; empty captions
 * are dropped; a caption is never split, so an oversize one becomes its own batch and is refused as
 * over-length.
 */
export function packCaptionsForAudit(
  captions: string[],
  max: number = MAX_AUDIT_PROMPT_LENGTH
): string[] {
  const batches: string[] = [];
  let current = '';
  for (const caption of captions) {
    if (caption.length === 0) continue;
    if (current.length === 0) {
      current = caption;
    } else if (current.length + 1 + caption.length <= max) {
      current += '\n' + caption;
    } else {
      batches.push(current);
      current = caption;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
