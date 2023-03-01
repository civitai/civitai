import { z } from 'zod';
import { imageMetaSchema } from '~/server/schema/image.schema';

export type PostCreateInput = z.infer<typeof postCreateSchema>;
export const postCreateSchema = z.object({
  modelVersionId: z.number().optional(),
});

export type PostUpdateInput = z.infer<typeof postUpdateSchema>;
export const postUpdateSchema = z.object({
  id: z.number(),
  nsfw: z.boolean().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
});

export type AddPostTagSchema = z.infer<typeof addPostTagSchema>;
export const addPostTagSchema = z.object({
  postId: z.number(),
  id: z.number().optional(),
  name: z.string(),
});

// consider moving image creation to post service?
export type AddPostImageInput = z.infer<typeof addPostImageSchema>;
export const addPostImageSchema = z.object({
  name: z.string().nullish(),
  url: z.string().url().or(z.string().uuid()),
  hash: z.string().nullish(),
  height: z.number().nullish(),
  width: z.number().nullish(),
  nsfw: z.boolean().optional(),
  resources: z.array(z.string()).optional(),
  postId: z.number(),
  index: z.number(),
  meta: z.preprocess((value) => {
    if (typeof value !== 'object') return null;
    if (value && !Object.keys(value).length) return null;
    return value;
  }, imageMetaSchema.nullish()),
});
