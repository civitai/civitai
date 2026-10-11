import {
  CAP_DEFINITIONS,
  MIN_CAP,
  type CapDefinition,
} from '~/shared/constants/creator-program.constants';
import type { UserTier } from '~/server/schema/user.schema';

export function getCapForDefinition(def: CapDefinition, peakEarned: number): number {
  let cap = def.limit ?? MIN_CAP;
  if (def.percentOfPeakEarning && peakEarned) {
    const peakEarnedCap = peakEarned * def.percentOfPeakEarning;
    if (peakEarnedCap < MIN_CAP) cap = MIN_CAP;
    else cap = Math.min(peakEarnedCap, def.limit ?? Infinity);
  }
  return cap;
}

export function getNextCapDefinition(
  currentTier: UserTier,
  currentCap: number,
  peakEarned: number
): CapDefinition | undefined {
  return CAP_DEFINITIONS.find((c) => {
    if (c.tier === currentTier || c.hidden) return false;
    return getCapForDefinition(c, peakEarned) > currentCap;
  });
}

export type BankableBreakdown = {
  /** What can be banked this month: bankable, held, and within the cap. */
  bankableNow: number;
  /** Bankable and held, but over what the cap still allows this month. */
  overCap: number;
  /** Held but not bankable. */
  notBankable: number;
  limitedBy: 'cap' | 'bankable';
};

/** Splits a creator's yellow + green balance by what of it can be banked this month. */
export function getBankableBreakdown({
  balance,
  bankableRemaining,
  capRemaining,
}: {
  balance: number;
  bankableRemaining: number;
  capRemaining: number;
}): BankableBreakdown {
  const held = Math.max(0, balance);
  // Spending lowers the balance but not `bankableRemaining`, so it can exceed the balance.
  const bankable = Math.min(Math.max(0, bankableRemaining), held);
  const cap = Math.max(0, capRemaining);
  const bankableNow = Math.min(bankable, cap);

  return {
    bankableNow,
    overCap: bankable - bankableNow,
    notBankable: held - bankable,
    limitedBy: cap < bankable ? 'cap' : 'bankable',
  };
}

/** The bank card's limits, derived once so the Max button and the meter cannot disagree. */
export function getBankCardLimits({
  accountBalances,
  selectedBalance,
  cap,
  bankedThisMonth,
  bankableRemaining,
  hasActiveMembership,
}: {
  accountBalances: number[];
  selectedBalance: number;
  cap: number | undefined;
  bankedThisMonth: number;
  bankableRemaining: number | undefined;
  hasActiveMembership: boolean;
}) {
  const capRemaining = cap ? cap - bankedThisMonth : 0;

  return {
    // A deposit draws on one account, so Max is bounded by that account alone.
    maxBankable: getBankableBreakdown({
      balance: selectedBalance,
      bankableRemaining: bankableRemaining ?? Infinity,
      capRemaining,
    }).bankableNow,
    meterBalance: accountBalances.reduce((sum, balance) => sum + balance, 0),
    meterCapRemaining: hasActiveMembership && cap ? capRemaining : null,
  };
}
