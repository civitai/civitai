import * as z from 'zod/v4';
import { buzzConstants } from '~/shared/constants/buzz.constants';

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
  AuthorizedPurchase = 20,
  Compensation = 21,
  Appeal = 22,
  Bank = 23,
  Extract = 24,
  Fee = 25,
  Bid = 26,
}

export type BuzzApiAccountType = (typeof buzzApiAccountTypes)[number];
export const buzzApiAccountTypes = [
  'user', // yellow
  'club',
  'generation', // blue
  // NEW TYPES:
  'green',
  'fakered',
  'red',
  // WHEN LOOKING INTO CLICKHOUSE, THESE ARE PARSED AS KEBAB CASE.
  'creatorprogrambank',
  'cashpending',
  'cashsettled',
] as const;

export type BuzzSpendType = 'blue' | 'green' | 'yellow' | 'red';
export type BuzzCreatorProgramType = 'creatorprogrambank';
export type BuzzCashType = 'cashpending' | 'cashsettled';
export type BuzzAccountType = BuzzSpendType | BuzzCreatorProgramType | BuzzCashType;
type BuzzConfig =
  | {
      type: 'spend';
      value: BuzzApiAccountType;
      purchasable?: boolean;
      bankable?: boolean;
      nsfw?: boolean;
    }
  | { type: 'bank' }
  | { type: 'cash' };
// const BuzzConfig = <T extends Record<BuzzSpendType, BuzzConfig>>(args: T) => args;
const buzzConfig: Record<BuzzAccountType, BuzzConfig> = {
  blue: { type: 'spend', value: 'generation' },
  green: { type: 'spend', value: 'green', bankable: true, purchasable: true },
  yellow: { type: 'spend', value: 'user', nsfw: true, bankable: true },
  red: { type: 'spend', value: 'fakered', nsfw: true, purchasable: true },
  creatorprogrambank: { type: 'bank' },
  cashpending: { type: 'cash' },
  cashsettled: { type: 'cash' },
};

export const buzzAccountTypes = Object.keys(buzzConfig) as BuzzAccountType[];
export const buzzSpendTypes = buzzAccountTypes.filter(
  (type) => buzzConfig[type].type === 'spend'
) as BuzzSpendType[];
export const buzzBankableTypes = buzzSpendTypes.filter((type) => {
  const config = buzzConfig[type];
  return config.type === 'spend' && config.bankable;
}) as BuzzSpendType[];

export class BuzzTypes {
  private static apiTypesMap = Object.fromEntries(
    buzzAccountTypes.map((type) => [this.toApiType(type), type])
  );
  static getConfig(type: BuzzSpendType) {
    return buzzConfig[type];
  }
  static toApiType(type: BuzzAccountType): BuzzApiAccountType {
    if (buzzApiAccountTypes.includes(type as BuzzApiAccountType)) return type as BuzzApiAccountType;
    const config = buzzConfig[type];
    return config.type === 'spend' ? config.value : (type as BuzzApiAccountType);
  }
  static getApiTransaction<
    T extends { fromAccountType?: BuzzAccountType; toAccountType?: BuzzAccountType }
  >(transaction: T) {
    return {
      ...transaction,
      fromAccountType: transaction.fromAccountType
        ? this.toApiType(transaction.fromAccountType)
        : undefined,
      toAccountType: transaction.toAccountType
        ? this.toApiType(transaction.toAccountType)
        : undefined,
    };
  }
  static toClientType(value: BuzzApiAccountType): BuzzAccountType {
    if (!(value in this.apiTypesMap)) throw new Error(`unsupported buzz type: ${value}`);
    return this.apiTypesMap[value];
  }
}

const buzzAccountTypeFromApiValueSchema = z
  .enum(buzzApiAccountTypes)
  .transform(BuzzTypes.toClientType);

export function preprocessAccountType(value: unknown) {
  return typeof value === 'string' ? value?.toLowerCase() : undefined;
}

export type GetUserBuzzAccountSchema = z.infer<typeof getUserBuzzAccountSchema>;
export const getUserBuzzAccountSchema = z.object({
  // This is the user id
  accountId: z.number().min(0),
  accountType: z.preprocess(preprocessAccountType, z.enum(buzzAccountTypes).optional()),
  accountTypes: z.array(z.preprocess(preprocessAccountType, z.enum(buzzAccountTypes))).optional(),
});

export type GetEarnPotentialSchema = z.infer<typeof getEarnPotentialSchema>;
export const getEarnPotentialSchema = z.object({
  userId: z.number().min(0).optional(),
  username: z.string().optional(),
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
  accountType: z.enum(buzzAccountTypes).optional(),
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

// export type GetBuzzTransactionResponse = z.infer<typeof getBuzzTransactionResponse>;
export const getBuzzTransactionResponse = z.object({
  date: z.coerce.date(),
  type: z
    .any()
    .transform((value) =>
      parseInt(value) ? TransactionType.Tip : TransactionType[value as keyof typeof TransactionType]
    ),
  fromAccountId: z.coerce.number(),
  toAccountId: z.coerce.number(),
  fromAccountType: z.preprocess(preprocessAccountType, buzzAccountTypeFromApiValueSchema),
  toAccountType: z.preprocess(preprocessAccountType, buzzAccountTypeFromApiValueSchema),
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
  .check((ctx) => {
    if (
      ctx.value.entityType &&
      ['Image', 'Model', 'Article'].includes(ctx.value.entityType) &&
      ctx.value.amount > buzzConstants.maxEntityTip
    ) {
      ctx.issues.push({
        code: 'custom',
        message: `Your generosity abounds. Unfortunately you're attempting to tip more buzz than allowed in a single transaction`,
        input: ctx.value,
      });
    }
  });

export const getBuzzAccountSchema = z.object({
  accountId: z.number(),
  accountType: z.preprocess(preprocessAccountType, z.enum(buzzAccountTypes).optional()),
  accountTypes: z.array(z.preprocess(preprocessAccountType, z.enum(buzzAccountTypes))).optional(),
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

export type GetDailyBuzzCompensationInput = z.infer<typeof getDailyBuzzCompensationInput>;
export const getDailyBuzzCompensationInput = z.object({
  userId: z.number().optional(),
  date: z.coerce.date(),
});

export type ClaimWatchedAdRewardInput = z.infer<typeof claimWatchedAdRewardSchema>;
export const claimWatchedAdRewardSchema = z.object({ key: z.string() });

export type GetTransactionsReportSchema = z.infer<typeof getTransactionsReportSchema>;
export const getTransactionsReportSchema = z.object({
  accountType: z.array(z.enum(buzzSpendTypes)).optional(),
  window: z.enum(['hour', 'day', 'week', 'month']).default('hour'),
});

export type GetTransactionsReportResultSchema = z.infer<typeof getTransactionsReportResultSchema>;
export const getTransactionsReportResultSchema = z.array(
  z.object({
    date: z.date(),
    accounts: z.array(
      z.object({
        accountType: buzzAccountTypeFromApiValueSchema,
        spent: z.number(),
        gained: z.number(),
      })
    ),
  })
);

export type GetBuzzMovementsBetweenAccounts = z.infer<typeof getBuzzMovementsBetweenAccounts>;
export const getBuzzMovementsBetweenAccounts = z.object({
  accountId: z.number().min(0),
  accountType: z.preprocess(preprocessAccountType, z.enum(buzzAccountTypes).optional()),
  counterPartyAccountId: z.number().min(0),
  counterPartyAccountType: z.preprocess(preprocessAccountType, z.enum(buzzAccountTypes).optional()),
});

export type GetBuzzMovementsBetweenAccountsResponse = z.infer<
  typeof getBuzzMovementsBetweenAccountsResponse
>;
export const getBuzzMovementsBetweenAccountsResponse = z.object({
  // This is the user id
  accountType: z.preprocess(preprocessAccountType, z.enum(buzzAccountTypes).optional()),
  accountId: z.number(),
  counterPartyAccountType: z.preprocess(preprocessAccountType, z.enum(buzzAccountTypes).optional()),
  counterPartyAccountId: z.number(),
  inwardsBalance: z.number(),
  outwardsBalance: z.number(),
  totalBalance: z.number(),
});

// Multi-account transaction schemas
export type CreateMultiAccountBuzzTransactionInput = z.infer<
  typeof createMultiAccountBuzzTransactionInput
>;
export const createMultiAccountBuzzTransactionInput = z.object({
  fromAccountTypes: z.array(z.preprocess(preprocessAccountType, z.enum(buzzAccountTypes))).min(1),
  fromAccountId: z.number().min(1),
  toAccountType: z.preprocess(preprocessAccountType, z.enum(buzzAccountTypes)).optional(),
  toAccountId: z.number().min(0),
  type: z.nativeEnum(TransactionType).optional(),
  amount: z.number().min(1),
  details: z.object({}).passthrough().optional(),
  externalTransactionIdPrefix: z.string(),
  description: z.string().trim().max(100).nonempty().nullish(),
});

// export type CreateMultiAccountBuzzTransactionResponse = z.infer<
//   typeof createMultiAccountBuzzTransactionResponse
// >;
export const createMultiAccountBuzzTransactionResponse = z.object({
  transactionIds: z.array(
    z.object({
      transactionId: z.string(),
      accountType: buzzAccountTypeFromApiValueSchema,
      amount: z.number(),
    })
  ),
  totalAmount: z.number(),
  transactionCount: z.number(),
});

export type RefundMultiAccountTransactionInput = z.infer<typeof refundMultiAccountTransactionInput>;
export const refundMultiAccountTransactionInput = z.object({
  externalTransactionIdPrefix: z.string(),
  description: z.string().optional(),
  details: z.object({}).passthrough().optional(),
});

// export type RefundMultiAccountTransactionResponse = z.infer<
//   typeof refundMultiAccountTransactionResponse
// >;
export const refundMultiAccountTransactionResponse = z.object({
  refundedTransactions: z.array(
    z.object({
      originalTransactionId: z.string(),
      refundTransactionId: z.string(),
      accountType: buzzAccountTypeFromApiValueSchema,
      amount: z.number(),
      originalExternalTransactionId: z.string(),
    })
  ),
  totalRefunded: z.number(),
  externalTransactionIdPrefix: z.string(),
});

export type PreviewMultiAccountTransactionInput = z.infer<
  typeof previewMultiAccountTransactionInput
>;
export const previewMultiAccountTransactionInput = z.object({
  fromAccountId: z.number().min(1),
  fromAccountTypes: z.array(z.preprocess(preprocessAccountType, z.enum(buzzAccountTypes))).min(1),
  amount: z.number().min(1),
});

// export type PreviewMultiAccountTransactionResponse = z.infer<
//   typeof previewMultiAccountTransactionResponse
// >;
export const previewMultiAccountTransactionResponse = z.object({
  isPossible: z.boolean(),
  totalAvailableBalance: z.number(),
  requestedAmount: z.number(),
  accountCharges: z.array(
    z.object({
      accountType: buzzAccountTypeFromApiValueSchema,
      availableBalance: z.number(),
      chargeAmount: z.number(),
      remainingBalance: z.number(),
    })
  ),
  remainingAmount: z.number(),
  message: z.string(),
});
