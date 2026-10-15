import { z } from 'zod';

// Everything the moderator app and the main app must agree on about a Model rule lives here: its
// limits and field schemas, the definition stored on `ModerationRule`, and the shape of the scan
// result the main app writes and the moderator app reads.

export const MODEL_RULE_LIMITS = {
  subjectChars: 200,
  descriptionChars: 2000,
  aliasChars: 200,
  /** Words per subject or alias; the literal matcher's memory grows with the longest term. */
  termWords: 8,
  aliasesPerRule: 100,
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

// `ModerationRule.definition` of a Model rule the ModelRules text scan evaluates. The moderator app
// writes it and the main app reads it; a row failing this schema is skipped by the scan, so the two
// sides must share it rather than each keep a copy.
const definitionShape = {
  type: z.literal('semantic'),
  subject: z.string().trim().min(1),
  description: z.string().trim().default(''),
  aliases: z.array(z.string().trim().min(1)).default([]),
  /** The regex-era definition this rule was converted from. */
  legacyMatch: z.unknown().optional(),
  /** Converted but not yet reviewed by a person; the scan ignores it until a save clears this. */
  needsAttention: z.boolean().optional(),
  updatedById: z.number().int().optional(),
};

/** What the scan and the converter read: a rule saved before the term caps existed still loads. */
export const storedModelRuleSchema = z.object(definitionShape);

/** What every write enforces; the forms and Try overrides use the same field schemas. */
export const semanticModelRuleSchema = storedModelRuleSchema.extend({
  subject: modelRuleSubjectField(),
  description: modelRuleDescriptionField.default(''),
  aliases: modelRuleAliasesField.default([]),
});

export type SemanticModelRule = z.infer<typeof semanticModelRuleSchema>;

export const isSemanticDefinition = (definition: unknown): definition is SemanticModelRule =>
  typeof definition === 'object' &&
  definition !== null &&
  (definition as { type?: unknown }).type === 'semantic';

// ---------------------------------------------------------------------------------------------
// Stored scan result: `EntityModeration.result` of a `ModelRules` row.

export const MODEL_RULES_RESULT_KEYS = {
  labels: 'labels',
  modelRules: 'modelRules',
  matched: 'matched',
  snapshot: 'snapshot',
  literalRuleIds: 'literalRuleIds',
  fingerprint: 'fingerprint',
  meta: 'meta',
  heldAtPublish: 'heldAtPublish',
} as const;

const K = MODEL_RULES_RESULT_KEYS;

/** Postgres text-array literal for `#>`, e.g. `{labels,modelRules,matched}`. */
export const MODEL_RULES_RESULT_PG_PATHS = {
  matched: `{${K.labels},${K.modelRules},${K.matched}}`,
  literalRuleIds: `{${K.modelRules},${K.literalRuleIds}}`,
} as const;

/** The rule as it read when the scan ran, so a later edit or disable cannot rewrite what matched. */
export type StoredModelRuleSnapshot = {
  id: number;
  subject: string;
  description: string;
  aliases: string[];
};

/** The `modelRules` block of the result. `literalRuleIds` are rules the text names literally, matched or not. */
export type StoredModelRules = {
  fingerprint?: string;
  snapshot: StoredModelRuleSnapshot[];
  literalRuleIds?: number[];
};

export type StoredModelRuleMatch = { ruleId: number; reason?: string };

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

const storedMatchSchema = z.object({
  ruleId: z.number(),
  reason: z.string().optional().catch(undefined),
});

const storedSnapshotSchema = z.object({ id: z.number(), subject: z.string() });

const storedResultSchema = z.object({
  [K.labels]: z
    .object({
      [K.modelRules]: z
        .object({ [K.matched]: tolerantList(storedMatchSchema) })
        .catch({ [K.matched]: [] }),
    })
    .catch({ [K.modelRules]: { [K.matched]: [] } }),
  [K.modelRules]: z
    .object({
      [K.snapshot]: tolerantList(storedSnapshotSchema),
      [K.literalRuleIds]: tolerantList(z.number()),
    })
    .catch({ [K.snapshot]: [], [K.literalRuleIds]: [] }),
  [K.meta]: z
    .object({ [K.heldAtPublish]: z.boolean().catch(false) })
    .catch({ [K.heldAtPublish]: false }),
});

export type ParsedModelRulesResult = {
  matched: StoredModelRuleMatch[];
  snapshot: Pick<StoredModelRuleSnapshot, 'id' | 'subject'>[];
  literalRuleIds: number[];
  heldAtPublish: boolean;
};

const EMPTY_RESULT: ParsedModelRulesResult = {
  matched: [],
  snapshot: [],
  literalRuleIds: [],
  heldAtPublish: false,
};

export function parseModelRulesStoredResult(result: unknown): ParsedModelRulesResult {
  const parsed = storedResultSchema.safeParse(result);
  if (!parsed.success) return EMPTY_RESULT;
  const { labels, modelRules, meta } = parsed.data;
  return {
    matched: labels.modelRules.matched,
    snapshot: modelRules.snapshot,
    literalRuleIds: modelRules.literalRuleIds,
    heldAtPublish: meta.heldAtPublish,
  };
}
