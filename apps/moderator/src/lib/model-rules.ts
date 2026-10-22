import {
  MODEL_RULE_LIMITS,
  isSemanticDefinition,
  modelRuleAliasesField,
  modelRuleDescriptionField,
  modelRuleSubjectField,
  semanticModelRuleSchema,
  type SemanticModelRule,
} from '@civitai/moderation/model-rules';
import { z } from 'zod';

export { MODEL_RULE_LIMITS, isSemanticDefinition, semanticModelRuleSchema, type SemanticModelRule };

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
