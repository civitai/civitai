import { z } from 'zod';

// Everything the moderator app and the main app must agree on about a Model rule lives here: its
// limits and field schemas, the definition stored on `ModerationRule`, and the shape of a review
// hold's `meta`.

export const MODEL_RULE_LIMITS = {
  subjectChars: 200,
  descriptionChars: 2000,
  aliasChars: 200,
  /** Words per subject or alias; the literal matcher's memory grows with the longest term. */
  termWords: 8,
  aliasesPerRule: 100,
  referencesPerRule: 10,
  referenceUrlChars: 500,
  referenceLabelChars: 100,
  rulesPerTry: 500,
} as const;

/** Words as the literal matcher sees them: runs of letters and digits, punctuation being a separator. */
export const termWordCount = (term: string) => term.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;

const withinWordCap = (term: string) => termWordCount(term) <= MODEL_RULE_LIMITS.termWords;

export const modelRuleSubjectField = (requiredMessage = 'Subject is required.') =>
  z
    .string()
    .trim()
    .min(1, requiredMessage)
    .max(MODEL_RULE_LIMITS.subjectChars, 'Subject is too long.')
    .refine(withinWordCap, `Subject can have at most ${MODEL_RULE_LIMITS.termWords} words.`);

export const modelRuleDescriptionField = z
  .string()
  .trim()
  .max(MODEL_RULE_LIMITS.descriptionChars, 'Description is too long.');

export const modelRuleAliasField = z
  .string()
  .trim()
  .min(1)
  .max(MODEL_RULE_LIMITS.aliasChars, 'An alias is too long.')
  .refine(withinWordCap, `An alias can have at most ${MODEL_RULE_LIMITS.termWords} words.`);

export const modelRuleAliasesField = z
  .array(modelRuleAliasField)
  .max(
    MODEL_RULE_LIMITS.aliasesPerRule,
    `At most ${MODEL_RULE_LIMITS.aliasesPerRule} aliases per rule.`
  );

export const ALIAS_KINDS = [
  'stage_name',
  'other_script',
  'romanization',
  'trigger_word',
  'other',
] as const;
export type AliasKind = (typeof ALIAS_KINDS)[number];

/** An unknown kind is a label this build lacks, not a reason to discard a billed suggestion. */
export const aliasKindField = z.enum(ALIAS_KINDS).catch('other');

// Readers keep whatever entries parse and drop the rest: a row written by an older build must still list.
const tolerantList = <T extends z.ZodType>(item: T) =>
  z
    .unknown()
    .optional()
    .transform((value): z.output<T>[] =>
      Array.isArray(value)
        ? value.flatMap((entry) => {
            const parsed = item.safeParse(entry);
            return parsed.success ? [parsed.data] : [];
          })
        : []
    );

/** Orchestrator workflow ids are opaque tokens; this only rules out anything that is not one. */
export const aliasWorkflowIdField = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/, 'invalid workflow id');

/** Why a rule exists, for the moderator ruling on a match; never used for matching. */
export const MODEL_RULE_CATEGORIES = [
  { value: 'artist', label: 'Artist' },
  { value: 'likeness', label: 'Real person' },
  { value: 'ip', label: 'Copyrighted IP' },
  { value: 'legal', label: 'Legal request' },
  { value: 'other', label: 'Other' },
] as const;
export type ModelRuleCategory = (typeof MODEL_RULE_CATEGORIES)[number]['value'];

const CATEGORY_VALUES = MODEL_RULE_CATEGORIES.map((c) => c.value) as [
  ModelRuleCategory,
  ...ModelRuleCategory[],
];

export const modelRuleCategoryField = z.enum(CATEGORY_VALUES);

export const modelRuleCategoryLabel = (category: ModelRuleCategory) =>
  MODEL_RULE_CATEGORIES.find((c) => c.value === category)?.label ?? category;

const isHttpUrl = (value: string) => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

export const modelRuleReferenceField = z.object({
  url: z
    .string()
    .trim()
    .max(MODEL_RULE_LIMITS.referenceUrlChars, 'A reference link is too long.')
    .refine(isHttpUrl, 'A reference link must be a valid http or https URL.'),
  label: z
    .string()
    .trim()
    .max(MODEL_RULE_LIMITS.referenceLabelChars, 'A reference label is too long.')
    .optional()
    .transform((label) => label || undefined),
});
export type ModelRuleReference = z.infer<typeof modelRuleReferenceField>;

export const modelRuleReferencesField = z
  .array(modelRuleReferenceField)
  .max(
    MODEL_RULE_LIMITS.referencesPerRule,
    `At most ${MODEL_RULE_LIMITS.referencesPerRule} references per rule.`
  );

// `ModerationRule.definition` of a Model rule. The moderator app writes it and the main app reads
// it; a row failing this schema is skipped by the matcher, so the two sides must share it rather
// than each keep a copy.
const definitionShape = {
  type: z.literal('semantic'),
  subject: z.string().trim().min(1),
  description: z.string().trim().default(''),
  aliases: z.array(z.string().trim().min(1)).default([]),
  /** A stored value this build does not know is dropped rather than failing the rule. */
  category: modelRuleCategoryField.optional().catch(undefined),
  references: tolerantList(modelRuleReferenceField),
  /** The regex-era definition this rule was converted from. */
  legacyMatch: z.unknown().optional(),
  /** Converted but not yet reviewed by a person; the matcher ignores it until a save clears this. */
  needsAttention: z.boolean().optional(),
  updatedById: z.number().int().optional(),
};

/** What the matcher and the converter read: a rule saved before the term caps existed still loads. */
export const storedModelRuleSchema = z.object(definitionShape);

/** What every write enforces; the forms and Try overrides use the same field schemas. */
export const semanticModelRuleSchema = storedModelRuleSchema.extend({
  subject: modelRuleSubjectField(),
  description: modelRuleDescriptionField.default(''),
  aliases: modelRuleAliasesField.default([]),
  category: modelRuleCategoryField.optional(),
  references: modelRuleReferencesField.default([]),
});

export type SemanticModelRule = z.infer<typeof semanticModelRuleSchema>;

export const isSemanticDefinition = (definition: unknown): definition is SemanticModelRule =>
  typeof definition === 'object' &&
  definition !== null &&
  (definition as { type?: unknown }).type === 'semantic';

/** The rule as it read when it was matched, so a later edit or disable cannot rewrite what matched. */
export type StoredModelRuleSnapshot = {
  id: number;
  subject: string;
  description: string;
  aliases: string[];
  category?: ModelRuleCategory;
  references: ModelRuleReference[];
};

// ---------------------------------------------------------------------------------------------
// Review hold: `TextScanHold.meta` of a `modelRules` hold, one per literal detection.

export const MODEL_RULES_HOLD_LABEL = 'modelRules';

/** The mode the detection ran in, which the hold keeps whatever the mode is switched to later. */
export type ModelRulesHoldMode = 'shadow' | 'active';

export type ModelRulesHoldField = { heading: string; text: string };

/** Where a rule's subject or alias sits: `fields[fieldIndex].text.slice(start, end)` is the span as written. */
export type ModelRulesHoldMatch = {
  ruleId: number;
  term: string;
  field: string;
  fieldIndex: number;
  start: number;
  end: number;
};

/** What a moderator can rule on a pending `modelRules` hold; the dismissals say why. */
export const MODEL_RULES_HOLD_DECISIONS = [
  'confirm',
  'confirm_strike',
  'dismiss_not_subject',
  'dismiss_allowed',
] as const;
export type ModelRulesHoldDecision = (typeof MODEL_RULES_HOLD_DECISIONS)[number];

export type ModelRulesHoldMeta = {
  mode: ModelRulesHoldMode;
  /** The scanned fields in order, so the offsets in `matches` can be highlighted. */
  fields: ModelRulesHoldField[];
  matches: ModelRulesHoldMatch[];
  /** Every matched rule as it read at detection. */
  rules: StoredModelRuleSnapshot[];
  /** The action was applied at detection (Auto): `TextScanHold.hiddenAt` is set. */
  applied?: true;
  /** The versions the publish was making public, so dismissing a pre-publish takedown can publish them. */
  versionIds?: number[];
  /** Set when an earlier hold on this model exists; `priorHoldId` is that hold. */
  kind?: 'redetected';
  priorHoldId?: number;
  /** Where the detection came from; absent for a publish or an edit. */
  source?: 'training';
  /** The ruling, or `superseded` when a newer detection closed the hold without one. */
  decision?: ModelRulesHoldDecision | 'superseded';
};

const holdFieldSchema = z.object({ heading: z.string(), text: z.string() });

const holdMatchSchema = z.object({
  ruleId: z.number(),
  term: z.string(),
  field: z.string(),
  fieldIndex: z.number(),
  start: z.number(),
  end: z.number(),
});

const holdRuleSchema = z.object({
  id: z.number(),
  subject: z.string(),
  description: z.string().catch(''),
  aliases: z.array(z.string()).catch([]),
  category: modelRuleCategoryField.optional().catch(undefined),
  references: tolerantList(modelRuleReferenceField),
});

const holdMetaSchema = z.object({
  mode: z.enum(['shadow', 'active']).catch('shadow'),
  fields: tolerantList(holdFieldSchema),
  matches: tolerantList(holdMatchSchema),
  rules: tolerantList(holdRuleSchema),
  applied: z.literal(true).optional().catch(undefined),
  versionIds: z.array(z.number()).optional().catch(undefined),
  kind: z.literal('redetected').optional().catch(undefined),
  priorHoldId: z.number().optional().catch(undefined),
  source: z.literal('training').optional().catch(undefined),
  decision: z
    .enum([...MODEL_RULES_HOLD_DECISIONS, 'superseded'])
    .optional()
    .catch(undefined),
});

/** Keeps whatever entries parse: a hold written by an older build, or one with its meta nulled, still lists. */
export function parseModelRulesHoldMeta(meta: unknown): ModelRulesHoldMeta {
  const parsed = holdMetaSchema.safeParse(meta ?? {});
  const { applied, versionIds, kind, priorHoldId, source, decision, ...rest } = parsed.success
    ? parsed.data
    : holdMetaSchema.parse({});
  return {
    ...rest,
    ...(applied ? { applied } : {}),
    ...(versionIds?.length ? { versionIds } : {}),
    ...(kind ? { kind } : {}),
    ...(priorHoldId !== undefined ? { priorHoldId } : {}),
    ...(source ? { source } : {}),
    ...(decision ? { decision } : {}),
  };
}
