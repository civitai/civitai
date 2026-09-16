import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { huggingFaceImportConfigSchema } from '~/server/services/huggingface-import-config.service';

export type LookupHuggingFaceRepoInput = z.infer<typeof lookupHuggingFaceRepoSchema>;
export const lookupHuggingFaceRepoSchema = z.object({
  source: z.string().trim().min(1),
});

export type EnqueueHuggingFaceImportInput = z.infer<typeof enqueueHuggingFaceImportSchema>;
export const enqueueHuggingFaceImportSchema = z.object({
  repo: z.string().trim().min(1),
  revision: z.string().trim().min(1),
  paths: z.array(z.string().min(1)).min(1).max(100),
  groupName: z.string().trim().min(1).max(120).optional(),
});

export type GetHuggingFaceImportsInput = z.infer<typeof getHuggingFaceImportsSchema>;
export const getHuggingFaceImportsSchema = z.object({
  limit: z.number().int().min(1).max(200).default(100),
  /** Substring, case-insensitive — what a moderator types into the filter box. */
  groupName: z.string().trim().min(1).max(120).optional(),
  /** Exact `owner/name`, as Hugging Face reports it. What the skill filters by. */
  repo: z.string().trim().min(1).optional(),
  /** Completed transfers no model version has claimed. */
  unattached: z.boolean().optional(),
});

export type GetHuggingFaceImportCountsInput = z.infer<typeof getHuggingFaceImportCountsSchema>;
export const getHuggingFaceImportCountsSchema = getHuggingFaceImportsSchema.pick({
  groupName: true,
  repo: true,
});

export type AttachHuggingFaceImportInput = z.infer<typeof attachHuggingFaceImportSchema>;
export const attachHuggingFaceImportSchema = z.object({
  id: z.number().int().positive(),
  modelVersionId: z.number().int().positive(),
  // Explicit, never inferred: this is what decides whether the version is loadable.
  type: z.enum(constants.modelFileTypes),
});

export type RenameHuggingFaceGroupInput = z.infer<typeof renameHuggingFaceGroupSchema>;
export const renameHuggingFaceGroupSchema = z.object({
  repo: z.string().trim().min(1),
  revision: z.string().trim().min(1),
  /** The group's current name. Not trimmed: it must match the stored value exactly. */
  from: z.string().min(1).max(120),
  groupName: z.string().trim().min(1).max(120),
});

export type SetHuggingFaceImportConfigInput = z.infer<typeof setHuggingFaceImportConfigSchema>;
export const setHuggingFaceImportConfigSchema = huggingFaceImportConfigSchema.partial();
