import type { TextScanSubject } from '~/server/services/text-scan/types';
import { foldConfusables } from '~/server/utils/confusable-fold';
import { foldDiacritics } from '~/utils/fold-diacritics';

const MIN_TERM_LENGTH = 3;

/**
 * Added to `EntityModeration.triggeredLabels` when the text names a rule literally, so a literal-only
 * hit (the model matched nothing) is still found by the moderator app's Matches list.
 */
export const MODEL_RULES_LITERAL_LABEL = 'modelRulesLiteral';

export type LiteralModelRule = { id: number; subject: string; aliases: string[] };

function normalizeForLiteralMatch(value: string) {
  return foldDiacritics(foldConfusables(value))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Ids of the rules whose subject or alias appears in `text` as a whole word or phrase. */
export function findLiteralModelRuleHits(text: string, rules: LiteralModelRule[]): number[] {
  if (!text || !rules.length) return [];
  const haystack = ` ${normalizeForLiteralMatch(text)} `;
  if (haystack.trim().length < MIN_TERM_LENGTH) return [];
  const hits: number[] = [];
  for (const rule of rules) {
    const matched = [rule.subject, ...rule.aliases].some((raw) => {
      const term = normalizeForLiteralMatch(raw);
      return term.length >= MIN_TERM_LENGTH && haystack.includes(` ${term} `);
    });
    if (matched) hits.push(rule.id);
  }
  return hits;
}

export function findLiteralHitsInSubject(subject: TextScanSubject, rules: LiteralModelRule[]) {
  const text = subject.fields.map((field) => field.text ?? '').join('\n');
  return findLiteralModelRuleHits(text, rules);
}
