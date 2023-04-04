import { TagEngagementType } from '@prisma/client';
import { z } from 'zod';
import { constants } from '~/server/common/constants';

import { getAllQuerySchema } from '~/server/schema/base.schema';

export const usernameSchema = z
  .string()
  // .min(3, 'Your username must be at least 3 characters long')
  .regex(/^[A-Za-z0-9_]*$/, 'The "username" field can only contain letters, numbers, and _.')
  .transform((v) => v.trim());

export const getUserByUsernameSchema = z.object({
  username: usernameSchema.optional(),
  id: z.number().optional(),
});

export type GetUserByUsernameSchema = z.infer<typeof getUserByUsernameSchema>;

export const getAllUsersInput = getAllQuerySchema
  .extend({ email: z.string(), ids: z.array(z.number()) })
  .partial();
export type GetAllUsersInput = z.infer<typeof getAllUsersInput>;

export const userUpdateSchema = z.object({
  id: z.number(),
  username: usernameSchema,
  showNsfw: z.boolean().optional(),
  blurNsfw: z.boolean().optional(),
  tos: z.boolean().optional(),
  onboarded: z.boolean().optional(),
  email: z.string().email().optional().nullable(),
  image: z.string().nullish(),
  badgeId: z.number().nullish(),
  nameplateId: z.number().nullish(),
  autoplayGifs: z.boolean().optional(),
  filePreferences: z
    .object({
      format: z.enum(constants.modelFileFormats).optional(),
      size: z.enum(constants.modelFileSizes).optional(),
      fp: z.enum(constants.modelFileFp).optional(),
    })
    .optional(),
});
export type UserUpdateInput = z.input<typeof userUpdateSchema>;

export const toggleModelEngagementInput = z.object({ modelId: z.number() });
export type ToggleModelEngagementInput = z.infer<typeof toggleModelEngagementInput>;

export const toggleFollowUserSchema = z.object({
  targetUserId: z.number(),
  username: usernameSchema.nullable().optional(),
});
export type ToggleFollowUserSchema = z.infer<typeof toggleFollowUserSchema>;

export const getUserTagsSchema = z.object({ type: z.nativeEnum(TagEngagementType) });
export type GetUserTagsSchema = z.infer<typeof getUserTagsSchema>;

export const toggleBlockedTagSchema = z.object({ tagId: z.number() });
export type ToggleBlockedTagSchema = z.infer<typeof toggleBlockedTagSchema>;

export const batchBlockTagsSchema = z.object({ tagIds: z.array(z.number()) });
export type BatchBlockTagsSchema = z.infer<typeof batchBlockTagsSchema>;

export const getByUsernameSchema = z.object({ username: usernameSchema });
export type GetByUsernameSchema = z.infer<typeof getByUsernameSchema>;

export type DeleteUserInput = z.infer<typeof deleteUserSchema>;
export const deleteUserSchema = z.object({
  id: z.number(),
  username: usernameSchema.optional(),
  removeModels: z.boolean().optional(),
});

export type GetUserCosmeticsSchema = z.infer<typeof getUserCosmeticsSchema>;
export const getUserCosmeticsSchema = z.object({
  equipped: z.boolean(),
});
