import { z } from 'zod';

export type CreateBuzzCharge = z.infer<typeof createBuzzChargeSchema>;
export const createBuzzChargeSchema = z.object({
  unitAmount: z.number(),
  buzzAmount: z.number(),
});
