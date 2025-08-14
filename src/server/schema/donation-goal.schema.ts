import * as z from 'zod';

export type DonateToGoalInput = z.infer<typeof donateToGoalInput>;
export const donateToGoalInput = z.object({
  amount: z.number(),
  donationGoalId: z.number(),
});
