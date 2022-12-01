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
  email: z.string().email().nullable(),
});
export type UserUpsertInput = z.input<typeof userUpsertSchema>;

export const toggleFavoriteModelInput = z.object({ modelId: z.number() });
export type ToggleFavoriteModelInput = z.infer<typeof toggleFavoriteModelInput>;
