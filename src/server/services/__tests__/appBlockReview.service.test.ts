import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

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

const { mockBust } = vi.hoisted(() => ({
  mockBust: vi.fn(async () => undefined),
}));

// One local served both clients. Resolved by the three entry points this file imports:
// `upsertAppBlockReview` (:120) writes `appBlockReview` on dbWrite (:157, :179, :186, :197) and
// reads through gates on dbRead — `appBlock.findUnique` (:49), `blockUserSubscription.findFirst`
// (:81); `setAppReviewExcluded` (:287) writes on dbWrite (:294); `bustAppRatingCache` (:39)
// touches no client at all.
//
// ⚠️ The parameterised-client analysis records `appBlockReview.findUnique` as appearing on BOTH
// clients inside `upsertAppBlockReview`. It does not — the dbRead spelling at :264 belongs to
// `getMyAppBlockReview`, which this file never imports. `BOTH` off a whole-module scan again.
//
// `appCollaborator` is dbRead, via the deferred import in `getAppInsiderUserIds` (:74-77) →
// `app-access.service:1111`. `safeCollaboratorQuery` swallows only the missing-TABLE error, so an
// undeclared node would surface as a TypeError rather than be absorbed; the canonical `findMany`
// default is `[]`, which is what this fixture declared.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

mockDbWrite.appBlockReview.create.mockResolvedValue({});
mockDbWrite.appBlockReview.update.mockResolvedValue({});
mockDbWrite.appBlockReview.delete.mockResolvedValue({});

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
  mockDbRead.appBlock.findUnique.mockResolvedValue({ app: { userId: 99 } });
  mockDbRead.blockUserSubscription.findFirst.mockResolvedValue({ id: 'bus_1' });
  mockDbWrite.appBlockReview.findUnique.mockResolvedValue(null);
  mockDbWrite.appBlockReview.create.mockResolvedValue({
    id: 1,
    appBlockId: 'ab_1',
    rating: 5,
    recommended: true,
  });
  mockDbWrite.appBlockReview.update.mockResolvedValue({
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
    expect(mockDbWrite.appBlockReview.create).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.appBlockReview.update).not.toHaveBeenCalled();
  });

  it('UPDATE branch returns isFirstReview=false (no second-award) and updates', async () => {
    mockDbWrite.appBlockReview.findUnique.mockResolvedValue({ id: 1 });
    const res = await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 4 });
    expect(res.isFirstReview).toBe(false);
    expect(mockDbWrite.appBlockReview.update).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.appBlockReview.create).not.toHaveBeenCalled();
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
    mockDbWrite.appBlockReview.findUnique.mockResolvedValue(null);
    await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });
    const data = (mockDbWrite.appBlockReview.create.mock.calls[0][0] as { data: any }).data;
    expect(data.recommended).toBe(true);
  });

  it('CREATE honors an explicit recommended=false', async () => {
    mockDbWrite.appBlockReview.findUnique.mockResolvedValue(null);
    await upsertAppBlockReview({
      userId: 7,
      appBlockId: 'ab_1',
      rating: 5,
      recommended: false,
    });
    const data = (mockDbWrite.appBlockReview.create.mock.calls[0][0] as { data: any }).data;
    expect(data.recommended).toBe(false);
  });

  it('UPDATE that OMITS recommended does NOT write it (preserves a stored false)', async () => {
    mockDbWrite.appBlockReview.findUnique.mockResolvedValue({ id: 1 });
    await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 4 });
    const data = (mockDbWrite.appBlockReview.update.mock.calls[0][0] as { data: any }).data;
    // The bug: a default `recommended = true` would flip an existing false back
    // to true. The field must be ABSENT from the update payload when omitted.
    expect('recommended' in data).toBe(false);
    expect(data).toMatchObject({ rating: 4 });
  });

  it('UPDATE that PROVIDES recommended writes it explicitly', async () => {
    mockDbWrite.appBlockReview.findUnique.mockResolvedValue({ id: 1 });
    await upsertAppBlockReview({
      userId: 7,
      appBlockId: 'ab_1',
      rating: 4,
      recommended: false,
    });
    const data = (mockDbWrite.appBlockReview.update.mock.calls[0][0] as { data: any }).data;
    expect(data.recommended).toBe(false);
  });

  it('P2002-fallback UPDATE also preserves recommended when omitted', async () => {
    mockDbWrite.appBlockReview.findUnique.mockResolvedValue(null);
    mockDbWrite.appBlockReview.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });
    const data = (mockDbWrite.appBlockReview.update.mock.calls[0][0] as { data: any }).data;
    expect('recommended' in data).toBe(false);
  });
});

describe('upsertAppBlockReview — concurrent first-review race (P2002 → update)', () => {
  it('a CREATE that loses the unique race falls back to UPDATE with isFirstReview=false (no 2nd reward, no 500)', async () => {
    // Both racers read null (findUnique) → both reach create. This racer LOSES:
    // the unique index throws P2002. The service must catch it, update instead,
    // and report isFirstReview=false so the reward fires ONLY for the winner.
    mockDbWrite.appBlockReview.findUnique.mockResolvedValue(null);
    mockDbWrite.appBlockReview.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    mockDbWrite.appBlockReview.update.mockResolvedValue({
      id: 1,
      appBlockId: 'ab_1',
      rating: 5,
      recommended: true,
    });

    const res = await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });

    // Graceful: no throw, falls through to update.
    expect(res.isFirstReview).toBe(false); // ← NO second reward for the loser.
    expect(mockDbWrite.appBlockReview.create).toHaveBeenCalledTimes(1); // attempted, lost.
    expect(mockDbWrite.appBlockReview.update).toHaveBeenCalledTimes(1); // fallback ran.
    // The fallback update keys on the unique (appBlockId, userId), not a stale id.
    const updateArg = mockDbWrite.appBlockReview.update.mock.calls[0][0] as { where: unknown };
    expect(updateArg.where).toEqual({ appBlockId_userId: { appBlockId: 'ab_1', userId: 7 } });
  });

  it('rethrows a NON-P2002 create error (does not silently swallow real failures)', async () => {
    mockDbWrite.appBlockReview.findUnique.mockResolvedValue(null);
    mockDbWrite.appBlockReview.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('connection lost', {
        code: 'P1001',
        clientVersion: 'test',
      })
    );
    await expect(
      upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 })
    ).rejects.toThrow();
    expect(mockDbWrite.appBlockReview.update).not.toHaveBeenCalled();
  });
});

describe('upsertAppBlockReview — anti-abuse gates', () => {
  it('rejects an out-of-range rating (0 / 6 / non-integer)', async () => {
    for (const bad of [0, 6, 3.5]) {
      await expect(
        upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: bad })
      ).rejects.toThrow();
    }
    expect(mockDbWrite.appBlockReview.create).not.toHaveBeenCalled();
  });

  it('rejects a SELF-REVIEW (the app owner reviewing their own app)', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValue({ app: { userId: 7 } }); // owner == viewer
    await expect(
      upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 })
    ).rejects.toThrow(/your own app/i);
    expect(mockDbWrite.appBlockReview.create).not.toHaveBeenCalled();
  });

  it('rejects when the viewer has NOT installed (no enabled subscription)', async () => {
    mockDbRead.blockUserSubscription.findFirst.mockResolvedValue(null);
    await expect(
      upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 })
    ).rejects.toThrow(/install/i);
    expect(mockDbWrite.appBlockReview.create).not.toHaveBeenCalled();
  });

  it('only counts an ENABLED install (findFirst is scoped to enabled=true)', async () => {
    await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });
    const where = (mockDbRead.blockUserSubscription.findFirst.mock.calls[0][0] as { where: any })
      .where;
    expect(where).toMatchObject({ appBlockId: 'ab_1', userId: 7, enabled: true });
  });

  it('rejects for a missing app block', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    await expect(
      upsertAppBlockReview({ userId: 7, appBlockId: 'ab_missing', rating: 5 })
    ).rejects.toThrow();
  });
});

describe('setAppReviewExcluded — mod control busts the cache', () => {
  it('flips exclude + busts the global-mean cache', async () => {
    mockDbWrite.appBlockReview.update.mockResolvedValue({
      id: 5,
      appBlockId: 'ab_9',
      exclude: true,
    });
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
