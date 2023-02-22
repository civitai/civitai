import { ModelFileFormat, TagEngagementType } from '@prisma/client';
import { z } from 'zod';

export const getUserByUsernameSchema = z.object({
  username: z.string().optional(),
  id: z.number().optional(),
});

export type GetUserByUsernameSchema = z.infer<typeof getUserByUsernameSchema>;
import { getAllQuerySchema } from '~/server/schema/base.schema';

export const getAllUsersInput = getAllQuerySchema
  .extend({ email: z.string(), ids: z.array(z.number()) })
  .partial();
export type GetAllUsersInput = z.infer<typeof getAllUsersInput>;

export const userUpdateSchema = z.object({
  id: z.number(),
  username: z.string(),
  showNsfw: z.boolean().optional(),
  blurNsfw: z.boolean().optional(),
  tos: z.boolean().optional(),
  email: z.string().email().optional(),
  image: z.string().nullish(),
  preferredModelFormat: z.nativeEnum(ModelFileFormat).optional(),
  preferredPrunedModel: z.boolean().optional(),
  badgeId: z.number().nullish(),
  nameplateId: z.number().nullish(),
  autoplayGifs: z.boolean().optional(),
});
export type UserUpdateInput = z.input<typeof userUpdateSchema>;

export const toggleModelEngagementInput = z.object({ modelId: z.number() });
export type ToggleModelEngagementInput = z.infer<typeof toggleModelEngagementInput>;

export const toggleFollowUserSchema = z.object({ targetUserId: z.number() });
export type ToggleFollowUserSchema = z.infer<typeof toggleFollowUserSchema>;

export const getUserTagsSchema = z.object({ type: z.nativeEnum(TagEngagementType) });
export type GetUserTagsSchema = z.infer<typeof getUserTagsSchema>;

export const toggleBlockedTagSchema = z.object({ tagId: z.number() });
export type ToggleBlockedTagSchema = z.infer<typeof toggleBlockedTagSchema>;

export const batchBlockTagsSchema = z.object({ tagIds: z.array(z.number()) });
export type BatchBlockTagsSchema = z.infer<typeof batchBlockTagsSchema>;

export const getByUsernameSchema = z.object({ username: z.string() });
export type GetByUsernameSchema = z.infer<typeof getByUsernameSchema>;

export type DeleteUserInput = z.infer<typeof deleteUserSchema>;
export const deleteUserSchema = z.object({
  id: z.number(),
  username: z.string().optional(),
  removeModels: z.boolean().optional(),
});

export type GetUserCosmeticsSchema = z.infer<typeof getUserCosmeticsSchema>;
export const getUserCosmeticsSchema = z.object({
  equipped: z.boolean(),
});
