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
type BuzzTypeConfig =
  | {
      type: 'spend';
      value: BuzzApiAccountType;
      purchasable?: boolean;
      bankable?: boolean;
      nsfw?: boolean;
    }
  | { type: 'bank' }
  | { type: 'cash' };

const createBuzzTypes = <T extends Record<BuzzSpendType, BuzzSpendType>>(args: T) => args;
// acts as an enum for easy code tracking
export const BuzzType = createBuzzTypes({
  blue: 'blue',
  green: 'green',
  yellow: 'yellow',
  red: 'red',
});

const buzzTypeConfig: Record<BuzzAccountType, BuzzTypeConfig> = {
  blue: { type: 'spend', value: 'generation' },
  green: { type: 'spend', value: 'green', bankable: true, purchasable: true },
  yellow: { type: 'spend', value: 'user', nsfw: true, bankable: true },
  red: { type: 'spend', value: 'fakered', nsfw: true, purchasable: true },
  creatorprogrambank: { type: 'bank' },
  cashpending: { type: 'cash' },
  cashsettled: { type: 'cash' },
};

export const buzzAccountTypes = Object.keys(buzzTypeConfig) as BuzzAccountType[];
export const buzzSpendTypes = buzzAccountTypes.filter(
  (type) => buzzTypeConfig[type].type === 'spend'
) as BuzzSpendType[];
export const buzzBankableTypes = buzzSpendTypes.filter((type) => {
  const config = buzzTypeConfig[type];
  return config.type === 'spend' && config.bankable;
}) as BuzzSpendType[];

export class BuzzTypes {
  private static apiTypesMap = Object.fromEntries(
    buzzAccountTypes.map((type) => [this.toApiType(type), type])
  );
  static getConfig(type: BuzzSpendType) {
    return buzzTypeConfig[type];
  }
  static toApiType(type: BuzzAccountType): BuzzApiAccountType {
    if (buzzApiAccountTypes.includes(type as BuzzApiAccountType)) return type as BuzzApiAccountType;
    const config = buzzTypeConfig[type];
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
