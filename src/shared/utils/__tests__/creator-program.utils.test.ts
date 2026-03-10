import { describe, it, expect } from 'vitest';
import { getCapForDefinition, getNextCapDefinition } from '~/shared/utils/creator-program.utils';
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
