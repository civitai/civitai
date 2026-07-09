import * as z from 'zod';
import { MAX_SEED } from '~/shared/constants/generation.constants';
import { MAX_PROMPT_LENGTH } from '~/shared/data-graph/generation/common';
import { WILDCARD_CATEGORY_NAME } from '~/utils/prompt-helpers';

// Category names match the import-side normalization (basename of the source
// .txt, with path separators allowed for nested zip layouts). Trimmed to
// avoid leading/trailing whitespace mismatching the citext index. Charset is
// shared (WILDCARD_CATEGORY_NAME) so it can't drift from the prompt `#ref`
// parser or the import `__nested__` parser.
const categoryNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(new RegExp(`^${WILDCARD_CATEGORY_NAME}$`), {
    error:
      'Category name must start with a letter or number and contain only letters, numbers, _.-/',
  });

// A snippet value is the literal text we store in WildcardSetCategory.values.
// Practical cap of 4000 chars matches typical prompt-template length; longer
// values are almost always paste mistakes.
const snippetValueSchema = z.string().min(1).max(4000);

export const getWildcardSetsInputSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(50),
});
export type GetWildcardSetsInput = z.infer<typeof getWildcardSetsInputSchema>;

export const saveUserSnippetInputSchema = z.object({
  category: categoryNameSchema,
  value: snippetValueSchema,
});
export type SaveUserSnippetInput = z.infer<typeof saveUserSnippetInputSchema>;

export const removeUserSnippetInputSchema = z.object({
  categoryId: z.number().int().positive(),
  value: snippetValueSchema,
});
export type RemoveUserSnippetInput = z.infer<typeof removeUserSnippetInputSchema>;

export const updateUserSnippetInputSchema = z.object({
  categoryId: z.number().int().positive(),
  oldValue: snippetValueSchema,
  newValue: snippetValueSchema,
});
export type UpdateUserSnippetInput = z.infer<typeof updateUserSnippetInputSchema>;

export const reorderUserSnippetsInputSchema = z.object({
  categoryId: z.number().int().positive(),
  values: z.array(snippetValueSchema).min(1).max(1000),
});
export type ReorderUserSnippetsInput = z.infer<typeof reorderUserSnippetsInputSchema>;

export const deleteUserSnippetCategoryInputSchema = z.object({
  categoryId: z.number().int().positive(),
});
export type DeleteUserSnippetCategoryInput = z.infer<typeof deleteUserSnippetCategoryInputSchema>;

export const loadWildcardSetFromModelVersionInputSchema = z.object({
  modelVersionId: z.number().int().positive(),
});
export type LoadWildcardSetFromModelVersionInput = z.infer<
  typeof loadWildcardSetFromModelVersionInputSchema
>;

export const previewSnippetExpansionInputSchema = z.object({
  // Same authorization predicate as the resolver: System-kind is public,
  // User-kind must match `ownerUserId == requester`. IDs the caller isn't
  // authorized for get silently dropped server-side.
  wildcardSetIds: z.array(z.number().int().positive()).max(50).default([]),
  // Templates keyed by snippet target name. Mirrors the snippets node's
  // `targets` map declared by each ecosystem subgraph — the form sends the
  // target keys it wants previewed (e.g. `{ prompt: '...' }` for a
  // prompt-only ecosystem; `{ prompt, negativePrompt }` when both exist).
  // The single MAX_PROMPT_LENGTH cap is the loosest valid cap for any
  // current snippet target; if future targets need bigger caps we'll
  // revisit. Empty record is valid — the resolver no-ops cleanly.
  targets: z.record(z.string(), z.string().max(MAX_PROMPT_LENGTH)).default({}),
  // Optional explicit seed for reproducible preview. Omit to let the server
  // sample a fresh seed each call — returned in the response so the form can
  // surface a "regenerate" affordance keyed to the same seed if needed.
  seed: z.number().int().min(1).max(MAX_SEED).optional(),
});
export type PreviewSnippetExpansionInput = z.infer<typeof previewSnippetExpansionInputSchema>;
