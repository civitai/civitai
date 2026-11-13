import { describe, expect, it } from 'vitest';
import {
  buildUsageLimitConfig,
  defaultUsageLimitConfig,
  isBucketCountable,
  resolveUsageLimitValues,
  usageLimitDefs,
  type UsageLimitDef,
  type UsageLimitValues,
} from '~/shared/constants/usage-limits';

const row = (limits: Record<string, unknown>) => ({ version: 1, limits });
const subject = (tier?: string, total = 0) => ({ tier, meta: { scores: { total } } });

describe('buildUsageLimitConfig', () => {
  it('serves the code defaults with no row, and says nothing', () => {
    expect(buildUsageLimitConfig(null)).toEqual({ config: defaultUsageLimitConfig, fallbacks: [] });
    expect(buildUsageLimitConfig(undefined).fallbacks).toEqual([]);
  });

  it('serves the code defaults for a row that is not { version: 1, limits }', () => {
    const { config, fallbacks } = buildUsageLimitConfig({ limits: { 'posts.daily': { base: 5 } } });
    expect(config).toBe(defaultUsageLimitConfig);
    expect(fallbacks).toEqual([{ id: '*', reason: expect.any(String) }]);
  });

  it('applies an override up to 100x the most the code gives anyone, inclusive', () => {
    // posts.daily gives at most 300 (150 x the member 2x): the cap is 30,000, and 15,000 doubles to it.
    const { config, fallbacks } = buildUsageLimitConfig(
      row({ 'posts.daily': { base: 15_000 }, 'posts.hourly': { base: 1 } })
    );
    expect(fallbacks).toEqual([]);
    expect(config.get('posts.daily')?.base).toBe(15_000);
    expect(config.get('posts.daily')?.byScore).toEqual(
      defaultUsageLimitConfig.get('posts.daily')?.byScore
    );
    expect(config.get('posts.hourly')?.base).toBe(1);
  });

  it.each([
    ['above 100x', { base: 15_001 }],
    ['zero where the code base is not', { base: 0 }],
    ['negative', { base: -1 }],
    ['fractional', { base: 20.5 }],
    ['a score tier above 100x', { byScore: [{ minScore: 1000, limit: 15_001 }] }],
    ['a negative minScore', { byScore: [{ minScore: -1, limit: 60 }] }],
    ['a multiplier above 10', { byTier: { member: { multiplier: 11 } } }],
    ['a multiplier below 1', { byTier: { member: { multiplier: 0.5 } } }],
    [
      'a multiplier that scales a limit past 100x',
      { base: 4000, byTier: { member: { multiplier: 10 } } },
    ],
    ['an unknown tier', { byTier: { platinum: { limit: 5 } } }],
    ['an unknown field', { base: 25, window: { type: 'utc-day' } }],
    ['a wrong type', { base: '25' }],
  ])('refuses %s for that entry alone', (_, override) => {
    const { config, fallbacks } = buildUsageLimitConfig(
      row({ 'posts.daily': override, 'comments.daily': { base: 50 } })
    );
    expect(config.get('posts.daily')).toEqual(defaultUsageLimitConfig.get('posts.daily'));
    expect(config.get('comments.daily')?.base).toBe(50);
    expect(fallbacks).toEqual([{ id: 'posts.daily', reason: expect.any(String) }]);
  });

  it('allows 0 in an entry whose code base is 0', () => {
    const { config, fallbacks } = buildUsageLimitConfig(
      row({ 'resource-loads.daily': { byTier: { bronze: { limit: 0 }, gold: { limit: 12 } } } })
    );
    expect(fallbacks).toEqual([]);
    expect(
      resolveUsageLimitValues(config.get('resource-loads.daily')!, subject('bronze')).limit
    ).toBe(0);
  });

  it('disables a product limit, never an abuse cap', () => {
    const { config, fallbacks } = buildUsageLimitConfig(
      row({ 'comments.daily': { disabled: true }, 'reactions.daily': { disabled: true } })
    );
    expect(config.get('comments.daily')?.disabled).toBe(true);
    expect(config.get('reactions.daily')).toEqual(defaultUsageLimitConfig.get('reactions.daily'));
    expect(fallbacks).toEqual([{ id: 'reactions.daily', reason: expect.any(String) }]);
  });

  it('ignores overrides of a gate and of unknown ids', () => {
    const { config, fallbacks } = buildUsageLimitConfig(
      row({ 'articles.first-day': { base: 5 }, 'gifts.nope': { base: 5 } })
    );
    expect(config.get('articles.first-day')?.base).toBe(0);
    expect(fallbacks.map((f) => f.id).sort()).toEqual(['articles.first-day', 'gifts.nope']);
  });

  it('replaces byScore and byTier whole rather than merging them', () => {
    const { config } = buildUsageLimitConfig(
      row({
        'posts.daily': {
          byScore: [{ minScore: 2000, limit: 70 }],
          byTier: { gold: { limit: 500 } },
        },
      })
    );
    const values = config.get('posts.daily')!;
    expect(resolveUsageLimitValues(values, subject('free', 1000)).limit).toBe(20);
    expect(resolveUsageLimitValues(values, subject('free', 2000)).limit).toBe(70);
    // The code `member` rule is gone with the replaced byTier.
    expect(resolveUsageLimitValues(values, subject('bronze')).limit).toBe(20);
    expect(resolveUsageLimitValues(values, subject('gold')).limit).toBe(500);
  });

  it('every code default is itself within bounds', () => {
    const limits = Object.fromEntries(
      usageLimitDefs
        .filter((def) => !('configurable' in def))
        .map((def) => {
          const { base, byScore, byTier } = def as UsageLimitDef;
          return [def.id, { base, byScore, byTier }];
        })
    );
    expect(buildUsageLimitConfig(row(limits)).fallbacks).toEqual([]);
  });
});

describe('resolveUsageLimitValues tier order', () => {
  const values: UsageLimitValues = {
    base: 10,
    byScore: [{ minScore: 1000, limit: 30 }],
    byTier: { member: { multiplier: 2 }, gold: { limit: 100 } },
  };
  const limit = (tier?: string, total = 0) =>
    resolveUsageLimitValues(values, subject(tier, total)).limit;

  it('an explicit tier entry wins over member', () => {
    expect(limit('gold')).toBe(100);
    expect(limit('gold', 1000)).toBe(100);
  });

  it('member covers bronze and silver, scaling the score tier', () => {
    expect(limit('bronze')).toBe(20);
    expect(limit('silver', 1000)).toBe(60);
  });

  it('founder is not a member unless listed', () => {
    expect(limit('founder')).toBe(10);
    expect(limit('founder', 1000)).toBe(30);
  });

  it('free and no tier get the score tier alone', () => {
    expect(limit('free', 1000)).toBe(30);
    expect(limit(undefined)).toBe(10);
  });
});

/**
 * The monthly gift allowance (claims per UTC month: free 3, Bronze 15, Silver 30, Gold 60) is the
 * next entry the registry takes. Its shape, resolved, without registering it.
 */
describe('a per-tier calendar-month entry', () => {
  const gifts: UsageLimitValues = {
    base: 3,
    byTier: { bronze: { limit: 15 }, silver: { limit: 30 }, gold: { limit: 60 } },
  };

  it.each([
    [undefined, 3],
    ['free', 3],
    ['bronze', 15],
    ['silver', 30],
    ['gold', 60],
    ['founder', 3],
  ])('tier %s gets %i, whatever the Creator Score', (tier, expected) => {
    expect(resolveUsageLimitValues(gifts, subject(tier, 50_000)).limit).toBe(expected);
  });

  it('cannot be counted by rateLimit()', () => {
    expect(isBucketCountable({ type: 'utc-month' })).toBe(false);
    expect(isBucketCountable({ type: 'utc-day' })).toBe(false);
    expect(isBucketCountable({ type: 'rolling', seconds: 2 * 24 * 60 * 60 })).toBe(false);
    expect(isBucketCountable({ type: 'rolling', seconds: 24 * 60 * 60 })).toBe(true);
  });
});
