import { describe, it, expect } from 'vitest';
import { reviveMultipliersSeed } from '~/providers/multipliers-seed';

// A realistic SSR-serialized multipliers payload with NO active bonus event —
// the common case. All fields are numbers/booleans/null, so JSON and superjson
// agree byte-for-byte and there is nothing to revive.
const noEvent = {
  userId: 42,
  purchasesMultiplier: 1,
  rewardsMultiplier: 1,
  baseRewardsMultiplier: 1,
  globalRewardsBonus: 1,
  rewardsIneligible: false,
  rewardsBonusEvent: null,
};

// With an active event, the nested `startsAt`/`endsAt` arrive as ISO strings via
// Next pageProps (JSON.stringify) — a live superjson tRPC fetch revives them to
// Date objects, so the seed must be revived to match that shape.
const withEvent = {
  userId: 42,
  purchasesMultiplier: 1,
  rewardsMultiplier: 2,
  baseRewardsMultiplier: 1,
  globalRewardsBonus: 2,
  rewardsIneligible: false,
  rewardsBonusEvent: {
    id: 7,
    name: 'Double Rewards',
    description: 'twice the buzz',
    articleId: 99,
    bannerLabel: '2x',
    multiplier: 20,
    startsAt: '2026-06-02T00:00:00.000Z',
    endsAt: '2026-06-10T00:00:00.000Z',
  },
};

describe('reviveMultipliersSeed', () => {
  it('returns undefined for an undefined seed (so the query self-heals via a live fetch)', () => {
    expect(reviveMultipliersSeed(undefined)).toBeUndefined();
  });

  it('passes a no-active-event payload through untouched (rewardsBonusEvent null)', () => {
    const revived = reviveMultipliersSeed(noEvent as never)!;
    expect(revived).toEqual(noEvent);
    expect(revived.rewardsBonusEvent).toBeNull();
  });

  it('revives the active-event ISO-string date fields into Date objects', () => {
    const revived = reviveMultipliersSeed(withEvent as never)!;
    const event = revived.rewardsBonusEvent!;
    expect(event.startsAt).toBeInstanceOf(Date);
    expect(event.endsAt).toBeInstanceOf(Date);
    expect((event.startsAt as Date).toISOString()).toBe('2026-06-02T00:00:00.000Z');
    expect((event.endsAt as Date).toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });

  it('preserves null startsAt/endsAt as null (event with no bounded window)', () => {
    const revived = reviveMultipliersSeed({
      ...withEvent,
      rewardsBonusEvent: { ...withEvent.rewardsBonusEvent, startsAt: null, endsAt: null },
    } as never)!;
    const event = revived.rewardsBonusEvent!;
    expect(event.startsAt).toBeNull();
    expect(event.endsAt).toBeNull();
  });

  it('passes the non-date event fields and top-level multipliers through untouched', () => {
    const revived = reviveMultipliersSeed(withEvent as never)!;
    expect(revived.userId).toBe(42);
    expect(revived.rewardsMultiplier).toBe(2);
    expect(revived.globalRewardsBonus).toBe(2);
    expect(revived.rewardsIneligible).toBe(false);
    const event = revived.rewardsBonusEvent!;
    expect(event.id).toBe(7);
    expect(event.name).toBe('Double Rewards');
    expect(event.description).toBe('twice the buzz');
    expect(event.articleId).toBe(99);
    expect(event.bannerLabel).toBe('2x');
    expect(event.multiplier).toBe(20);
  });

  it('is idempotent on values that already hold Date objects (a live refetch shape)', () => {
    const live = {
      ...withEvent,
      rewardsBonusEvent: {
        ...withEvent.rewardsBonusEvent,
        startsAt: new Date('2026-06-02T00:00:00.000Z'),
        endsAt: new Date('2026-06-10T00:00:00.000Z'),
      },
    };
    const revived = reviveMultipliersSeed(live as never)!;
    const event = revived.rewardsBonusEvent!;
    expect(event.startsAt).toBeInstanceOf(Date);
    expect((event.startsAt as Date).toISOString()).toBe('2026-06-02T00:00:00.000Z');
    expect((event.endsAt as Date).toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });
});
