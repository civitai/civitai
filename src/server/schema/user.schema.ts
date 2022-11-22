import { z } from 'zod';

export const getUserByUsernameSchema = z.object({
  username: z.string(),
});

export type GetUserByUsernameSchema = z.infer<typeof getUserByUsernameSchema>;
