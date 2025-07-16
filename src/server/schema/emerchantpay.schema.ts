import { z } from 'zod';

export type CreateBuzzCharge = z.infer<typeof createBuzzChargeSchema>;
export const createBuzzChargeSchema = z.object({
  unitAmount: z.number().positive('Amount must be positive'),
  buzzAmount: z.number().positive('Buzz amount must be positive'),
});
