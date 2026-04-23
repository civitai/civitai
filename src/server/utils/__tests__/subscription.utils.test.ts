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
        {
          id: 'tok_1',
          tier: 'gold',
          status: 'unlocked',
          buzzAmount: 50000,
          unlockedAt: '2024-01-15T00:00:00Z',
        },
        { id: 'tok_2', tier: 'gold', status: 'locked', buzzAmount: 50000 },
        {
          id: 'tok_3',
          tier: 'silver',
          status: 'claimed',
          buzzAmount: 25000,
          claimedAt: '2024-01-10T00:00:00Z',
        },
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

  it('returns next month when this month drop has passed', () => {
    // Today is Jan 20 UTC, period started Jan 15 — Jan 15 01:00 UTC is past
    vi.setSystemTime(new Date(Date.UTC(2024, 0, 20)));

    const result = getNextTokenUnlockDate(new Date(Date.UTC(2024, 0, 15)));

    expect(result.toISOString()).toBe('2024-02-15T01:15:00.000Z');
  });

  it('returns this month when drop instant has not passed yet', () => {
    // Today is Jan 10 UTC, period started Jan 15 — Jan 15 01:00 UTC is upcoming
    vi.setSystemTime(new Date(Date.UTC(2024, 0, 10)));

    const result = getNextTokenUnlockDate(new Date(Date.UTC(2024, 0, 15)));

    expect(result.toISOString()).toBe('2024-01-15T01:15:00.000Z');
  });

  it('handles month-end: Jan 31 start → Feb 29 (leap year)', () => {
    vi.setSystemTime(new Date(Date.UTC(2024, 1, 1)));

    const result = getNextTokenUnlockDate(new Date(Date.UTC(2024, 0, 31)));

    expect(result.toISOString()).toBe('2024-02-29T01:15:00.000Z');
  });

  it('handles month-end: Jan 31 start → Feb 28 in non-leap year', () => {
    vi.setSystemTime(new Date(Date.UTC(2025, 1, 1)));

    const result = getNextTokenUnlockDate(new Date(Date.UTC(2025, 0, 31)));

    expect(result.toISOString()).toBe('2025-02-28T01:15:00.000Z');
  });

  it('handles month-end: Jan 31 start → Mar 31 (after Feb)', () => {
    vi.setSystemTime(new Date(Date.UTC(2024, 2, 1)));

    const result = getNextTokenUnlockDate(new Date(Date.UTC(2024, 0, 31)));

    expect(result.toISOString()).toBe('2024-03-31T01:15:00.000Z');
  });

  it('handles month-end: Jan 31 start → Apr 30 (30-day month)', () => {
    vi.setSystemTime(new Date(Date.UTC(2024, 3, 1)));

    const result = getNextTokenUnlockDate(new Date(Date.UTC(2024, 0, 31)));

    expect(result.toISOString()).toBe('2024-04-30T01:15:00.000Z');
  });

  it('returns next month when today IS the drop day but 01:00 UTC has passed', () => {
    // Today is Jan 15 at 02:00 UTC — drop at 01:00 UTC already fired
    vi.setSystemTime(new Date(Date.UTC(2024, 0, 15, 2, 0, 0)));

    const result = getNextTokenUnlockDate(new Date(Date.UTC(2024, 0, 15)));

    expect(result.toISOString()).toBe('2024-02-15T01:15:00.000Z');
  });

  it('returns today when today IS the drop day and 01:00 UTC has not passed', () => {
    // Today is Jan 15 at 00:30 UTC — drop at 01:00 UTC is upcoming
    vi.setSystemTime(new Date(Date.UTC(2024, 0, 15, 0, 30, 0)));

    const result = getNextTokenUnlockDate(new Date(Date.UTC(2024, 0, 15)));

    expect(result.toISOString()).toBe('2024-01-15T01:15:00.000Z');
  });

  it('year rollover: Dec 15 start → Jan 15 next year', () => {
    vi.setSystemTime(new Date(Date.UTC(2024, 11, 20)));

    const result = getNextTokenUnlockDate(new Date(Date.UTC(2024, 11, 15)));

    expect(result.toISOString()).toBe('2025-01-15T01:15:00.000Z');
  });

  it('uses UTC day from ISO string regardless of viewer local TZ', () => {
    // periodStart stored as 2026-02-23 23:12 UTC — UTC day is 23
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 22, 12, 0, 0))); // Apr 22 noon UTC

    const result = getNextTokenUnlockDate('2026-02-23T23:12:31.195Z');

    // Next drop is Apr 23 01:00 UTC (PT renders as Apr 22 evening)
    expect(result.toISOString()).toBe('2026-04-23T01:15:00.000Z');
  });
});
