import { z } from 'zod';

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
});
export type UserUpsertInput = z.input<typeof userUpsertSchema>;
