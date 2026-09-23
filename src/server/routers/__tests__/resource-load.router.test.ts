import { describe, expect, it } from 'vitest';
import type { SessionUser } from '~/types/session';
import {
  RESOURCE_LOAD_HOURLY_LIMIT,
  assertCanRequestLoad,
  resourceLoadRateLimits,
} from '~/server/routers/resource-load.router';
import { CacheTTL } from '~/server/common/constants';
import { userTiers } from '~/server/services/feature-flags.service';

const user = (overrides: Partial<SessionUser> = {}) =>
  ({ id: 7, tier: 'bronze', isModerator: false, ...overrides } as SessionUser);

/** The gate, not the quota — see `assertCanRequestLoad` for why the limiter cannot stand in for it. */
describe('assertCanRequestLoad', () => {
  it.each(['bronze', 'silver', 'gold', 'founder'] as const)('allows a %s member', (tier) => {
    expect(() => assertCanRequestLoad(user({ tier }))).not.toThrow();
  });

  it('allows a moderator whatever their tier', () => {
    expect(() => assertCanRequestLoad(user({ tier: 'free', isModerator: true }))).not.toThrow();
  });

  it('refuses a free account', () => {
    expect(() => assertCanRequestLoad(user({ tier: 'free' }))).toThrow(/member benefit/);
  });

  it('refuses an account with no tier at all', () => {
    // A session that predates tiers, or one whose subscription lookup failed, must fail CLOSED.
    expect(() => assertCanRequestLoad(user({ tier: undefined }))).toThrow(/member benefit/);
  });
});

/**
 * 🔴 A tier that matches NO row gets no limit at all — not the strictest one. `rateLimit()` collects
 * matching rules into `validLimits` and then loops over them; an empty list means the loop never
 * runs and `canProceed` stays true. So "every tier matches something, in every window" is the
 * property, and it is one an added tier or a deleted unconditional row silently breaks.
 */
describe('resourceLoadRateLimits', () => {
  const matching = (tier: string) =>
    resourceLoadRateLimits.filter((r) => !('userReq' in r) || r.userReq?.({ tier }));

  it.each([...userTiers])('a %s user matches a rule in every window', (tier) => {
    const periods = new Set(matching(tier).map((r) => r.period));

    expect(periods.has(CacheTTL.day), `${tier} has no daily limit`).toBe(true);
    expect(periods.has(CacheTTL.hour), `${tier} has no hourly limit`).toBe(true);
  });

  it('caps bursts for every tier, including the most generous', () => {
    // The hourly row is the cluster's, not the plan's: no tier may buy its way out of it.
    for (const tier of userTiers) {
      const hourly = matching(tier).filter((r) => r.period === CacheTTL.hour);
      expect(hourly.map((r) => r.limit)).toEqual([RESOURCE_LOAD_HOURLY_LIMIT]);
    }
  });

  it('refuses a free account outright on the daily window', () => {
    const daily = matching('free').filter((r) => r.period === CacheTTL.day);

    // `limit: 0` short-circuits before the off-by-one comparison, so free means exactly zero.
    expect(Math.max(...daily.map((r) => r.limit))).toBe(0);
  });

  it('gives paying tiers a daily allowance above zero', () => {
    for (const tier of ['bronze', 'silver', 'gold', 'founder'] as const) {
      const daily = matching(tier).filter((r) => r.period === CacheTTL.day);
      expect(Math.max(...daily.map((r) => r.limit)), `${tier} daily`).toBeGreaterThan(0);
    }
  });
});
