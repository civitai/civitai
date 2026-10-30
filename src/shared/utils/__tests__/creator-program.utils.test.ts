import { describe, it, expect } from 'vitest';
import {
  getBankCardLimits,
  getBankableBreakdown,
  getCapForDefinition,
  getNextCapDefinition,
} from '~/shared/utils/creator-program.utils';
import { MIN_CAP, type CapDefinition } from '~/shared/constants/creator-program.constants';

describe('getCapForDefinition', () => {
  it('returns limit when no percentOfPeakEarning', () => {
    const def: CapDefinition = { tier: 'bronze', limit: MIN_CAP };
    expect(getCapForDefinition(def, 2000000)).toBe(MIN_CAP);
  });

  it('returns MIN_CAP when no limit and no percentOfPeakEarning', () => {
    const def: CapDefinition = { tier: 'bronze' };
    expect(getCapForDefinition(def, 0)).toBe(MIN_CAP);
  });

  it('returns percentage of peak earnings when no limit cap', () => {
    const def: CapDefinition = { tier: 'gold', percentOfPeakEarning: 1.5 };
    expect(getCapForDefinition(def, 2000000)).toBe(3000000);
  });

  it('caps at limit when percentage exceeds it', () => {
    const def: CapDefinition = { tier: 'silver', limit: 1000000, percentOfPeakEarning: 1.25 };
    // 2000000 * 1.25 = 2500000, but limit is 1000000
    expect(getCapForDefinition(def, 2000000)).toBe(1000000);
  });

  it('uses percentage when below limit', () => {
    const def: CapDefinition = { tier: 'silver', limit: 1000000, percentOfPeakEarning: 1.25 };
    // 500000 * 1.25 = 625000, below limit of 1000000
    expect(getCapForDefinition(def, 500000)).toBe(625000);
  });

  it('returns MIN_CAP when peak earning percentage is below minimum', () => {
    const def: CapDefinition = { tier: 'gold', percentOfPeakEarning: 1.5 };
    // 50000 * 1.5 = 75000, below MIN_CAP of 100000
    expect(getCapForDefinition(def, 50000)).toBe(MIN_CAP);
  });

  it('returns limit when peak earned is 0', () => {
    const def: CapDefinition = { tier: 'silver', limit: 1000000, percentOfPeakEarning: 1.25 };
    expect(getCapForDefinition(def, 0)).toBe(1000000);
  });
});

describe('getNextCapDefinition', () => {
  it('does not suggest Bronze to Silver users (the original bug)', () => {
    // Silver user with cap of 1,000,000 and peak earnings of 2,000,000
    const result = getNextCapDefinition('silver', 1000000, 2000000);
    // Should suggest Gold (1.5 * 2M = 3M > 1M), NOT Bronze (100K < 1M)
    expect(result).toBeDefined();
    expect(result!.tier).toBe('gold');
  });

  it('suggests Gold for Silver users when Gold cap would be higher', () => {
    // Silver capped at limit: 1,000,000. Gold would give 1.5 * 1,500,000 = 2,250,000
    const result = getNextCapDefinition('silver', 1000000, 1500000);
    expect(result).toBeDefined();
    expect(result!.tier).toBe('gold');
  });

  it('returns undefined when no tier offers a higher cap', () => {
    // Gold user with very high cap, nothing can beat it
    const result = getNextCapDefinition('gold', 5000000, 5000000);
    expect(result).toBeUndefined();
  });

  it('suggests Silver for Bronze users when Silver cap would be higher', () => {
    // Bronze user with cap MIN_CAP, peak earnings of 500000
    // Silver: min(500000 * 1.25, 1000000) = 625000 > 100000
    const result = getNextCapDefinition('bronze', MIN_CAP, 500000);
    expect(result).toBeDefined();
    expect(result!.tier).toBe('silver');
  });

  it('skips hidden tiers', () => {
    // Founder is hidden; should not be suggested
    const result = getNextCapDefinition('bronze', MIN_CAP, 500000);
    expect(result).toBeDefined();
    expect(result!.tier).not.toBe('founder');
  });

  it('does not suggest the same tier', () => {
    const result = getNextCapDefinition('silver', 500000, 1000000);
    if (result) {
      expect(result.tier).not.toBe('silver');
    }
  });

  it('returns undefined for Silver when Gold would not increase cap', () => {
    // Silver user at MIN_CAP because peak earnings are very low
    // Gold: 1.5 * 50000 = 75000 → MIN_CAP = 100000, same as current
    const result = getNextCapDefinition('silver', MIN_CAP, 50000);
    expect(result).toBeUndefined();
  });
});

describe('getBankableBreakdown', () => {
  it('splits the balance into bankable this month, over the cap, and not bankable', () => {
    expect(
      getBankableBreakdown({ balance: 100_000, bankableRemaining: 70_000, capRemaining: 50_000 })
    ).toEqual({ bankableNow: 50_000, overCap: 20_000, notBankable: 30_000, limitedBy: 'cap' });
  });

  it('is limited by the bankable amount when the cap leaves more room', () => {
    expect(
      getBankableBreakdown({ balance: 100_000, bankableRemaining: 40_000, capRemaining: 500_000 })
    ).toEqual({ bankableNow: 40_000, overCap: 0, notBankable: 60_000, limitedBy: 'bankable' });
  });

  it('never counts more as bankable than the creator holds', () => {
    expect(
      getBankableBreakdown({ balance: 30_000, bankableRemaining: 90_000, capRemaining: 500_000 })
    ).toEqual({ bankableNow: 30_000, overCap: 0, notBankable: 0, limitedBy: 'bankable' });
  });

  it('is limited by the bankable amount when it equals the cap room', () => {
    expect(
      getBankableBreakdown({ balance: 100_000, bankableRemaining: 50_000, capRemaining: 50_000 })
    ).toEqual({ bankableNow: 50_000, overCap: 0, notBankable: 50_000, limitedBy: 'bankable' });
  });

  it('blames the bankable amount, not the cap, when both are used up', () => {
    expect(
      getBankableBreakdown({ balance: 50_000, bankableRemaining: 0, capRemaining: 0 })
    ).toEqual({ bankableNow: 0, overCap: 0, notBankable: 50_000, limitedBy: 'bankable' });
  });

  it('treats a negative bankable amount or balance as none', () => {
    expect(
      getBankableBreakdown({ balance: 50_000, bankableRemaining: -10_000, capRemaining: 100_000 })
    ).toEqual({ bankableNow: 0, overCap: 0, notBankable: 50_000, limitedBy: 'bankable' });
    expect(
      getBankableBreakdown({ balance: -5_000, bankableRemaining: 10_000, capRemaining: 100_000 })
    ).toEqual({ bankableNow: 0, overCap: 0, notBankable: 0, limitedBy: 'bankable' });
  });

  it('treats a used-up cap as no room rather than negative room', () => {
    expect(
      getBankableBreakdown({ balance: 50_000, bankableRemaining: 50_000, capRemaining: -10_000 })
    ).toEqual({ bankableNow: 0, overCap: 50_000, notBankable: 0, limitedBy: 'cap' });
  });
});

describe('getBankCardLimits', () => {
  const member = {
    accountBalances: [40_000, 60_000],
    selectedBalance: 60_000,
    cap: 500_000,
    bankedThisMonth: 450_000,
    bankableRemaining: 200_000,
    hasActiveMembership: true,
  };

  it('bounds Max by the selected account and the cap left, and shows both accounts in the meter', () => {
    expect(getBankCardLimits(member)).toEqual({
      maxBankable: 50_000,
      meterBalance: 100_000,
      meterCapRemaining: 50_000,
    });
  });

  it('bounds Max by the selected account when it holds less than the other limits', () => {
    expect(getBankCardLimits({ ...member, selectedBalance: 30_000 }).maxBankable).toBe(30_000);
  });

  it('bounds Max by the bankable amount, and ignores it before the cutover', () => {
    expect(
      getBankCardLimits({ ...member, bankedThisMonth: 0, bankableRemaining: 20_000 }).maxBankable
    ).toBe(20_000);
    expect(
      getBankCardLimits({ ...member, bankedThisMonth: 0, bankableRemaining: undefined }).maxBankable
    ).toBe(60_000);
  });

  it('gives the meter no cap without an active membership', () => {
    const limits = getBankCardLimits({ ...member, hasActiveMembership: false });
    expect(limits.meterCapRemaining).toBeNull();
  });

  it('gives the meter no cap, and Max nothing, without a cap', () => {
    const limits = getBankCardLimits({ ...member, cap: undefined });
    expect(limits.meterCapRemaining).toBeNull();
    expect(limits.maxBankable).toBe(0);
  });
});
