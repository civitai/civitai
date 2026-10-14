import {
  MODEL_RULE_LIMITS,
  isSemanticDefinition,
  modelRuleAliasesField,
  modelRuleDescriptionField,
  modelRuleSubjectField,
  parseModelRulesStoredResult,
  semanticModelRuleSchema,
  type SemanticModelRule,
} from '@civitai/moderation/model-rules';
import { z } from 'zod';

export { MODEL_RULE_LIMITS, isSemanticDefinition, semanticModelRuleSchema, type SemanticModelRule };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// One per line, never split on commas: a name can contain one ("Doe, Jane"), and splitting it would
// turn one alias into two far broader ones on an unrelated save.
export function parseAliases(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split('\n')) {
    const alias = part.replace(/\s+/g, ' ').trim();
    const key = alias.toLowerCase();
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

export const modelRuleFormSchema = z.object({
  subject: modelRuleSubjectField(),
  description: modelRuleDescriptionField.default(''),
  aliases: z.string().default('').transform(parseAliases).pipe(modelRuleAliasesField),
  note: z.string().trim().max(2000, 'Note is too long.').default(''),
});
export type ModelRuleForm = z.infer<typeof modelRuleFormSchema>;

export function ruleMatchesText(
  rule: { subject: string; description: string; aliases: readonly string[] },
  query: string
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [rule.subject, rule.description, ...rule.aliases].some((s) =>
    s.toLowerCase().includes(needle)
  );
}

/** `llm`: the model matched the rule. `literal`: the text names the rule's subject or an alias. */
export type RuleMatch = {
  ruleId: number;
  subject: string | null;
  reason: string | null;
  llm: boolean;
  literal: boolean;
};

/** One entry per rule: the model's first match for it, then literal-only hits. */
export function mergeRuleMatches(
  matched: readonly unknown[],
  literalIds: Iterable<number>,
  subjects: ReadonlyMap<number, string>
): RuleMatch[] {
  const literal = new Set(literalIds);
  const byRule = new Map<number, RuleMatch>();
  for (const m of matched) {
    if (!isRecord(m) || typeof m.ruleId !== 'number' || byRule.has(m.ruleId)) continue;
    byRule.set(m.ruleId, {
      ruleId: m.ruleId,
      subject: subjects.get(m.ruleId) ?? null,
      reason: typeof m.reason === 'string' && m.reason.trim() ? m.reason.trim() : null,
      llm: true,
      literal: literal.has(m.ruleId),
    });
  }
  for (const ruleId of literal)
    if (!byRule.has(ruleId))
      byRule.set(ruleId, {
        ruleId,
        subject: subjects.get(ruleId) ?? null,
        reason: null,
        llm: false,
        literal: true,
      });
  return [...byRule.values()];
}

export function parseRuleMatches(result: unknown): RuleMatch[] {
  const { matched, snapshot, literalRuleIds } = parseModelRulesStoredResult(result);
  const subjects = new Map(snapshot.map((rule) => [rule.id, rule.subject]));
  return mergeRuleMatches(matched, literalRuleIds, subjects);
}

export const matchSourceLabel = (match: Pick<RuleMatch, 'llm' | 'literal'>) =>
  !match.literal ? 'Model only' : match.llm ? 'Literal + model' : 'Literal only';

export const matchSourceVariant = (
  match: Pick<RuleMatch, 'llm' | 'literal'>
): 'secondary' | 'outline' | 'default' =>
  !match.literal ? 'secondary' : match.llm ? 'outline' : 'default';

/** The cursor is a row's `updatedAt` as Postgres prints it plus its id: `YYYY-MM-DD HH:MM:SS(.ffffff)|id`. */
export function parseMatchCursor(cursor: string | undefined) {
  const match = cursor?.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)\|(\d+)$/);
  return match ? { updatedAt: match[1], id: Number(match[2]) } : undefined;
}

/** A row written by the publish-time literal hold rather than by a scan. */
export const isHeldAtPublish = (result: unknown): boolean =>
  parseModelRulesStoredResult(result).heldAtPublish;
