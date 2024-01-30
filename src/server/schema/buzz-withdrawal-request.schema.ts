import { z } from 'zod';
import { BuzzWithdrawalRequestStatus } from '@prisma/client';
import { paginationSchema } from './base.schema';

export type CreateBuzzWithdrawalRequestSchema = z.infer<typeof createBuzzWithdrawalRequestSchema>;
export const createBuzzWithdrawalRequestSchema = z.object({
  amount: z.number().min(1),
});

export type GetPaginatedBuzzWithdrawalRequestSchema = z.infer<
  typeof getPaginatedBuzzWithdrawalRequestSchema
>;
export const getPaginatedBuzzWithdrawalRequestSchema = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    status: z.nativeEnum(BuzzWithdrawalRequestStatus).optional(),
  })
);
export type GetPaginatedBuzzWithdrawalRequestForModerationSchema = z.infer<
  typeof getPaginatedBuzzWithdrawalRequestForModerationSchema
>;
export const getPaginatedBuzzWithdrawalRequestForModerationSchema =
  getPaginatedBuzzWithdrawalRequestSchema.merge(
    z.object({
      username: z.string().optional(),
      userId: z.number().optional(),
    })
  );
