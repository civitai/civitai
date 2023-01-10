import { ModelFileFormat, TagEngagementType } from '@prisma/client';
import { z } from 'zod';

export const getUserByUsernameSchema = z.object({
  username: z.string(),
});

export type GetUserByUsernameSchema = z.infer<typeof getUserByUsernameSchema>;
import { getAllQuerySchema } from '~/server/schema/base.schema';

export const getAllUsersInput = getAllQuerySchema.extend({ email: z.string() }).partial();
export type GetAllUsersInput = z.infer<typeof getAllUsersInput>;

export const userUpsertSchema = z.object({
  id: z.number(),
  username: z.string(),
  showNsfw: z.boolean(),
  blurNsfw: z.boolean(),
  tos: z.boolean(),
  image: z.string().nullable(),
  email: z.string().email(),
  preferredModelFormat: z.nativeEnum(ModelFileFormat),
  preferredPrunedModel: z.boolean(),
});
export type UserUpsertInput = z.input<typeof userUpsertSchema>;

export const toggleFavoriteModelInput = z.object({ modelId: z.number() });
export type ToggleFavoriteModelInput = z.infer<typeof toggleFavoriteModelInput>;

export const toggleFollowUserSchema = z.object({ targetUserId: z.number() });
export type ToggleFollowUserSchema = z.infer<typeof toggleFollowUserSchema>;

export const getUserTagsSchema = z.object({ type: z.nativeEnum(TagEngagementType) });
export type GetUserTagsSchema = z.infer<typeof getUserTagsSchema>;

export const toggleBlockedTagSchema = z.object({ tagId: z.number() });
export type ToggleBlockedTagSchema = z.infer<typeof toggleBlockedTagSchema>;

export const getByUsernameSchema = z.object({ username: z.string() });
export type GetByUsernameSchema = z.infer<typeof getByUsernameSchema>;

export type DeleteUserInput = z.infer<typeof deleteUserSchema>;
export const deleteUserSchema = z.object({
  id: z.number(),
  username: z.string(),
  removeModels: z.boolean().optional(),
});
