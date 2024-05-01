import { TagsOnTagsType, TagTarget, TagType } from '@prisma/client';
import { z } from 'zod';
import { taggableEntitySchema, tagVotableEntitySchema } from '~/libs/tags';
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
  types: z.nativeEnum(TagType).array().optional(),
  entityType: z.nativeEnum(TagTarget).array().optional(),
  modelId: z.number().optional(),
  excludedTagIds: z.number().array().optional(),
  unlisted: z.boolean().optional(),
  categories: z.boolean().optional(),
  sort: z.nativeEnum(TagSort).optional(),
  nsfwLevel: z.number().optional(),
  include: z.enum(['nsfwLevel', 'isCategory']).array().optional(),
  moderation: z.boolean().optional(),
});
export type GetTagsInput = z.infer<typeof getTagsInput>;

export const getTrendingTagsSchema = z.object({
  limit: z.number().optional(),
  entityType: z.nativeEnum(TagTarget).array(),
  includeNsfw: z.boolean().optional(),
  excludedTagIds: z.number().array().optional(),
  unlisted: z.boolean().optional(),
});
export type GetTrendingTagsSchema = z.infer<typeof getTrendingTagsSchema>;

export const getVotableTagsSchema = z.object({
  type: tagVotableEntitySchema,
  id: z.number(),
  take: z.number().optional(),
});
export type GetVotableTagsSchema = z.infer<typeof getVotableTagsSchema>;

export type GetVotableTagsSchema2 = z.infer<typeof getVotableTagsSchema2>;
export const getVotableTagsSchema2 = z.object({
  type: tagVotableEntitySchema,
  ids: z.number().array(),
  nsfwLevel: z.number().optional(),
});

const tagIdsOrNamesSchema = z.union([
  z
    .string()
    .transform((val) => val.toLowerCase().trim())
    .array(),
  z.number().array(),
]);
export const addTagVotesSchema = z.object({
  type: tagVotableEntitySchema,
  id: z.number(),
  tags: tagIdsOrNamesSchema,
  vote: z.number().min(-1, 'Vote must be between -1 and 1').max(1, 'Vote must be between -1 and 1'),
});
export type AddTagVotesSchema = z.infer<typeof addTagVotesSchema>;

export const removeTagVotesSchema = z.object({
  type: tagVotableEntitySchema,
  id: z.number(),
  tags: tagIdsOrNamesSchema,
});
export type RemoveTagVotesSchema = z.infer<typeof removeTagVotesSchema>;

export const adjustTagsSchema = z.object({
  tags: tagIdsOrNamesSchema,
  relationship: z.nativeEnum(TagsOnTagsType).optional(),
  entityIds: z.number().array(),
  entityType: taggableEntitySchema,
});
export type AdjustTagsSchema = z.infer<typeof adjustTagsSchema>;

export const deleteTagsSchema = z.object({
  tags: tagIdsOrNamesSchema,
});
export type DeleteTagsSchema = z.infer<typeof deleteTagsSchema>;

export const moderateTagsSchema = z.object({
  entityIds: z.number().array(),
  entityType: taggableEntitySchema,
  disable: z.boolean(),
});
export type ModerateTagsSchema = z.infer<typeof moderateTagsSchema>;

export type VotableTagConnectorInput = z.infer<typeof votableTagConnectorSchema>;
export const votableTagConnectorSchema = z.object({
  entityId: z.number(),
  entityType: z.enum(['model', 'image']),
});
