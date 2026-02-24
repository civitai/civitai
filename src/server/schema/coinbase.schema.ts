import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';

export type CreateBuzzCharge = z.infer<typeof createBuzzChargeSchema>;
export const createBuzzChargeSchema = z.object({
  unitAmount: z.number(),
  buzzAmount: z.number(),
});

const ALLOWED_BUZZ_AMOUNTS = [10000, 25000, 50000] as const;

export type CreateCodeOrder = z.infer<typeof createCodeOrderSchema>;
export const createCodeOrderSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('Buzz'),
    buzzAmount: z
      .number()
      .refine((v): v is (typeof ALLOWED_BUZZ_AMOUNTS)[number] =>
        (ALLOWED_BUZZ_AMOUNTS as readonly number[]).includes(v)
      ),
  }),
  z.object({
    type: z.literal('Membership'),
    tier: z.enum(['bronze', 'silver', 'gold']),
    months: z.number().refine((v) => [3, 6, 12].includes(v)),
  }),
]);

export type GetCodeOrder = z.infer<typeof getCodeOrderSchema>;
export const getCodeOrderSchema = z.object({
  orderId: z.string().regex(/^code-\d+-\d+$/, 'Invalid order ID format'),
});

export type GetPaginatedUserTransactionHistorySchema = z.infer<
  typeof getPaginatedUserTransactionHistorySchema
>;
export const getPaginatedUserTransactionHistorySchema = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    statuses: z.array(z.enum(CryptoTransactionStatus)).optional(),
  })
);
