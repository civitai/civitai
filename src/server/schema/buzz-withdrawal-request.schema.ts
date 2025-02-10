import { z } from 'zod';
import { constants } from '~/server/common/constants';
import { BuzzWithdrawalRequestSort } from '~/server/common/enums';
import {
  BuzzWithdrawalRequestStatus,
  UserPaymentConfigurationProvider,
} from '~/shared/utils/prisma/enums';
import { paginationSchema } from './base.schema';

export type CreateBuzzWithdrawalRequestSchema = z.infer<typeof createBuzzWithdrawalRequestSchema>;
export const createBuzzWithdrawalRequestSchema = z.object({
  amount: z
    .number()
    .min(constants.buzz.minBuzzWithdrawal)
    .default(constants.buzz.minBuzzWithdrawal),
  provider: z
    .nativeEnum(UserPaymentConfigurationProvider)
    .default(UserPaymentConfigurationProvider.Tipalti),
});

export type GetPaginatedOwnedBuzzWithdrawalRequestSchema = z.infer<
  typeof getPaginatedOwnedBuzzWithdrawalRequestSchema
>;
export const getPaginatedOwnedBuzzWithdrawalRequestSchema = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    status: z.nativeEnum(BuzzWithdrawalRequestStatus).optional(),
  })
);
export type GetPaginatedBuzzWithdrawalRequestSchema = z.infer<
  typeof getPaginatedBuzzWithdrawalRequestSchema
>;
export const getPaginatedBuzzWithdrawalRequestSchema =
  getPaginatedOwnedBuzzWithdrawalRequestSchema.merge(
    z.object({
      username: z.string().optional(),
      userId: z.number().optional(),
      requestId: z.string().optional(),
      status: z.array(z.nativeEnum(BuzzWithdrawalRequestStatus)).optional(),
      sort: z.nativeEnum(BuzzWithdrawalRequestSort).default(BuzzWithdrawalRequestSort.Newest),
      from: z.date().optional(),
      to: z.date().optional(),
    })
  );

export type BuzzWithdrawalRequestHistoryMetadataSchema = z.infer<
  typeof buzzWithdrawalRequestHistoryMetadataSchema
>;
export const buzzWithdrawalRequestHistoryMetadataSchema = z
  .object({
    buzzTransactionId: z.string().optional(),
    stripeTransferId: z.string().optional(),
    stripeReversalId: z.string().optional(),
    tipaltiPaymentBatchId: z.string().optional(),
    tipaltiPaymentRefCode: z.string().optional(),
  })
  .passthrough();

export type UpdateBuzzWithdrawalRequestSchema = z.infer<typeof updateBuzzWithdrawalRequestSchema>;
export const updateBuzzWithdrawalRequestSchema = z.object({
  requestIds: z.array(z.string()),
  status: z.nativeEnum(BuzzWithdrawalRequestStatus),
  note: z.string().optional(),
  metadata: buzzWithdrawalRequestHistoryMetadataSchema.optional(),
  refundFees: z.number().optional(),
});
export type BuzzWithdrawalRequestServiceStatus = z.infer<
  typeof buzzWithdrawalRequestServiceStatusSchema
>;
export const buzzWithdrawalRequestServiceStatusSchema = z.object({
  maxAmount: z.number().optional(),
  message: z.string().optional(),
});
