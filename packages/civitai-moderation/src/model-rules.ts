import { z } from 'zod';

// `ModerationRule.definition` of a Model rule the ModelRules text scan evaluates. The moderator app
// writes it and the main app reads it; a row failing this schema is skipped by the scan, so the two
// sides must share it rather than each keep a copy.
export const semanticModelRuleSchema = z.object({
  type: z.literal('semantic'),
  subject: z.string().trim().min(1),
  description: z.string().trim().default(''),
  aliases: z.array(z.string().trim().min(1)).default([]),
  /** The regex-era definition this rule was converted from. */
  legacyMatch: z.unknown().optional(),
  /** Converted but not yet reviewed by a person; the scan ignores it until a save clears this. */
  needsAttention: z.boolean().optional(),
  updatedById: z.number().int().optional(),
});

export type SemanticModelRule = z.infer<typeof semanticModelRuleSchema>;

export const isSemanticDefinition = (definition: unknown): definition is SemanticModelRule =>
  typeof definition === 'object' &&
  definition !== null &&
  (definition as { type?: unknown }).type === 'semantic';
