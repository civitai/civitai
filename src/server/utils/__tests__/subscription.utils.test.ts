import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrepaidToken, SubscriptionMetadata } from '~/server/schema/subscriptions.schema';
import { getPrepaidTokens, getNextTokenUnlockDate } from '~/shared/utils/subscription-tokens';

describe('getPrepaidTokens', () => {
  describe('null/empty metadata', () => {
    it('returns empty array for null metadata', () => {
      expect(getPrepaidTokens({ metadata: null })).toEqual([]);
    });

    it('returns empty array for undefined metadata', () => {
      expect(getPrepaidTokens({ metadata: undefined })).toEqual([]);
    });

    it('returns empty array for metadata with no tokens and no prepaids', () => {
      expect(getPrepaidTokens({ metadata: {} })).toEqual([]);
    });
  });

  describe('new token format', () => {
    it('returns tokens directly when tokens array exists', () => {
      const tokens: PrepaidToken[] = [
        { id: 'tok_1', tier: 'gold', status: 'unlocked', buzzAmount: 50000, unlockedAt: '2024-01-15T00:00:00Z' },
        { id: 'tok_2', tier: 'gold', status: 'locked', buzzAmount: 50000 },
        { id: 'tok_3', tier: 'silver', status: 'claimed', buzzAmount: 25000, claimedAt: '2024-01-10T00:00:00Z' },
      ];
      const metadata: SubscriptionMetadata = { tokens };

      const result = getPrepaidTokens({ metadata });

      expect(result).toHaveLength(3);
      expect(result).toBe(tokens); // Same reference — not a copy
    });

    it('prioritizes tokens array over legacy prepaids when both exist', () => {
      const tokens: PrepaidToken[] = [
        { id: 'tok_1', tier: 'gold', status: 'unlocked', buzzAmount: 50000 },
      ];
      const metadata: SubscriptionMetadata = {
        tokens,
        prepaids: { gold: 5, silver: 3 }, // Should be ignored
      };

      const result = getPrepaidTokens({ metadata });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('tok_1');
    });

    it('falls back to legacy prepaids when tokens array is empty', () => {
      const metadata: SubscriptionMetadata = {
        tokens: [],
        prepaids: { silver: 2 },
      };

      const result = getPrepaidTokens({ metadata });

      expect(result).toHaveLength(2);
      expect(result[0].tier).toBe('silver');
      expect(result[0].id).toMatch(/^legacy_/);
    });
  });

  describe('legacy prepaids conversion', () => {
    it('converts single-tier prepaids to locked tokens', () => {
      const metadata: SubscriptionMetadata = {
        prepaids: { gold: 3 },
      };

      const result = getPrepaidTokens({ metadata });

      expect(result).toHaveLength(3);
      for (const token of result) {
        expect(token.tier).toBe('gold');
        expect(token.status).toBe('locked');
        expect(token.buzzAmount).toBe(50000);
        expect(token.id).toMatch(/^legacy_gold_/);
      }
    });

    it('converts multi-tier prepaids with correct buzz amounts', () => {
      const metadata: SubscriptionMetadata = {
        prepaids: { gold: 1, silver: 2, bronze: 3 },
      };

      const result = getPrepaidTokens({ metadata });

      expect(result).toHaveLength(6); // 1 + 2 + 3

      const goldTokens = result.filter((t) => t.tier === 'gold');
      const silverTokens = result.filter((t) => t.tier === 'silver');
      const bronzeTokens = result.filter((t) => t.tier === 'bronze');

      expect(goldTokens).toHaveLength(1);
      expect(goldTokens[0].buzzAmount).toBe(50000);

      expect(silverTokens).toHaveLength(2);
      expect(silverTokens[0].buzzAmount).toBe(25000);

      expect(bronzeTokens).toHaveLength(3);
      expect(bronzeTokens[0].buzzAmount).toBe(10000);
    });

    it('orders tokens gold first, then silver, then bronze', () => {
      const metadata: SubscriptionMetadata = {
        prepaids: { bronze: 1, gold: 1, silver: 1 },
      };

      const result = getPrepaidTokens({ metadata });

      expect(result[0].tier).toBe('gold');
      expect(result[1].tier).toBe('silver');
      expect(result[2].tier).toBe('bronze');
    });

    it('generates unique IDs per tier with index suffix', () => {
      const metadata: SubscriptionMetadata = {
        prepaids: { silver: 3 },
      };

      const result = getPrepaidTokens({ metadata });

      expect(result[0].id).toBe('legacy_silver_0');
      expect(result[1].id).toBe('legacy_silver_1');
      expect(result[2].id).toBe('legacy_silver_2');
    });

    it('all legacy tokens are locked with no dates set', () => {
      const metadata: SubscriptionMetadata = {
        prepaids: { gold: 2 },
      };

      const result = getPrepaidTokens({ metadata });

      for (const token of result) {
        expect(token.status).toBe('locked');
        expect(token.unlockedAt).toBeUndefined();
        expect(token.claimedAt).toBeUndefined();
        expect(token.buzzTransactionId).toBeUndefined();
      }
    });

    it('ignores tiers with zero or negative counts', () => {
      const metadata: SubscriptionMetadata = {
        prepaids: { gold: 0, silver: -1, bronze: 2 },
      };

      const result = getPrepaidTokens({ metadata });

      expect(result).toHaveLength(2);
      expect(result.every((t) => t.tier === 'bronze')).toBe(true);
    });

    it('ignores buzzTransactionIds — historical deliveries are fetched on-demand separately', () => {
      const metadata: SubscriptionMetadata = {
        prepaids: { silver: 1 },
        buzzTransactionIds: [
          'civitai-membership:2024-01:1:prod_silver:v3',
          'civitai-membership:2024-02:1:prod_silver:v3',
        ],
      };

      const result = getPrepaidTokens({ metadata });

      // Only 1 locked token from prepaids — buzzTransactionIds are not synthesized into tokens
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('locked');
      expect(result.filter((t) => t.status === 'claimed')).toHaveLength(0);
    });

    it('returns empty when only buzzTransactionIds exist with no prepaids', () => {
      const metadata: SubscriptionMetadata = {
        prepaids: {},
        buzzTransactionIds: ['civitai-membership:2024-03:1:prod_gold:v3'],
      };

      expect(getPrepaidTokens({ metadata })).toEqual([]);
    });

    it('returns empty array when prepaids exists but all tiers are zero', () => {
      const metadata: SubscriptionMetadata = {
        prepaids: { gold: 0, silver: 0, bronze: 0 },
      };

      expect(getPrepaidTokens({ metadata })).toEqual([]);
    });
  });
});

describe('getNextTokenUnlockDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns next month when this months delivery day has passed', () => {
    // Today is Jan 20, period started on the 15th — delivery day 15 has passed
    vi.setSystemTime(new Date(2024, 0, 20)); // Jan 20, 2024

    const result = getNextTokenUnlockDate(new Date(2024, 0, 15));

    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(15);
  });

  it('returns this month when delivery day has not passed yet', () => {
    // Today is Jan 10, period started on the 15th — delivery day 15 has not passed
    vi.setSystemTime(new Date(2024, 0, 10)); // Jan 10, 2024

    const result = getNextTokenUnlockDate(new Date(2024, 0, 15));

    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(15);
  });

  it('handles month-end: Jan 31 start → Feb 28/29', () => {
    // Period started Jan 31. Today is Feb 1 — next delivery should be Feb 28 (2024 is leap year = 29)
    vi.setSystemTime(new Date(2024, 1, 1)); // Feb 1, 2024

    const result = getNextTokenUnlockDate(new Date(2024, 0, 31));

    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(29); // 2024 is a leap year
  });

  it('handles month-end: Jan 31 start → Feb 28 in non-leap year', () => {
    vi.setSystemTime(new Date(2025, 1, 1)); // Feb 1, 2025

    const result = getNextTokenUnlockDate(new Date(2025, 0, 31));

    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(28); // 2025 is not a leap year
  });

  it('handles month-end: Jan 31 start → Mar 31 (after Feb)', () => {
    // Today is Mar 1, period started Jan 31 — next delivery should be Mar 31
    vi.setSystemTime(new Date(2024, 2, 1)); // Mar 1, 2024

    const result = getNextTokenUnlockDate(new Date(2024, 0, 31));

    expect(result.getMonth()).toBe(2); // March
    expect(result.getDate()).toBe(31);
  });

  it('handles month-end: Jan 31 start → Apr 30 (month with 30 days)', () => {
    // Today is Apr 1, period started Jan 31 — next delivery should be Apr 30
    vi.setSystemTime(new Date(2024, 3, 1)); // Apr 1, 2024

    const result = getNextTokenUnlockDate(new Date(2024, 0, 31));

    expect(result.getMonth()).toBe(3); // April
    expect(result.getDate()).toBe(30); // April only has 30 days
  });

  it('returns next month when today IS the delivery day', () => {
    // Today is Jan 15, period started Jan 15 — delivery day IS today, should return Feb 15
    vi.setSystemTime(new Date(2024, 0, 15, 12, 0, 0)); // Jan 15, noon

    const result = getNextTokenUnlockDate(new Date(2024, 0, 15));

    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(15);
  });

  it('accepts string dates', () => {
    vi.setSystemTime(new Date(2024, 0, 10));

    // Use a local date string to avoid timezone offset issues with getDate()
    const result = getNextTokenUnlockDate(new Date(2024, 0, 15).toISOString());

    expect(result.getDate()).toBe(15);
  });
});
