import { z } from 'zod';

export type UpdateSubscriptionSchema = z.infer<typeof updateSubscriptionSchema>;
export const updateSubscriptionSchema = z.object({
  subscribed: z.boolean(),
  email: z.string().trim().email().optional(),
});
