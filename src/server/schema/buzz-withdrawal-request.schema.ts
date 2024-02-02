import { z } from 'zod';
import { BuzzWithdrawalRequestStatus } from '@prisma/client';
import { paginationSchema } from './base.schema';
import { constants } from '~/server/common/constants';

export type CreateBuzzWithdrawalRequestSchema = z.infer<typeof createBuzzWithdrawalRequestSchema>;
export const createBuzzWithdrawalRequestSchema = z.object({
  amount: z
    .number()
    .min(constants.buzz.minBuzzWithdrawal)
    .default(constants.buzz.minBuzzWithdrawal),
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
    })
  );

export type UpdateBuzzWithdrawalRequestSchema = z.infer<typeof updateBuzzWithdrawalRequestSchema>;
export const updateBuzzWithdrawalRequestSchema = z.object({
  requestId: z.string(),
  status: z.nativeEnum(BuzzWithdrawalRequestStatus),
  note: z.string().optional(),
});

export type BuzzWithdrawalRequestHistoryMetadataSchema = z.infer<
  typeof buzzWithdrawalRequestHistoryMetadataSchema
>;
export const buzzWithdrawalRequestHistoryMetadataSchema = z.object({
  buzzTransactionId: z.string().optional(),
  stripeTransferId: z.string().optional(),
  stripeReversalId: z.string().optional(),
});
