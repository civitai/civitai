import * as z from 'zod/v4';

export type DonateToGoalInput = z.infer<typeof donateToGoalInput>;
export const donateToGoalInput = z.object({
  amount: z.number(),
  donationGoalId: z.number(),
});
