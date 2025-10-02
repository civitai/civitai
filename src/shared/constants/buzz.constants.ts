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
  'User',
  'Yellow',
  'Club',
  'Event',
  'Generation',
  'Blue',
  'Green',
  'FakeRed',
  'Other',
  // WHEN LOOKING INTO CLICKHOUSE, THESE ARE PARSED AS KEBAB CASE.
  'CashPending',
  'CashSettled',
  'CreatorProgramBank',
  'CreatorProgramBankGreen',
] as const;

export type BuzzSpendType = 'blue' | 'green' | 'yellow'; // 'red' is disabled
export type BuzzCreatorProgramType = 'creatorprogrambank' | 'creatorprogrambankgreen';
export type BuzzCashType = 'cashpending' | 'cashsettled';
export type LegacyBuzzType = 'club';
export type BuzzAccountType =
  | BuzzSpendType
  | BuzzCreatorProgramType
  | BuzzCashType
  | LegacyBuzzType;
type BuzzTypeConfig =
  | {
      type: 'spend';
      value: BuzzApiAccountType;
      purchasable?: boolean;
      bankable?: boolean;
      nsfw?: boolean;
      disabled?: boolean;
    }
  | { type: 'bank'; value: BuzzApiAccountType }
  | { type: 'cash'; value: BuzzApiAccountType }
  | { type: 'legacy'; value: BuzzApiAccountType };

const createBuzzTypes = <T extends Record<BuzzSpendType, BuzzSpendType>>(args: T) => args;
// acts as an enum for easy code tracking
export const BuzzType = createBuzzTypes({
  blue: 'blue',
  green: 'green',
  yellow: 'yellow',
  red: 'red',
});

const buzzTypeConfig: Record<BuzzAccountType, BuzzTypeConfig> = {
  blue: { type: 'spend', value: 'Generation' },
  green: { type: 'spend', value: 'Green', bankable: true, purchasable: true },
  yellow: { type: 'spend', value: 'User', nsfw: true, bankable: true },
  red: { type: 'spend', value: 'FakeRed', nsfw: true, purchasable: true, disabled: true },
  creatorprogrambank: { type: 'bank', value: 'CreatorProgramBank' },
  creatorprogrambankgreen: { type: 'bank', value: 'CreatorProgramBankGreen' },
  cashpending: { type: 'cash', value: 'CashPending' },
  cashsettled: { type: 'cash', value: 'CashSettled' },
  club: { type: 'legacy', value: 'Club' },
};

export const buzzAccountTypes = Object.keys(buzzTypeConfig) as BuzzAccountType[];
export const buzzSpendTypes = buzzAccountTypes.filter(
  (type) => buzzTypeConfig[type].type === 'spend' && !buzzTypeConfig[type].disabled
) as BuzzSpendType[];
export const buzzBankTypes = buzzSpendTypes.filter((type) => {
  const config = buzzTypeConfig[type];
  return config.type === 'spend' && config.bankable;
}) as BuzzSpendType[];
export const buzzPurchaseTypes = buzzSpendTypes.filter((type) => {
  const config = buzzTypeConfig[type];
  return config.type === 'spend' && config.purchasable;
});

function getApiTypeFromClientType(type: BuzzAccountType) {
  const config = buzzTypeConfig[type];
  if (!config) return type as BuzzApiAccountType;
  return config.value;
}

const apiTypesMap = Object.fromEntries(
  buzzAccountTypes.flatMap((type) => {
    return [
      [getApiTypeFromClientType(type as BuzzAccountType), type],
      [getApiTypeFromClientType(type as BuzzAccountType).toLowerCase(), type],
    ];
  })
);

export class BuzzTypes {
  static getConfig(type: BuzzSpendType) {
    return buzzTypeConfig[type];
  }
  static toApiType(type: BuzzAccountType): BuzzApiAccountType {
    return getApiTypeFromClientType(type);
  }
  static toClientType(value: string): BuzzAccountType {
    if (!(value in apiTypesMap)) throw new Error(`unsupported buzz type: ${value}`);
    return apiTypesMap[value as BuzzApiAccountType];
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
}

export const buzzConstants = {
  minChargeAmount: 500, // $5.00
  maxChargeAmount: 99999999, // $999,999.99
  cutoffDate: new Date('2023-10-17T00:00:00.000Z'),
  referralBonusAmount: 500,
  maxTipAmount: 100000000,
  minTipAmount: 50,
  maxEntityTip: 2000,
  buzzDollarRatio: 1000,
  platformFeeRate: 3000, // 30.00%. Divide by 10000
  minBuzzWithdrawal: 100000,
  maxBuzzWithdrawal: 100000000,
  generationBuzzChargingStartDate: new Date('2024-04-04T00:00:00.000Z'),
};
