import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserPreferences from '~/server/services/user-preferences.service';

// `amIBlockedByUser` runs on every logged-in detail view. Page views answer from the
// `BlockedByUsers` cache alone. Write gates (comment and reaction via throwIfBlockedByOwners,
// tip, challenge entry, the prompt-provenance mint) pass `confirmOnPrimary`, which confirms a
// cache "not blocked" against the primary.

const { getCached } = vi.hoisted(() => ({
  getCached: vi.fn(async (..._a: unknown[]): Promise<{ id: number; username: string }[]> => []),
}));

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => {
  const actual = await importOriginal<typeof UserPreferences>();
  return {
    ...actual,
    BlockedByUsers: { ...actual.BlockedByUsers, getCached },
  };
});

import { amIBlockedByUser } from '~/server/services/user.service';
import { throwIfBlockedByOwners } from '~/server/services/block-check.service';
import { assertImageVisibleToViewer } from '~/server/services/image-visibility.service';

const VIEWER = 101;
const BLOCKER = 202;
const OTHER = 303;

beforeEach(() => {
  vi.clearAllMocks();
  getCached.mockResolvedValue([]);
  // If a cache-only path still queried the table, either client would say "blocked",
  // so a `false` from a cache-only call can only come from the cache.
  const blockRow = { userId: BLOCKER, targetUserId: VIEWER, type: 'Block' as const };
  dbMock.dbRead.userEngagement.findFirst.mockResolvedValue(blockRow);
  dbMock.dbWrite.userEngagement.findFirst.mockResolvedValue(blockRow);
});

describe('amIBlockedByUser', () => {
  it('returns true when the target is in the viewer’s cached blocked-by list', async () => {
    getCached.mockResolvedValue([{ id: BLOCKER, username: 'blocker' }]);

    await expect(amIBlockedByUser({ userId: VIEWER, targetUserId: BLOCKER })).resolves.toBe(true);
    expect(getCached).toHaveBeenCalledWith({ userId: VIEWER });
  });

  it('returns false for a pair not in the cache, without querying userEngagement', async () => {
    getCached.mockResolvedValue([{ id: OTHER, username: 'other' }]);

    await expect(amIBlockedByUser({ userId: VIEWER, targetUserId: BLOCKER })).resolves.toBe(false);
    expect(dbMock.dbRead.userEngagement.findFirst).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.userEngagement.findFirst).not.toHaveBeenCalled();
  });

  it('never reports a user as blocked by themselves, even if the cache lists them', async () => {
    getCached.mockResolvedValue([{ id: VIEWER, username: 'viewer' }]);

    await expect(amIBlockedByUser({ userId: VIEWER, targetUserId: VIEWER })).resolves.toBe(false);
  });

  it('returns false with no target', async () => {
    await expect(amIBlockedByUser({ userId: VIEWER })).resolves.toBe(false);
    expect(getCached).not.toHaveBeenCalled();
  });
});

describe('amIBlockedByUser — confirmOnPrimary (interaction gates)', () => {
  it('returns true when the primary has a Block the cache lacks', async () => {
    dbMock.dbRead.userEngagement.findFirst.mockResolvedValue(null);

    await expect(
      amIBlockedByUser({ userId: VIEWER, targetUserId: BLOCKER, confirmOnPrimary: true })
    ).resolves.toBe(true);
    expect(dbMock.dbWrite.userEngagement.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: BLOCKER, targetUserId: VIEWER, type: 'Block' },
      })
    );
    expect(dbMock.dbRead.userEngagement.findFirst).not.toHaveBeenCalled();
  });

  it('returns false when neither the cache nor the primary has a Block', async () => {
    dbMock.dbWrite.userEngagement.findFirst.mockResolvedValueOnce(null);

    await expect(
      amIBlockedByUser({ userId: VIEWER, targetUserId: BLOCKER, confirmOnPrimary: true })
    ).resolves.toBe(false);
  });

  it('does not query when the cache already says blocked', async () => {
    getCached.mockResolvedValue([{ id: BLOCKER, username: 'blocker' }]);

    await expect(
      amIBlockedByUser({ userId: VIEWER, targetUserId: BLOCKER, confirmOnPrimary: true })
    ).resolves.toBe(true);
    expect(dbMock.dbWrite.userEngagement.findFirst).not.toHaveBeenCalled();
  });

  it('never queries for a self pair', async () => {
    await expect(
      amIBlockedByUser({ userId: VIEWER, targetUserId: VIEWER, confirmOnPrimary: true })
    ).resolves.toBe(false);
    expect(dbMock.dbWrite.userEngagement.findFirst).not.toHaveBeenCalled();
  });
});

describe('throwIfBlockedByOwners — a comment/reaction gate', () => {
  it('denies when the primary has a Block the cache lacks', async () => {
    // Differential: the replica has no row, so only a primary read can deny.
    dbMock.dbRead.userEngagement.findFirst.mockResolvedValue(null);

    await expect(
      throwIfBlockedByOwners({ userId: VIEWER, ownerIds: [BLOCKER] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('allows when neither the cache nor the primary has a Block', async () => {
    dbMock.dbWrite.userEngagement.findFirst.mockResolvedValueOnce(null);

    await expect(
      throwIfBlockedByOwners({ userId: VIEWER, ownerIds: [BLOCKER] })
    ).resolves.toBeUndefined();
  });

  it('denies from the cache without querying the primary', async () => {
    getCached.mockResolvedValue([{ id: BLOCKER, username: 'blocker' }]);

    await expect(
      throwIfBlockedByOwners({ userId: VIEWER, ownerIds: [BLOCKER] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(dbMock.dbWrite.userEngagement.findFirst).not.toHaveBeenCalled();
  });
});

describe('assertImageVisibleToViewer — the prompt-provenance mint gate', () => {
  const IMAGE = { id: 9, userId: BLOCKER, nsfwLevel: 1, postId: null };

  beforeEach(() => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([IMAGE]);
    // Differential: only the primary has the Block.
    dbMock.dbRead.userEngagement.findFirst.mockResolvedValue(null);
  });

  it('refuses the mint when only the primary has the Block', async () => {
    await expect(
      assertImageVisibleToViewer({ id: IMAGE.id, userId: VIEWER, confirmBlockOnPrimary: true })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps read callers cache-only: no primary lookup', async () => {
    await expect(assertImageVisibleToViewer({ id: IMAGE.id, userId: VIEWER })).resolves.toEqual(
      IMAGE
    );
    expect(dbMock.dbWrite.userEngagement.findFirst).not.toHaveBeenCalled();
  });
});
