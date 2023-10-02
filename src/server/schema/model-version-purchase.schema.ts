import { z } from 'zod';
import { Currency, ModelVersionMonetizationType } from '@prisma/client';

export type PurchaseModelVersionInput = z.infer<typeof purchaseModelVersionInput>;
export const purchaseModelVersionInput = z.object({
  modelVersionId: z.number(),
  userId: z.number().optional(), // defaults to current user.
});

export type ModelVersionPurchaseTransactionDetailsSchema = z.infer<
  typeof modelVersionPurchaseTransactionDetailsSchema
>;

export const modelVersionPurchaseTransactionDetailsSchema = z
  .object({
    monetizationType: z.nativeEnum(ModelVersionMonetizationType),
    unitAmount: z.number(),
    currency: z.nativeEnum(Currency),
  })
  .partial();
