import {
  MODEL_RULE_LIMITS,
  isSemanticDefinition,
  MODEL_RULE_CATEGORIES,
  modelRuleAliasesField,
  modelRuleCategoryField,
  modelRuleDescriptionField,
  modelRuleReferencesField,
  modelRuleSubjectField,
  semanticModelRuleSchema,
  type SemanticModelRule,
} from '@civitai/moderation/model-rules';
import { z } from 'zod';

export {
  MODEL_RULE_CATEGORIES,
  MODEL_RULE_LIMITS,
  isSemanticDefinition,
  semanticModelRuleSchema,
  type SemanticModelRule,
};

/** A reference row as the editor holds it: either field may be blank until saved. */
export type ReferenceRow = { url: string; label: string };

/** Rows with no link are blank editor rows, not references. */
export function cleanReferenceRows(rows: readonly ReferenceRow[]): { url: string; label?: string }[] {
  return rows
    .filter((row) => row.url.trim())
    .map((row) => ({ url: row.url, ...(row.label.trim() ? { label: row.label } : {}) }));
}

// The form posts references as JSON in one field; Save all sends them as an array.
const referencesInput = z.preprocess((raw, ctx) => {
  if (raw === undefined || raw === '') return [];
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Malformed references.' });
      return z.NEVER;
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .filter((row) => typeof row.url === 'string' && row.url.trim())
    .map((row) => ({
      url: row.url,
      ...(typeof row.label === 'string' && row.label.trim() ? { label: row.label } : {}),
    }));
}, modelRuleReferencesField);

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
  category: z
    .union([modelRuleCategoryField, z.literal('')])
    .optional()
    .transform((category) => category || undefined),
  references: referencesInput,
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
