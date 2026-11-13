import { auditPromptEnriched, isSoftBlock } from '~/utils/metadata/audit';

export type TriggerWordAudit = { severity: 'clean' | 'soft' | 'hard'; offendingWords: string[] };

/**
 * The trigger word rule, shared by the trainer's browser check and every training submit: a hard
 * hit refuses, a soft hit only warns. Invisible formatting characters are dropped first, so they
 * cannot split a word.
 */
export function auditTrainingTriggerWord(
  triggerWord: string,
  checkProfanity: boolean
): TriggerWordAudit {
  const text = triggerWord.replace(/\p{Cf}/gu, '').trim();
  if (!text) return { severity: 'clean', offendingWords: [] };
  const { success, blockedFor, triggers } = auditPromptEnriched(text, undefined, checkProfanity);
  if (success) return { severity: 'clean', offendingWords: [] };
  return {
    severity: isSoftBlock(triggers) ? 'soft' : 'hard',
    offendingWords: [...new Set(blockedFor)],
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
