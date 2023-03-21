import { z } from 'zod';
import { constants } from '~/server/common/constants';

export const modelFileSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  url: z.string().url().min(1, 'You must select a file'),
  sizeKB: z.number(),
  type: z.enum(constants.modelFileTypes),
});

export type ModelFileInput = z.infer<typeof modelFileSchema>;

export type ModelFileCreateInput = z.infer<typeof modelFileCreateSchema>;
export const modelFileCreateSchema = z.object({
  name: z.string(),
  url: z.string().url().min(1, 'You must select a file'),
  sizeKB: z.number(),
  type: z.enum(constants.modelFileTypes),
  modelVersionId: z.number(),
});

export const modelFileUpdateSchema = z.object({
  id: z.number(),
  type: z.enum(constants.modelFileTypes).optional(),
  modelVersionId: z.number().optional(), // used when a user needs to reassign a file to another version
});
