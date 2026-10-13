import {
  isSemanticDefinition,
  semanticModelRuleSchema,
  type SemanticModelRule,
} from '@civitai/moderation/model-rules';
import { z } from 'zod';

export { isSemanticDefinition, semanticModelRuleSchema, type SemanticModelRule };

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

/** Mirrored by the main app's MODEL_RULE_OVERRIDE_LIMITS (src/server/services/text-scan/model-rules.ts). */
export const MODEL_RULE_LIMITS = {
  subjectChars: 200,
  descriptionChars: 2000,
  aliasChars: 200,
  aliasesPerRule: 100,
  rulesPerTry: 500,
} as const;

export const modelRuleFormSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1, 'Subject is required.')
    .max(MODEL_RULE_LIMITS.subjectChars, 'Subject is too long.'),
  description: z
    .string()
    .trim()
    .max(MODEL_RULE_LIMITS.descriptionChars, 'Description is too long.')
    .default(''),
  aliases: z
    .string()
    .default('')
    .transform(parseAliases)
    .pipe(
      z
        .array(z.string().max(MODEL_RULE_LIMITS.aliasChars, 'An alias is too long.'))
        .max(MODEL_RULE_LIMITS.aliasesPerRule, 'At most 100 aliases per rule.')
    ),
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

export function parseRuleMatches(result: unknown): RuleMatch[] {
  if (!isRecord(result)) return [];
  const labels = result.labels;
  const matched =
    isRecord(labels) && isRecord(labels.modelRules) && Array.isArray(labels.modelRules.matched)
      ? labels.modelRules.matched
      : [];
  const stored = isRecord(result.modelRules) ? result.modelRules : null;
  const snapshot = stored?.snapshot;
  const subjects = new Map<number, string>();
  if (Array.isArray(snapshot))
    for (const s of snapshot)
      if (isRecord(s) && typeof s.id === 'number' && typeof s.subject === 'string')
        subjects.set(s.id, s.subject);
  const literalIds = new Set(
    Array.isArray(stored?.literalRuleIds)
      ? stored.literalRuleIds.filter((id): id is number => typeof id === 'number')
      : []
  );

  // First match per rule wins: the matches tab keys its rows by `ruleId`.
  const byRule = new Map<number, RuleMatch>();
  for (const m of matched) {
    if (!isRecord(m) || typeof m.ruleId !== 'number' || byRule.has(m.ruleId)) continue;
    byRule.set(m.ruleId, {
      ruleId: m.ruleId,
      subject: subjects.get(m.ruleId) ?? null,
      reason: typeof m.reason === 'string' && m.reason.trim() ? m.reason.trim() : null,
      llm: true,
      literal: literalIds.has(m.ruleId),
    });
  }
  for (const ruleId of literalIds)
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

/** The cursor is a row's `updatedAt` as Postgres prints it plus its id: `YYYY-MM-DD HH:MM:SS(.ffffff)|id`. */
export function parseMatchCursor(cursor: string | undefined) {
  const match = cursor?.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)\|(\d+)$/);
  return match ? { updatedAt: match[1], id: Number(match[2]) } : undefined;
}
