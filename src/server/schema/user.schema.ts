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
});
export type UserUpsertInput = z.input<typeof userUpsertSchema>;

export const toggleFavoriteModelInput = z.object({ modelId: z.number() });
export type ToggleFavoriteModelInput = z.infer<typeof toggleFavoriteModelInput>;

export const toggleFollowUserSchema = z.object({ targetUserId: z.number() });
export type ToggleFollowUserSchema = z.infer<typeof toggleFollowUserSchema>;

export const getByUsernameSchema = z.object({
  username: z.string(),
});
export type GetByUsernameSchema = z.infer<typeof getByUsernameSchema>;

export type DeleteUserInput = z.infer<typeof deleteUserSchema>;
export const deleteUserSchema = z.object({
  id: z.number(),
  displayName: z.string(),
  removeModels: z.boolean().optional(),
});
