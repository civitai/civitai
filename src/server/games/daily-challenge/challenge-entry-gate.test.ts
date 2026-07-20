import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindFirst } = vi.hoisted(() => ({ mockFindFirst: vi.fn() }));
vi.mock('~/server/db/client', () => ({ dbRead: { challenge: { findFirst: mockFindFirst } } }));

const { assertUserChallengeAcceptingEntries } = await import('./challenge-entry-gate');

beforeEach(() => vi.clearAllMocks());

describe('assertUserChallengeAcceptingEntries', () => {
  it('rejects when the owning user challenge is Scheduled', async () => {
    mockFindFirst.mockResolvedValue({ status: 'Scheduled' });
    await expect(assertUserChallengeAcceptingEntries(55)).rejects.toThrow('starting shortly');
  });

  it('rejects for any non-Active status (e.g. Completing)', async () => {
    mockFindFirst.mockResolvedValue({ status: 'Completing' });
    await expect(assertUserChallengeAcceptingEntries(55)).rejects.toThrow('starting shortly');
  });

  it('accepts when the owning user challenge is Active', async () => {
    mockFindFirst.mockResolvedValue({ status: 'Active' });
    await expect(assertUserChallengeAcceptingEntries(55)).resolves.toBeUndefined();
  });

  it('no-ops when no user challenge owns the collection (daily/community contest)', async () => {
    mockFindFirst.mockResolvedValue(null);
    await expect(assertUserChallengeAcceptingEntries(55)).resolves.toBeUndefined();
  });

  it('scopes the lookup to source = User and selects only status', async () => {
    mockFindFirst.mockResolvedValue(null);
    await assertUserChallengeAcceptingEntries(55);
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { collectionId: 55, source: 'User' },
      select: { status: true },
    });
  });
});
