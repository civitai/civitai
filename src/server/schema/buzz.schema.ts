import { z } from 'zod';
import { constants } from '~/server/common/constants';

export enum TransactionType {
  Tip = 0,
  Dues = 1,
  Generation = 2,
  Boost = 3,
  Incentive = 4,
  Reward = 5,
  Purchase = 6,
  Refund = 7,
  Bounty = 8,
  BountyEntry = 9,
  Training = 10,
  ChargeBack = 11,
  Donation = 12,
  ClubMembership = 13,
  ClubMembershipRefund = 14,
  ClubWithdrawal = 15,
  ClubDeposit = 16,
  Withdrawal = 17,
  Redeemable = 18,
  Sell = 19,
}

const buzzAccountTypes = ['User', 'Club', 'Other'] as const;
export type BuzzAccountType = (typeof buzzAccountTypes)[number];

export type GetUserBuzzAccountSchema = z.infer<typeof getUserBuzzAccountSchema>;
export const getUserBuzzAccountSchema = z.object({
  // This is the user id
  accountId: z.number().min(0),
  accountType: z.enum(buzzAccountTypes).optional(),
});

export type GetUserBuzzAccountResponse = z.infer<typeof getUserBuzzAccountResponse>;
export const getUserBuzzAccountResponse = z.object({
  // This is the user id
  id: z.number(),
  balance: z.number().nullable(),
  lifetimeBalance: z.number().nullable(),
});

export type GetUserBuzzTransactionsSchema = z.infer<typeof getUserBuzzTransactionsSchema>;
export const getUserBuzzTransactionsSchema = z.object({
  // accountId: z.number(),
  type: z.nativeEnum(TransactionType).optional(),
  cursor: z.date().optional(),
  start: z.date().nullish(),
  end: z.date().nullish(),
  limit: z.number().min(1).max(200).optional(),
  descending: z.boolean().optional(),
});

export const buzzTransactionDetails = z
  .object({
    user: z.string().optional(),
    entityId: z.number().optional(),
    entityType: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

export type BuzzTransactionDetails = z.infer<typeof buzzTransactionDetails>;

export type GetBuzzTransactionResponse = z.infer<typeof getBuzzTransactionResponse>;
export const getBuzzTransactionResponse = z.object({
  date: z.coerce.date(),
  type: z
    .any()
    .transform((value) =>
      parseInt(value) ? TransactionType.Tip : TransactionType[value as keyof typeof TransactionType]
    ),
  fromAccountId: z.coerce.number(),
  toAccountId: z.coerce.number(),
  fromAccountType: z.enum(buzzAccountTypes),
  toAccountType: z.enum(buzzAccountTypes),
  amount: z.coerce.number(),
  description: z.coerce.string().nullish(),
  details: buzzTransactionDetails.nullish(),
});

export type GetUserBuzzTransactionsResponse = z.infer<typeof getUserBuzzTransactionsResponse>;
export const getUserBuzzTransactionsResponse = z.object({
  cursor: z.coerce.date().nullish(),
  transactions: getBuzzTransactionResponse.array(),
});

export const buzzTransactionSchema = z.object({
  // To user id (0 is central bank)
  toAccountType: z.enum(buzzAccountTypes).optional(),
  toAccountId: z.number().optional(),
  type: z.nativeEnum(TransactionType),
  amount: z.number().min(1),
  description: z.string().trim().max(100).nonempty().nullish(),
  details: z.object({}).passthrough().nullish(),
  entityId: z.number().optional(),
  entityType: z.string().optional(),
  externalTransactionId: z.string().optional(),
});

export type CreateBuzzTransactionInput = z.infer<typeof createBuzzTransactionInput>;
export const createBuzzTransactionInput = buzzTransactionSchema.refine(
  (data) => {
    if (
      data.type === TransactionType.Tip &&
      ((data.entityId && !data.entityType) || (!data.entityId && data.entityType))
    ) {
      return false;
    }

    return true;
  },
  {
    message: 'Please provide both the entityId and entityType',
    params: ['entityId', 'entityType'],
  }
);

export type CompleteStripeBuzzPurchaseTransactionInput = z.infer<
  typeof completeStripeBuzzPurchaseTransactionInput
>;

export const completeStripeBuzzPurchaseTransactionInput = z.object({
  amount: z.number().min(1),
  stripePaymentIntentId: z.string(),
  details: z.object({}).passthrough().nullish(),
});

export type UserBuzzTransactionInputSchema = z.infer<typeof userBuzzTransactionInputSchema>;

export const userBuzzTransactionInputSchema = buzzTransactionSchema
  .omit({
    type: true,
  })
  .superRefine((data) => {
    if (
      data.entityType &&
      ['Image', 'Model', 'Article'].includes(data.entityType) &&
      data.amount > constants.buzz.maxEntityTip
    )
      return false;
    return true;
  });

export const getBuzzAccountSchema = z.object({
  accountId: z.number(),
  accountType: z.enum(buzzAccountTypes).default('User'),
});

export type GetBuzzAccountSchema = z.infer<typeof getBuzzAccountSchema>;

export const getBuzzAccountTransactionsSchema =
  getUserBuzzTransactionsSchema.merge(getBuzzAccountSchema);
export type GetBuzzAccountTransactionsSchema = z.infer<typeof getBuzzAccountTransactionsSchema>;

export const clubTransactionSchema = z.object({
  clubId: z.number(),
  amount: z.number(),
});

export type ClubTransactionSchema = z.infer<typeof clubTransactionSchema>;
