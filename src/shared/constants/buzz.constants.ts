import { BuzzClientAccount } from '@civitai/client';
import {
  buzzApiAccountTypes,
  clientToApiAccountType,
  toApiType as buzzToApiType,
  toClientType as buzzToClientType,
  toApiTransaction as buzzToApiTransaction,
} from '@civitai/buzz';
import type {
  BuzzApiAccountType,
  BuzzAccountType,
  BuzzSpendType,
  BuzzCreatorProgramType,
  BuzzCashType,
  LegacyBuzzType,
} from '@civitai/buzz';

// The account-type model + friendly↔API name map now live in @civitai/buzz (browser-safe,
// shared with the SvelteKit spokes). Re-exported here so existing imports keep working.
export { buzzApiAccountTypes };
export type {
  BuzzApiAccountType,
  BuzzAccountType,
  BuzzSpendType,
  BuzzCreatorProgramType,
  BuzzCashType,
  LegacyBuzzType,
};

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
  LicenseFee = 27,
}

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

const BuzzClientAccountMap: Record<BuzzSpendType, BuzzClientAccount> = {
  blue: BuzzClientAccount.BLUE,
  green: BuzzClientAccount.GREEN,
  yellow: BuzzClientAccount.YELLOW,
  red: BuzzClientAccount.FAKE_RED,
};

// `value` is sourced from the package's canonical friendly→API map (single source, no drift);
// the UX flags (nsfw/purchasable/bankable/disabled) stay app-side.
const buzzTypeConfig: Record<BuzzAccountType, BuzzTypeConfig> = {
  blue: { type: 'spend', value: clientToApiAccountType.blue },
  green: { type: 'spend', value: clientToApiAccountType.green, bankable: true, purchasable: true },
  yellow: {
    type: 'spend',
    value: clientToApiAccountType.yellow,
    nsfw: true,
    bankable: true,
    purchasable: true,
  },
  red: {
    type: 'spend',
    value: clientToApiAccountType.red,
    nsfw: true,
    purchasable: true,
    disabled: true,
  },
  creatorProgramBank: { type: 'bank', value: clientToApiAccountType.creatorProgramBank },
  creatorProgramBankGreen: { type: 'bank', value: clientToApiAccountType.creatorProgramBankGreen },
  cashPending: { type: 'cash', value: clientToApiAccountType.cashPending },
  cashSettled: { type: 'cash', value: clientToApiAccountType.cashSettled },
  club: { type: 'legacy', value: clientToApiAccountType.club },
};

export const buzzAccountTypes = Object.keys(buzzTypeConfig) as BuzzAccountType[];
// CH-side accountType aliases that resolve to the cashSettled buzz account.
export const CASH_SETTLED_ALIASES = new Set<string>(['CashSettled', 'cashSettled', 'cash-settled']);
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

export class BuzzTypes {
  static getConfig(type: BuzzSpendType) {
    return buzzTypeConfig[type];
  }
  static toApiType(type: BuzzAccountType): BuzzApiAccountType {
    return buzzToApiType(type);
  }
  static toClientType(value: string): BuzzAccountType {
    return buzzToClientType(value);
  }
  static toSpendType(value: string): BuzzSpendType {
    const type = this.toClientType(value);
    if (!buzzSpendTypes.includes(type as BuzzSpendType))
      throw new Error(`unsupported buzz type: ${value}`);
    return type as BuzzSpendType;
  }
  static toOrchestratorType(value: BuzzSpendType): BuzzClientAccount;
  static toOrchestratorType(value: BuzzSpendType[]): BuzzClientAccount[];
  static toOrchestratorType(
    value: BuzzSpendType | BuzzSpendType[]
  ): BuzzClientAccount | BuzzClientAccount[] {
    if (Array.isArray(value)) return value.map((x) => BuzzClientAccountMap[x]);
    return BuzzClientAccountMap[value];
  }

  static getApiTransaction<
    T extends { fromAccountType?: BuzzAccountType; toAccountType?: BuzzAccountType }
  >(transaction: T) {
    return buzzToApiTransaction(transaction);
  }
}

export const buzzConstants = {
  minChargeAmount: 100, // $1.00
  minStripeChargeAmount: 500, // $5.00
  maxChargeAmount: 99999999, // $999,999.99
  cutoffDate: new Date('2023-10-17T00:00:00.000Z'),
  onboardingBonusAmount: 100,
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
