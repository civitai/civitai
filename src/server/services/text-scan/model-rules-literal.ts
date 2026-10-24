import { MODEL_RULE_LIMITS } from '@civitai/moderation/model-rules';
import type { TextScanSubject } from '~/server/services/text-scan/types';
import { foldConfusables } from '~/server/utils/confusable-fold';
import { foldDiacritics } from '~/utils/fold-diacritics';

const MIN_TERM_LENGTH = 3;

export type LiteralModelRule = { id: number; subject: string; aliases: string[] };

function normalizeForLiteralMatch(value: string) {
  return foldDiacritics(foldConfusables(value))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const wordsIn = (term: string) => term.split(' ').length;

/** The form the matcher compares a term in, or null when it would ignore the term. */
export function literalTermKey(term: string): string | null {
  const normalized = normalizeForLiteralMatch(term);
  return normalized.length < MIN_TERM_LENGTH || wordsIn(normalized) > MODEL_RULE_LIMITS.termWords
    ? null
    : normalized;
}

type CompiledRules = {
  /** Normalized term -> the rules and authored spellings that produce it. */
  byTerm: Map<string, { ruleId: number; term: string }[]>;
  maxWords: number;
};

let memo: { key: string; compiled: CompiledRules } | undefined;

// A term over the word cap is ignored, never thrown: a rule stored before the cap existed must not
// make every run of the text that long.
// Normalizing is the expensive part and the rule set rarely changes, so one compiled set is kept.
// The key carries the terms themselves: an edited rule can never match against a stale compile.
function compileRules(rules: LiteralModelRule[]): CompiledRules {
  const key = rules
    .map((r) => `${r.id}\u0001${r.subject}\u0001${r.aliases.join('\u0002')}`)
    .join('\u0003');
  if (memo?.key === key) return memo.compiled;
  let maxWords = 1;
  const byTerm = new Map<string, { ruleId: number; term: string }[]>();
  for (const rule of rules) {
    const authored = new Map<string, string>();
    for (const term of [rule.subject, ...rule.aliases]) {
      const normalized = literalTermKey(term);
      if (normalized === null) continue;
      if (!authored.has(normalized)) authored.set(normalized, term);
    }
    for (const [normalized, term] of authored) {
      maxWords = Math.max(maxWords, wordsIn(normalized));
      const entries = byTerm.get(normalized) ?? [];
      entries.push({ ruleId: rule.id, term });
      byTerm.set(normalized, entries);
    }
  }
  const result = { byTerm, maxWords };
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

export type LiteralModelRuleMatch = {
  ruleId: number;
  /** The subject or alias as authored, not normalized. */
  term: string;
  /** The field's heading and its index in `subject.fields` (headings can repeat). */
  field: string;
  fieldIndex: number;
  /** `text.slice(start, end)` of the field's original text is the span as the user wrote it. */
  start: number;
  end: number;
};

type SourceWord = { word: string; start: number; end: number };

// Folding is done per base character plus its combining marks, so every folded letter keeps the
// original range it came from. Whole-string NFKC can compose across clusters (e.g. Hangul jamo);
// when the two disagree, the caller falls back to the whole field rather than a wrong offset.
function sourceWords(text: string): SourceWord[] | null {
  const words: SourceWord[] = [];
  let current: SourceWord | undefined;
  let folded = '';
  for (const cluster of text.matchAll(/[^\p{M}]\p{M}*|\p{M}+/gu)) {
    const start = cluster.index;
    const end = start + cluster[0].length;
    const piece = foldDiacritics(foldConfusables(cluster[0]));
    folded += piece;
    for (const char of piece) {
      if (/[\p{L}\p{N}]/u.test(char)) {
        if (current) {
          current.word += char;
          current.end = end;
        } else {
          current = { word: char, start, end };
          words.push(current);
        }
      } else {
        current = undefined;
      }
    }
  }
  return folded === foldDiacritics(foldConfusables(text)) ? words : null;
}

/** Every occurrence of a rule subject or alias in a field, with where it sits in the original text. */
export function findLiteralMatchesInSubject(
  subject: TextScanSubject,
  rules: LiteralModelRule[]
): LiteralModelRuleMatch[] {
  if (!rules.length) return [];
  const { byTerm, maxWords } = compileRules(rules);
  const matches: LiteralModelRuleMatch[] = [];
  subject.fields.forEach((field, fieldIndex) => {
    const text = field.text;
    if (!text) return;
    const words = sourceWords(text);
    if (!words) {
      const runs = wordRuns(text, maxWords);
      for (const [normalized, entries] of byTerm) {
        if (!runs.has(normalized)) continue;
        for (const entry of entries) {
          matches.push({
            ...entry,
            field: field.heading,
            fieldIndex,
            start: 0,
            end: text.length,
          });
        }
      }
      return;
    }
    for (let i = 0; i < words.length; i++) {
      let run = '';
      for (let n = 0; n < maxWords && i + n < words.length; n++) {
        run = n === 0 ? words[i].word : `${run} ${words[i + n].word}`;
        for (const entry of byTerm.get(run) ?? []) {
          matches.push({
            ...entry,
            field: field.heading,
            fieldIndex,
            start: words[i].start,
            end: words[i + n].end,
          });
        }
      }
    }
  });
  return matches;
}
