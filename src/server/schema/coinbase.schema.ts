import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';

export type CreateBuzzCharge = z.infer<typeof createBuzzChargeSchema>;
export const createBuzzChargeSchema = z.object({
  // Whole minor units, same rule as the Stripe route. The purchase form derives this by
  // dividing a free-typed Buzz amount by 10, so any amount that is not a multiple of ten
  // yields a fraction — and `coinbase.service.ts` forwards it to `createCharge` as
  // `local_price.amount`, i.e. a sub-cent USD price like "10.004".
  //
  // 🔴 The service-side tamper check (`unitAmount !== buzzAmount / 10`) does NOT catch this:
  // both values come from the same division, so a fractional pair is perfectly self-consistent
  // and the check passes. Measured across 12 free-typed amounts: the check fires 0/12 while
  // this `.int()` rejects 12/12. This line is the only thing on this route that says no.
  unitAmount: z.number().int('The transaction amount must be a whole number of cents'),
  buzzAmount: z.number(),
});

export type CreateCodeOrder = z.infer<typeof createCodeOrderSchema>;
export const createCodeOrderSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('Buzz'),
    buzzAmount: z.number().int().min(1000),
  }),
  z.object({
    type: z.literal('Membership'),
    tier: z.enum(['bronze', 'silver', 'gold']),
    months: z.number().int().min(1).max(12),
  }),
]);

export type GetPaginatedUserTransactionHistorySchema = z.infer<
  typeof getPaginatedUserTransactionHistorySchema
>;
export const getPaginatedUserTransactionHistorySchema = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    statuses: z.array(z.enum(CryptoTransactionStatus)).optional(),
  })
);
