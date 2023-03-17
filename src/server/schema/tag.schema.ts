import { TagTarget } from '@prisma/client';
import { z } from 'zod';
import { tagVotableEntitySchema } from '~/libs/tags';
import { TagSort } from '~/server/common/enums';
import { getAllQuerySchema } from '~/server/schema/base.schema';

export type GetTagByNameInput = z.infer<typeof getTagByNameSchema>;
export const getTagByNameSchema = z.object({
  name: z.string(),
});

export type TagUpsertSchema = z.infer<typeof tagSchema>;
export const tagSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  isCategory: z.boolean().optional(),
  color: z.string().nullish(),
});

export const isTag = (tag: TagUpsertSchema): tag is Omit<TagUpsertSchema, 'id'> & { id: number } =>
  !!tag.id;
export const isNotTag = (
  tag: TagUpsertSchema
): tag is Omit<TagUpsertSchema, 'id'> & { id: undefined } => !tag.id;

export const getTagsInput = getAllQuerySchema.extend({
  withModels: z
    .preprocess((val) => {
      return val === 'true' || val === true;
    }, z.boolean().default(false))
    .optional(),
  entityType: z.nativeEnum(TagTarget).array().optional(),
  modelId: z.number().optional(),
  not: z.number().array().optional(),
  unlisted: z.boolean().optional(),
  categories: z.boolean().optional(),
  sort: z.nativeEnum(TagSort).optional(),
});
export type GetTagsInput = z.infer<typeof getTagsInput>;

export const getTrendingTagsSchema = z.object({
  limit: z.number().optional(),
  entityType: z.nativeEnum(TagTarget).array(),
  includeNsfw: z.boolean().optional(),
  not: z.number().array().optional(),
  unlisted: z.boolean().optional(),
});
export type GetTrendingTagsSchema = z.infer<typeof getTrendingTagsSchema>;

export const getVotableTagsSchema = z.object({
  type: tagVotableEntitySchema,
  id: z.number(),
  take: z.number().optional(),
});
export type GetVotableTagsSchema = z.infer<typeof getVotableTagsSchema>;

export const addTagVotesSchema = z.object({
  type: tagVotableEntitySchema,
  id: z.number(),
  tags: z.union([
    z
      .string()
      .transform((val) => val.toLowerCase().trim())
      .array(),
    z.number().array(),
  ]),
  vote: z.number().min(-1, 'Vote must be between -1 and 1').max(1, 'Vote must be between -1 and 1'),
});
export type AddTagVotesSchema = z.infer<typeof addTagVotesSchema>;

export const removeTagVotesSchema = z.object({
  type: tagVotableEntitySchema,
  id: z.number(),
  tags: z.union([
    z
      .string()
      .transform((val) => val.toLowerCase().trim())
      .array(),
    z.number().array(),
  ]),
});
export type RemoveTagVotesSchema = z.infer<typeof removeTagVotesSchema>;
