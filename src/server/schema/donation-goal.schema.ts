import * as z from 'zod';

export type DonateToGoalInput = z.infer<typeof donateToGoalInput>;
export const donateToGoalInput = z.object({
  amount: z.number(),
  donationGoalId: z.number(),
  // Minted by the client once per donation and resent on its retries: the charge's ledger ids
  // derive from it, so a retry after an unanswered donation cannot charge again. Optional for
  // clients from before keys, which get a new id per call as before.
  idempotencyKey: z.string().uuid().optional(),
});
