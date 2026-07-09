import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// App Blocks review SERVICE — upsert gates + concurrency + cache bust.
//
// Pins (money + correctness):
//   - create vs update: isFirstReview ONLY on create (drives the once-per
//     reward); update returns false.
//   - CONCURRENCY: a first-review create that loses the unique race (P2002)
//     falls back to update with isFirstReview=false → graceful, NO second
//     reward, NO 500.
//   - GATES: rating range; NO self-review (app owner rejected); NOT-installed
//     rejected; one-per-user via the unique (we read existing → update branch).
//   - cache bust fires on upsert / setExcluded (the global-mean tag only — the
//     visible per-app aggregates are uncached, so there is no per-app tag).
// ---------------------------------------------------------------------------

import { Prisma } from '@prisma/client';

const { mockDb, mockBust } = vi.hoisted(() => ({
  mockDb: {
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    blockUserSubscription: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    appBlockReview: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      delete: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
  },
  mockBust: vi.fn(async () => undefined),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));

vi.mock('~/server/utils/cache-helpers', () => ({
  bustCacheTag: (...args: unknown[]) => mockBust(...args),
}));

import {
  bustAppRatingCache,
  setAppReviewExcluded,
  upsertAppBlockReview,
} from '~/server/services/appBlockReview.service';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: app owned by user 99, viewer installed.
  mockDb.appBlock.findUnique.mockResolvedValue({ app: { userId: 99 } });
  mockDb.blockUserSubscription.findFirst.mockResolvedValue({ id: 'bus_1' });
  mockDb.appBlockReview.findUnique.mockResolvedValue(null);
  mockDb.appBlockReview.create.mockResolvedValue({
    id: 1,
    appBlockId: 'ab_1',
    rating: 5,
    recommended: true,
  });
  mockDb.appBlockReview.update.mockResolvedValue({
    id: 1,
    appBlockId: 'ab_1',
    rating: 4,
    recommended: true,
  });
});

describe('upsertAppBlockReview — create vs update', () => {
  it('CREATE branch returns isFirstReview=true and inserts', async () => {
    const res = await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });
    expect(res.isFirstReview).toBe(true);
    expect(mockDb.appBlockReview.create).toHaveBeenCalledTimes(1);
    expect(mockDb.appBlockReview.update).not.toHaveBeenCalled();
  });

  it('UPDATE branch returns isFirstReview=false (no second-award) and updates', async () => {
    mockDb.appBlockReview.findUnique.mockResolvedValue({ id: 1 });
    const res = await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 4 });
    expect(res.isFirstReview).toBe(false);
    expect(mockDb.appBlockReview.update).toHaveBeenCalledTimes(1);
    expect(mockDb.appBlockReview.create).not.toHaveBeenCalled();
  });

  it('busts the global-mean cache on upsert (no per-app tag — aggregates are uncached)', async () => {
    await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });
    expect(mockBust).toHaveBeenCalledTimes(1);
    const tags = mockBust.mock.calls[0][0] as string[];
    expect(tags).toEqual(['app-rating:global-mean']);
  });
});

describe('upsertAppBlockReview — recommended default/preserve (FIX 2)', () => {
  it('CREATE defaults recommended to true when omitted', async () => {
    mockDb.appBlockReview.findUnique.mockResolvedValue(null);
    await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });
    const data = (mockDb.appBlockReview.create.mock.calls[0][0] as { data: any }).data;
    expect(data.recommended).toBe(true);
  });

  it('CREATE honors an explicit recommended=false', async () => {
    mockDb.appBlockReview.findUnique.mockResolvedValue(null);
    await upsertAppBlockReview({
      userId: 7,
      appBlockId: 'ab_1',
      rating: 5,
      recommended: false,
    });
    const data = (mockDb.appBlockReview.create.mock.calls[0][0] as { data: any }).data;
    expect(data.recommended).toBe(false);
  });

  it('UPDATE that OMITS recommended does NOT write it (preserves a stored false)', async () => {
    mockDb.appBlockReview.findUnique.mockResolvedValue({ id: 1 });
    await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 4 });
    const data = (mockDb.appBlockReview.update.mock.calls[0][0] as { data: any }).data;
    // The bug: a default `recommended = true` would flip an existing false back
    // to true. The field must be ABSENT from the update payload when omitted.
    expect('recommended' in data).toBe(false);
    expect(data).toMatchObject({ rating: 4 });
  });

  it('UPDATE that PROVIDES recommended writes it explicitly', async () => {
    mockDb.appBlockReview.findUnique.mockResolvedValue({ id: 1 });
    await upsertAppBlockReview({
      userId: 7,
      appBlockId: 'ab_1',
      rating: 4,
      recommended: false,
    });
    const data = (mockDb.appBlockReview.update.mock.calls[0][0] as { data: any }).data;
    expect(data.recommended).toBe(false);
  });

  it('P2002-fallback UPDATE also preserves recommended when omitted', async () => {
    mockDb.appBlockReview.findUnique.mockResolvedValue(null);
    mockDb.appBlockReview.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });
    const data = (mockDb.appBlockReview.update.mock.calls[0][0] as { data: any }).data;
    expect('recommended' in data).toBe(false);
  });
});

describe('upsertAppBlockReview — concurrent first-review race (P2002 → update)', () => {
  it('a CREATE that loses the unique race falls back to UPDATE with isFirstReview=false (no 2nd reward, no 500)', async () => {
    // Both racers read null (findUnique) → both reach create. This racer LOSES:
    // the unique index throws P2002. The service must catch it, update instead,
    // and report isFirstReview=false so the reward fires ONLY for the winner.
    mockDb.appBlockReview.findUnique.mockResolvedValue(null);
    mockDb.appBlockReview.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    mockDb.appBlockReview.update.mockResolvedValue({
      id: 1,
      appBlockId: 'ab_1',
      rating: 5,
      recommended: true,
    });

    const res = await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });

    // Graceful: no throw, falls through to update.
    expect(res.isFirstReview).toBe(false); // ← NO second reward for the loser.
    expect(mockDb.appBlockReview.create).toHaveBeenCalledTimes(1); // attempted, lost.
    expect(mockDb.appBlockReview.update).toHaveBeenCalledTimes(1); // fallback ran.
    // The fallback update keys on the unique (appBlockId, userId), not a stale id.
    const updateArg = mockDb.appBlockReview.update.mock.calls[0][0] as { where: unknown };
    expect(updateArg.where).toEqual({ appBlockId_userId: { appBlockId: 'ab_1', userId: 7 } });
  });

  it('rethrows a NON-P2002 create error (does not silently swallow real failures)', async () => {
    mockDb.appBlockReview.findUnique.mockResolvedValue(null);
    mockDb.appBlockReview.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('connection lost', {
        code: 'P1001',
        clientVersion: 'test',
      })
    );
    await expect(
      upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 })
    ).rejects.toThrow();
    expect(mockDb.appBlockReview.update).not.toHaveBeenCalled();
  });
});

describe('upsertAppBlockReview — anti-abuse gates', () => {
  it('rejects an out-of-range rating (0 / 6 / non-integer)', async () => {
    for (const bad of [0, 6, 3.5]) {
      await expect(
        upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: bad })
      ).rejects.toThrow();
    }
    expect(mockDb.appBlockReview.create).not.toHaveBeenCalled();
  });

  it('rejects a SELF-REVIEW (the app owner reviewing their own app)', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue({ app: { userId: 7 } }); // owner == viewer
    await expect(
      upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 })
    ).rejects.toThrow(/your own app/i);
    expect(mockDb.appBlockReview.create).not.toHaveBeenCalled();
  });

  it('rejects when the viewer has NOT installed (no enabled subscription)', async () => {
    mockDb.blockUserSubscription.findFirst.mockResolvedValue(null);
    await expect(
      upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 })
    ).rejects.toThrow(/install/i);
    expect(mockDb.appBlockReview.create).not.toHaveBeenCalled();
  });

  it('only counts an ENABLED install (findFirst is scoped to enabled=true)', async () => {
    await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });
    const where = (mockDb.blockUserSubscription.findFirst.mock.calls[0][0] as { where: any }).where;
    expect(where).toMatchObject({ appBlockId: 'ab_1', userId: 7, enabled: true });
  });

  it('rejects for a missing app block', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue(null);
    await expect(
      upsertAppBlockReview({ userId: 7, appBlockId: 'ab_missing', rating: 5 })
    ).rejects.toThrow();
  });
});

describe('setAppReviewExcluded — mod control busts the cache', () => {
  it('flips exclude + busts the global-mean cache', async () => {
    mockDb.appBlockReview.update.mockResolvedValue({ id: 5, appBlockId: 'ab_9', exclude: true });
    const res = await setAppReviewExcluded({ id: 5, exclude: true });
    expect(res).toEqual({ id: 5, appBlockId: 'ab_9', exclude: true });
    expect(mockBust).toHaveBeenCalledTimes(1);
    expect(mockBust.mock.calls[0][0]).toEqual(['app-rating:global-mean']);
  });
});

describe('bustAppRatingCache', () => {
  it('busts the global-mean tag only (per-app aggregates are uncached)', async () => {
    await bustAppRatingCache();
    expect(mockBust).toHaveBeenCalledWith(['app-rating:global-mean']);
  });
});
