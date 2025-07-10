import * as z from 'zod/v4';
import { paginationSchema } from '~/server/schema/base.schema';
import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';

export type CreateBuzzCharge = z.infer<typeof createBuzzChargeSchema>;
export const createBuzzChargeSchema = z.object({
  unitAmount: z.number(),
  buzzAmount: z.number(),
});

export type GetPaginatedUserTransactionHistorySchema = z.infer<
  typeof getPaginatedUserTransactionHistorySchema
>;
export const getPaginatedUserTransactionHistorySchema = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    statuses: z.array(z.nativeEnum(CryptoTransactionStatus)).optional(),
  })
);
