import { z } from 'zod';

export type GetUserProfileSchema = z.infer<typeof getUserProfileSchema>;
export const getUserProfileSchema = z.object({
  username: z.string(),
});
