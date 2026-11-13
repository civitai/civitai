import type { ModelRulesHoldMatch } from '@civitai/moderation/model-rules';
import type { LabField } from '$lib/text-scan-lab/types';

export type LiteralTryRule = { id: number; subject: string };

export type LiteralTryItem = {
  key: string;
  title: string;
  fields: LabField[];
  matches: ModelRulesHoldMatch[];
};

export type LiteralTryResult = {
  tried: true;
  notice: string | null;
  /** The rules in force for this run: the saved enabled ones with the edits applied. */
  rules: LiteralTryRule[];
  items: LiteralTryItem[];
  skipped: { entityId: number; error: string }[];
};

/** The rules that matched, in order of first match, each with the terms (as authored) that matched it. */
export function matchedRules(
  matches: readonly Pick<ModelRulesHoldMatch, 'ruleId' | 'term'>[],
  rules: readonly LiteralTryRule[]
): { ruleId: number; subject: string; terms: string[] }[] {
  const subjects = new Map(rules.map((rule) => [rule.id, rule.subject]));
  const byRule = new Map<number, { ruleId: number; subject: string; terms: string[] }>();
  for (const { ruleId, term } of matches) {
    const entry = byRule.get(ruleId) ?? {
      ruleId,
      subject: subjects.get(ruleId) ?? `Rule ${ruleId}`,
      terms: [],
    };
    if (!entry.terms.includes(term)) entry.terms.push(term);
    byRule.set(ruleId, entry);
  }
  return [...byRule.values()];
}
