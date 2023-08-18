import { z } from 'zod';

export enum TransactionType {
  Tip = 0,
  Dues = 1,
  Generation = 2,
  Boost = 3,
  Incentive = 4,
  Reward = 5,
  Purchase = 6,
  Refund = 7,
}

export type GetUserBuzzAccountSchema = z.infer<typeof getUserBuzzAccountSchema>;
export const getUserBuzzAccountSchema = z.object({
  // This is the user id
  accountId: z.number().min(0),
});

export type GetUserBuzzAccountResponse = z.infer<typeof getUserBuzzAccountResponse>;
export const getUserBuzzAccountResponse = z.object({
  // This is the user id
  id: z.number(),
  balance: z.number(),
});

export type GetUserBuzzTransactionsSchema = z.infer<typeof getUserBuzzTransactionsSchema>;
export const getUserBuzzTransactionsSchema = z.object({
  // accountId: z.number(),
  type: z.nativeEnum(TransactionType).optional(),
  start: z.date().optional(),
  end: z.date().optional(),
  limit: z.number().min(1).max(200).optional(),
  descending: z.boolean().optional(),
});

export type GetUserBuzzTransactionsResponse = z.infer<typeof getUserBuzzTransactionsResponse>;
export const getUserBuzzTransactionsResponse = z
  .object({
    cursor: z.date().nullish(),
    transactions: z.object({
      date: z.date(),
      type: z.nativeEnum(TransactionType),
      fromAccountId: z.number(),
      toAccountId: z.number(),
      amount: z.number(),
      description: z.string().nullish(),
      details: z.object({}).passthrough().nullish(),
    }),
  })
  .array()
  .nullish();

export type CreateBuzzTransactionInput = z.infer<typeof createBuzzTransactionInput>;
export const createBuzzTransactionInput = z.object({
  // To user id (0 is central bank)
  toAccountId: z.number().min(0),
  type: z.nativeEnum(TransactionType),
  amount: z.number().min(1),
  description: z.string().trim().nonempty().nullish(),
  details: z.object({}).passthrough().nullish(),
});
