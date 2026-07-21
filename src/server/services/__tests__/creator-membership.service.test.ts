import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getValidCreatorMembershipMap` is the read-time gate every metric-privacy surface
 * (model feed / v1 API / search index) and the donation-goal hide check trusts: a
 * user is a valid Creator Program member only while they hold a paid, non-founder
 * tier. A regression here either leaks a lapsed creator's hidden metrics (false→true)
 * or wrongly hides an active member's stats (true→false).
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: { customerSubscription: { findMany: vi.fn() } },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead }));

import { getValidCreatorMembershipMap } from '~/server/services/creator-membership.service';

type SubRow = {
  userId: number;
  metadata?: Record<string, unknown> | null;
  product: { metadata: Record<string, unknown> };
};

const sub = (userId: number, tier: string, over: Partial<SubRow> = {}): SubRow => ({
  userId,
  metadata: null,
  product: { metadata: { tier } },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getValidCreatorMembershipMap', () => {
  it('returns an empty map (and skips the db) for empty input', async () => {
    const result = await getValidCreatorMembershipMap([]);
    expect(result.size).toBe(0);
    expect(mockDbRead.customerSubscription.findMany).not.toHaveBeenCalled();
  });

  it('treats a founder-tier sub as an invalid membership', async () => {
    mockDbRead.customerSubscription.findMany.mockResolvedValue([sub(1, 'founder')]);
    const result = await getValidCreatorMembershipMap([1]);
    expect(result.get(1)).toBe(false);
  });

  it('skips a sub flagged with metadata.renewalEmailSent', async () => {
    mockDbRead.customerSubscription.findMany.mockResolvedValue([
      sub(1, 'gold', { metadata: { renewalEmailSent: true } }),
    ]);
    const result = await getValidCreatorMembershipMap([1]);
    // The only sub is skipped, so the user has no effective tier -> invalid.
    expect(result.get(1)).toBe(false);
  });

  it('selects the highest tier among multiple subs', async () => {
    mockDbRead.customerSubscription.findMany.mockResolvedValue([sub(1, 'free'), sub(1, 'silver')]);
    const result = await getValidCreatorMembershipMap([1]);
    // Picks silver over free -> valid (a free-only pick would be invalid).
    expect(result.get(1)).toBe(true);
  });
});
