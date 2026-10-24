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

/** The words of an alias as the literal matcher compares them, approximated: no confusable folding. */
const aliasWords = (alias: string) =>
  alias
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export const BROAD_ALIAS_WARNING = 'May match unrelated models — prefer a full name.';

/** `single-word` and `short` aliases match far beyond their subject; a full name rarely does. */
export function aliasBreadth(alias: string): 'single-word' | 'short' | null {
  const words = aliasWords(alias);
  if (!words.length) return null;
  if (words.length === 1) return 'single-word';
  return words.join(' ').length < 5 ? 'short' : null;
}

export function appendAliases(raw: string, added: readonly string[]): string {
  return parseAliases([raw, ...added].join('\n')).join('\n');
}
