import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads4 from '@civitai/db-queries/hot-reads-4';
import type * as LagHelpers from '~/server/db/db-lag-helpers';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-4 statement stubbed: their rows against Prisma's are compared in
// hot-reads-4.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-4', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads4>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// The lag decision, so a test can make it pick the primary and see both paths follow it.
const { getDbWithoutLag, getKyselyWithoutLag } = vi.hoisted(() => ({
  getDbWithoutLag: vi.fn(),
  getKyselyWithoutLag: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof LagHelpers>()),
  getDbWithoutLag,
  getKyselyWithoutLag,
}));
const { hidden, blockedBy, blocked } = vi.hoisted(() => ({
  hidden: vi.fn(async (): Promise<{ id: number }[]> => []),
  blockedBy: vi.fn(async (): Promise<{ id: number }[]> => []),
  blocked: vi.fn(async (): Promise<{ id: number }[]> => []),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenUsers: { getCached: hidden },
  BlockedByUsers: { getCached: blockedBy },
  BlockedUsers: { getCached: blocked },
}));

import * as queries from '@civitai/db-queries/hot-reads-4';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';
import { getVisibleCommentCount } from '~/server/services/comment.service';

/**
 * `comment.getVisibleCountByModel` (`getVisibleCommentCount`) behind `kysely-hot-reads-4`: which
 * client each path reads, that it follows the same lag decision, and that the viewer filter reaches
 * the Kysely statement. Row parity against a real database is in hot-reads-4.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

// Pairwise distinct, and distinct from the counts below.
const MODEL = 8101;
const VIEWER = 8202;
const HIDDEN_AUTHOR = 8303;
const BLOCKER = 8404;
const COUNT = 17;
const UNPINNED = 11;
const PINNED = 5;

const viewer = (isModerator = false) => ({ id: VIEWER, isModerator } as never);
const count = (hiddenView?: boolean, isModerator = false) =>
  getVisibleCommentCount({
    input: { modelId: MODEL, hidden: hiddenView },
    user: viewer(isModerator),
  });

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  getDbWithoutLag.mockReset().mockResolvedValue(dbMock.dbRead);
  getKyselyWithoutLag.mockReset().mockResolvedValue(kyselyRead);
  hidden.mockReset().mockResolvedValue([]);
  blockedBy.mockReset().mockResolvedValue([]);
  blocked.mockReset().mockResolvedValue([]);
  dbMock.dbRead.comment.count.mockResolvedValue(COUNT);
  dbMock.dbRead.model.findUnique.mockResolvedValue(null);
  q.countTopLevelComments.mockResolvedValue(COUNT);
});

describe('getVisibleCommentCount behind kysely-hot-reads-4', () => {
  it('control: the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });

  it('evaluates kysely-hot-reads-4 by key, with no entity or context, once per call', async () => {
    await count();
    expect(flag.mock.calls).toEqual([['kysely-hot-reads-4']]);
  });

  it('OFF: counts through Prisma only, on the client the lag decision picked', async () => {
    await expect(count()).resolves.toBe(COUNT);
    expect(getDbWithoutLag).toHaveBeenCalledWith('commentModel', MODEL);
    expect(dbMock.dbRead.comment.count).toHaveBeenCalledTimes(1);
    expect(getKyselyWithoutLag).not.toHaveBeenCalled();
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });

  it('ON: counts through Kysely only, on the replica, with the viewer filter', async () => {
    flag.mockResolvedValue(true);
    hidden.mockResolvedValue([{ id: HIDDEN_AUTHOR }]);
    await expect(count()).resolves.toBe(COUNT);
    expect(getKyselyWithoutLag).toHaveBeenCalledWith('commentModel', MODEL);
    expect(q.countTopLevelComments.mock.calls).toEqual([
      [
        kyselyRead,
        {
          modelId: MODEL,
          userId: undefined,
          excludedUserIds: [HIDDEN_AUTHOR],
          excludeTosViolations: true,
          hidden: false,
        },
        'any',
      ],
    ]);
    // By identity: `toEqual` compares the two Kysely clients structurally.
    expect(q.countTopLevelComments.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.comment.count).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comment.count).not.toHaveBeenCalled();
    expect(getDbWithoutLag).not.toHaveBeenCalled();
  });

  it('ON: follows the lag decision to the primary, as the Prisma read does', async () => {
    flag.mockResolvedValue(true);
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    await count();
    expect(q.countTopLevelComments.mock.calls[0][0]).toBe(kyselyWrite);
  });

  it('ON: the moderator hidden view reaches the statement', async () => {
    flag.mockResolvedValue(true);
    await count(true, true);
    expect(q.countTopLevelComments.mock.calls).toEqual([
      [
        kyselyRead,
        {
          modelId: MODEL,
          userId: undefined,
          excludedUserIds: [],
          excludeTosViolations: false,
          hidden: true,
        },
        'any',
      ],
    ]);
  });

  it('ON: the model owner with a blocker sums an unpinned and a pinned count, as Prisma does', async () => {
    flag.mockResolvedValue(true);
    blockedBy.mockResolvedValue([{ id: BLOCKER }]);
    dbMock.dbRead.model.findUnique.mockResolvedValue({ userId: VIEWER });
    q.countTopLevelComments.mockImplementation((async (
      _db: unknown,
      _filter: unknown,
      scope: string
    ) => (scope === 'unpinned' ? UNPINNED : scope === 'pinned' ? PINNED : COUNT)) as never);

    await expect(count()).resolves.toBe(UNPINNED + PINNED);
    const calls = q.countTopLevelComments.mock.calls.map(([db, filter, scope]) => ({
      db,
      excluded: filter.excludedUserIds,
      scope,
    }));
    // The owner sees a blocker's unpinned comments, never their pinned ones.
    expect(calls).toEqual([
      { db: kyselyRead, excluded: [], scope: 'unpinned' },
      { db: kyselyRead, excluded: [BLOCKER], scope: 'pinned' },
    ]);
    for (const call of q.countTopLevelComments.mock.calls) expect(call[0]).toBe(kyselyRead);
    expect(dbMock.dbRead.comment.count).not.toHaveBeenCalled();
  });
});
