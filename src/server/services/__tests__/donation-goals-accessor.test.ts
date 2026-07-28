import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Read-time public filters for `getDonationGoals`. The cache holds only the raw active goal + total
 * (see model-version-public-donation-goals-cache.test.ts); the display filters are applied here so
 * they stay fresh rather than being baked into a short-TTL cache:
 *   - the early-access window (from PaidAccess): a goal shows only while a live TIMED gate is open;
 *   - the creator opt-out (hideDonationGoals): effective only while the owner holds a valid CP
 *     membership, so a lapse silently re-reveals the goal.
 * A non-existent version is OMITTED (so the endpoint can 404); an existing version with no visible
 * goal is `null`.
 */

const { mockCacheFetch, mockGetPaidAccess, mockUserFindMany, mockMembership } = vi.hoisted(() => ({
  mockCacheFetch: vi.fn(),
  mockGetPaidAccess: vi.fn(),
  mockUserFindMany: vi.fn(),
  mockMembership: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { user: { findMany: mockUserFindMany } },
  dbWrite: {},
}));
vi.mock('~/server/redis/caches', () => ({
  modelVersionPublicDonationGoalsCache: { fetch: mockCacheFetch, bust: vi.fn() },
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: mockGetPaidAccess,
  bustPaidAccessCache: vi.fn(),
}));
vi.mock('~/server/services/creator-membership.service', () => ({
  getValidCreatorMembershipMap: mockMembership,
}));
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

import { getDonationGoals } from '~/server/services/donation-goal.service';

const goal = (over: Record<string, unknown> = {}) => ({
  id: 10,
  goalAmount: 1000,
  title: 'Goal',
  active: true,
  userId: 7,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  description: 'desc',
  total: 250,
  ...over,
});
const entry = (goalVal: ReturnType<typeof goal> | null) => ({ modelVersionId: 5, goal: goalVal });
const gate = (endsAt: Date | null = new Date('2099-01-01T00:00:00.000Z')) => ({
  entityType: 'ModelVersion' as const,
  entityId: 5,
  ownerId: 7,
  endsAt,
  terms: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUserFindMany.mockResolvedValue([]);
  mockMembership.mockResolvedValue(new Map());
});

describe('getDonationGoals — early-access window', () => {
  it('shows the goal while a timed gate is active', async () => {
    mockCacheFetch.mockResolvedValue({ 5: entry(goal()) });
    mockGetPaidAccess.mockResolvedValue({ 5: gate() });
    const res = await getDonationGoals('ModelVersion', [5]);
    expect(res[5]?.id).toBe(10);
  });

  it('hides the goal once the timed window has ended', async () => {
    mockCacheFetch.mockResolvedValue({ 5: entry(goal()) });
    mockGetPaidAccess.mockResolvedValue({ 5: gate(new Date('2000-01-01T00:00:00.000Z')) });
    const res = await getDonationGoals('ModelVersion', [5]);
    expect(res[5]).toBeNull();
  });

  it('hides the goal for a permanent gate (no timed window)', async () => {
    mockCacheFetch.mockResolvedValue({ 5: entry(goal()) });
    mockGetPaidAccess.mockResolvedValue({ 5: gate(null) });
    const res = await getDonationGoals('ModelVersion', [5]);
    expect(res[5]).toBeNull();
  });

  it('hides the goal when the entity has no gate at all', async () => {
    mockCacheFetch.mockResolvedValue({ 5: entry(goal()) });
    mockGetPaidAccess.mockResolvedValue({});
    const res = await getDonationGoals('ModelVersion', [5]);
    expect(res[5]).toBeNull();
  });
});

describe('getDonationGoals — creator opt-out', () => {
  it('hides an opted-out owner’s goal ONLY while they hold a valid CP membership', async () => {
    mockCacheFetch.mockResolvedValue({ 5: entry(goal({ userId: 7 })) });
    mockGetPaidAccess.mockResolvedValue({ 5: gate() });
    mockUserFindMany.mockResolvedValue([{ id: 7, settings: { hideDonationGoals: true } }]);
    mockMembership.mockResolvedValue(new Map([[7, true]]));
    const res = await getDonationGoals('ModelVersion', [5]);
    expect(res[5]).toBeNull();
  });

  it('shows the goal again once the owner’s CP membership lapses (no stored flip)', async () => {
    mockCacheFetch.mockResolvedValue({ 5: entry(goal({ userId: 7 })) });
    mockGetPaidAccess.mockResolvedValue({ 5: gate() });
    mockUserFindMany.mockResolvedValue([{ id: 7, settings: { hideDonationGoals: true } }]);
    mockMembership.mockResolvedValue(new Map()); // lapsed / never a member
    const res = await getDonationGoals('ModelVersion', [5]);
    expect(res[5]?.id).toBe(10);
  });
});

describe('getDonationGoals — existence + entity type', () => {
  it('omits a non-existent version (no cache entry) so the caller can 404', async () => {
    mockCacheFetch.mockResolvedValue({});
    mockGetPaidAccess.mockResolvedValue({});
    const res = await getDonationGoals('ModelVersion', [999]);
    expect(999 in res).toBe(false);
  });

  it('returns null (not omitted) for an existing version with no goal', async () => {
    mockCacheFetch.mockResolvedValue({ 5: entry(null) });
    mockGetPaidAccess.mockResolvedValue({ 5: gate() });
    const res = await getDonationGoals('ModelVersion', [5]);
    expect(5 in res).toBe(true);
    expect(res[5]).toBeNull();
  });

  it('short-circuits to {} for a non-ModelVersion entity type', async () => {
    const res = await getDonationGoals('ComicChapter', [5]);
    expect(res).toEqual({});
    expect(mockCacheFetch).not.toHaveBeenCalled();
  });
});
