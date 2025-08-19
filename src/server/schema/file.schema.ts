import * as z from 'zod';

export const baseFileSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  url: z.url().min(1, 'You must select a file'),
  sizeKB: z.number(),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type BaseFileSchema = z.infer<typeof baseFileSchema>;

export const FileEntityType = {
  Article: 'Article',
  Bounty: 'Bounty',
  BountyEntry: 'BountyEntry',
} as const;
export type FileEntityType = (typeof FileEntityType)[keyof typeof FileEntityType];

export type GetFilesByEntitySchema = z.infer<typeof getFilesByEntitySchema>;
export const getFilesByEntitySchema = z.object({
  id: z.number().optional(),
  ids: z.array(z.number()).optional(),
  type: z.enum(FileEntityType),
});
