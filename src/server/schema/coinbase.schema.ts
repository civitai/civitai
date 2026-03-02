import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';

export type CreateBuzzCharge = z.infer<typeof createBuzzChargeSchema>;
export const createBuzzChargeSchema = z.object({
  unitAmount: z.number(),
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
