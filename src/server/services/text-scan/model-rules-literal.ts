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

type CompiledRules = {
  rules: { id: number; terms: string[] }[];
  maxWords: number;
};

let memo: { key: string; compiled: CompiledRules } | undefined;

// Normalizing is the expensive part and the rule set rarely changes, so one compiled set is kept.
// The key carries the terms themselves: an edited rule can never match against a stale compile.
function compileRules(rules: LiteralModelRule[]): CompiledRules {
  const key = rules
    .map((r) => `${r.id}\u0001${r.subject}\u0001${r.aliases.join('\u0002')}`)
    .join('\u0003');
  if (memo?.key === key) return memo.compiled;
  let maxWords = 1;
  const compiled = rules.map((rule) => {
    const terms = [
      ...new Set(
        [rule.subject, ...rule.aliases]
          .map(normalizeForLiteralMatch)
          .filter((term) => term.length >= MIN_TERM_LENGTH)
      ),
    ];
    for (const term of terms) maxWords = Math.max(maxWords, term.split(' ').length);
    return { id: rule.id, terms };
  });
  const result = { rules: compiled, maxWords };
  memo = { key, compiled: result };
  return result;
}

/** Every run of 1..maxWords consecutive words, so a term is a set lookup instead of a substring scan. */
function wordRuns(text: string, maxWords: number): Set<string> {
  const words = normalizeForLiteralMatch(text).split(' ');
  const runs = new Set<string>();
  for (let start = 0; start < words.length; start++) {
    let run = '';
    for (let n = 0; n < maxWords && start + n < words.length; n++) {
      run = n === 0 ? words[start] : `${run} ${words[start + n]}`;
      runs.add(run);
    }
  }
  return runs;
}

function hitIds(texts: (string | null | undefined)[], rules: LiteralModelRule[]): Set<number> {
  const compiled = compileRules(rules);
  const hit = new Set<number>();
  for (const text of texts) {
    if (!text) continue;
    const runs = wordRuns(text, compiled.maxWords);
    for (const rule of compiled.rules) {
      if (!hit.has(rule.id) && rule.terms.some((term) => runs.has(term))) hit.add(rule.id);
    }
  }
  return hit;
}

/** Ids of the rules whose subject or alias appears in `text` as a whole word or phrase. */
export function findLiteralModelRuleHits(text: string, rules: LiteralModelRule[]): number[] {
  if (!text || !rules.length) return [];
  const hit = hitIds([text], rules);
  return rules.filter((rule) => hit.has(rule.id)).map((rule) => rule.id);
}

export function findLiteralHitsInSubject(subject: TextScanSubject, rules: LiteralModelRule[]) {
  if (!rules.length) return [];
  const hit = hitIds(
    subject.fields.map((field) => field.text),
    rules
  );
  return rules.filter((rule) => hit.has(rule.id)).map((rule) => rule.id);
}
