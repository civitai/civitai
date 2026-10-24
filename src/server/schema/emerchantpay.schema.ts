import { z } from 'zod/v4';

export type CreateBuzzCharge = z.infer<typeof createBuzzChargeSchema>;
export const createBuzzChargeSchema = z.object({
  // Whole minor units, same rule as the Stripe and Coinbase routes — the purchase form's
  // Buzz-to-cents division is the shared source of a fraction. See `coinbase.schema.ts`.
  unitAmount: z
    .number()
    .int('The transaction amount must be a whole number of cents')
    .positive('Amount must be positive'),
  buzzAmount: z.number().positive('Buzz amount must be positive'),
});
