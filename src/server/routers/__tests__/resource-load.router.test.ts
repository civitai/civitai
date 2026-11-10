import { describe, expect, it } from 'vitest';
import type { SessionUser } from '~/types/session';
import {
  assertCanRequestLoad,
  resourceLoadRateLimits,
} from '~/server/routers/resource-load.router';
import { resolveUsageLimitRules } from '~/server/services/usage-limit-config.service';
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
 * Every tier gets a limit in both windows: the daily entitlement and the cluster's flat hourly cap,
 * which no plan buys its way out of.
 */
describe('resourceLoadRateLimits', () => {
  const rulesFor = (tier: string) =>
    resolveUsageLimitRules(resourceLoadRateLimits.usageLimitIds, user({ tier } as never));
  const limitIn = async (tier: string, period: number) =>
    (await rulesFor(tier)).filter((r) => r.period === period).map((r) => r.limit);

  it.each([...userTiers])(
    'a %s user has one hourly limit of 3 and one daily limit',
    async (tier) => {
      expect(await limitIn(tier, CacheTTL.hour)).toEqual([3]);
      expect(await limitIn(tier, CacheTTL.day)).toHaveLength(1);
    }
  );

  it('refuses a free account outright on the daily window', async () => {
    expect(await limitIn('free', CacheTTL.day)).toEqual([0]);
  });

  it('gives paying tiers a daily allowance above zero', async () => {
    for (const tier of ['bronze', 'silver', 'gold', 'founder'] as const) {
      const [daily] = await limitIn(tier, CacheTTL.day);
      expect(daily, `${tier} daily`).toBeGreaterThan(0);
    }
  });
});
