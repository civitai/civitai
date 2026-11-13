import * as z from 'zod';

export type DonateToGoalInput = z.infer<typeof donateToGoalInput>;
export const donateToGoalInput = z.object({
  amount: z.number(),
  donationGoalId: z.number(),
  // Minted by the client once per donation and resent on its retries: the charge's ledger ids
  // derive from it, so a retry after an unanswered donation cannot charge again. Optional: without
  // one, every call is a new donation under a new id, with no dedup.
  idempotencyKey: z.string().uuid().optional(),
});
