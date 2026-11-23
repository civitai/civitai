import { describe, expect, it } from 'vitest';
import { memberLimitNote, planLimitText } from '~/components/Account/usage/usage-limit-tiers';
import type { UsageLimitTierEntry } from '~/server/services/usage-limit-config.service';

const tiers = (free: number, paid: [number, number, number], multiplier?: number) => ({
  free: { limit: free },
  founder: { limit: paid[0], multiplier },
  bronze: { limit: paid[0], multiplier },
  silver: { limit: paid[1], multiplier },
  gold: { limit: paid[2], multiplier },
});
const posts: UsageLimitTierEntry = {
  id: 'posts.daily',
  area: 'posts',
  label: 'Posts per day',
  tiers: tiers(10, [20, 20, 20], 2),
};
const gifts: UsageLimitTierEntry = {
  id: 'gifts.monthly',
  area: 'gifts',
  label: 'Gift claims of your links per month',
  tiers: tiers(3, [15, 30, 60]),
};

describe('planLimitText', () => {
  it('names a multiplier as Nx and a fixed limit as its number', () => {
    expect(planLimitText(posts, 'gold')).toBe('2x posts per day');
    expect(planLimitText(gifts, 'silver')).toBe('30 gift claims of your links per month');
  });
  it('adds no line to a plan that does not raise the limit', () => {
    expect(planLimitText(gifts, 'free')).toBeNull();
  });
});

describe('memberLimitNote', () => {
  it('tells a free account what membership raises the limit to', () => {
    expect(memberLimitNote(posts, 'free')).toBe('Members get 2x');
    expect(memberLimitNote(gifts, undefined)).toBe('Members get 15 to 60');
    expect(memberLimitNote({ ...gifts, tiers: tiers(3, [15, 15, 15]) }, 'free')).toBe(
      'Members get 15'
    );
  });
  it('says nothing to a member', () => {
    expect(memberLimitNote(gifts, 'bronze')).toBeNull();
  });
});
