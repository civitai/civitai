import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads4 from '@civitai/db-queries/hot-reads-4';
import type * as LagHelpers from '~/server/db/db-lag-helpers';
import type * as ReactionPrivacy from '~/server/services/reaction-privacy.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import type * as UserService from '~/server/services/user.service';
import { ReviewSort } from '~/server/common/enums';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-4 statement stubbed: their rows against Prisma's are compared in
// src/server/services/__tests__/hot-reads-4.kysely-parity.test.ts.
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
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  HiddenUsers: { getCached: hidden },
  BlockedByUsers: { getCached: blockedBy },
  BlockedUsers: { getCached: blocked },
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getCosmeticsAndProfilePicturesForUsers: vi.fn(async () => () => ({
    profilePicture: null,
    cosmetics: [],
  })),
}));
vi.mock('~/server/services/reaction-privacy.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactionPrivacy>()),
  maskHiddenReactors: vi.fn(async () => undefined),
}));

import * as queries from '@civitai/db-queries/hot-reads-4';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { getCommentsInfiniteHandler } from '~/server/controllers/comment.controller';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';

/**
 * `comment.getAll` (`getCommentsInfiniteHandler`) behind `kysely-hot-reads-4`: ON reads the first
 * page (newest or oldest first) and the pinned block through Kysely only, on the client the lag
 * decision picks, in the Prisma shape; a cursor page or another sort keeps the unpinned read on
 * Prisma. OFF reads Prisma only. Row parity is in
 * src/server/services/__tests__/hot-reads-4.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

// Pairwise distinct.
const MODEL = 9101;
const VIEWER = 9202;
const AUTHOR = 9303;
const REACTOR = 9404;
const C_UNPINNED = 9505;
const C_PINNED = 9606;
const CURSOR = 9707;
const CREATED = new Date('2026-08-01T01:02:03.456Z');
const PINNED_AT = new Date('2026-08-02T01:02:03.456Z');

const row = (id: number, pinnedAt: Date | null) => ({
  id,
  createdAt: CREATED,
  nsfw: false,
  content: `comment ${id}`,
  modelId: MODEL,
  parentId: null,
  locked: null,
  tosViolation: false,
  hidden: false,
  pinnedAt,
  authorId: AUTHOR,
  authorUsername: 'author',
  authorDeletedAt: null,
  authorImage: null,
  modelName: 'A model',
  reactions: [{ id: 9808, reaction: 'Like', userId: REACTOR, username: 'reactor' }],
});

const item = (id: number, pinnedAt: Date | null) => ({
  id,
  createdAt: CREATED,
  nsfw: false,
  content: `comment ${id}`,
  modelId: MODEL,
  parentId: null,
  locked: null,
  tosViolation: false,
  hidden: false,
  pinnedAt,
  user: { id: AUTHOR, username: 'author', deletedAt: null, image: null },
  reactions: [{ id: 9808, reaction: 'Like', user: { id: REACTOR, username: 'reactor' } }],
  model: { name: 'A model' },
});

const viewerFilter = {
  modelId: MODEL,
  userId: undefined,
  excludedUserIds: [],
  excludeTosViolations: true,
  hidden: false,
};

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  getDbWithoutLag.mockReset().mockResolvedValue(dbMock.dbRead);
  getKyselyWithoutLag.mockReset().mockResolvedValue(kyselyRead);
  hidden.mockReset().mockResolvedValue([]);
  blockedBy.mockReset().mockResolvedValue([]);
  blocked.mockReset().mockResolvedValue([]);
  dbMock.dbRead.comment.findMany.mockImplementation((async (arg: {
    where: { pinnedAt: unknown };
  }) =>
    arg.where.pinnedAt === null ? [item(C_UNPINNED, null)] : [item(C_PINNED, PINNED_AT)]) as never);
  dbMock.dbRead.$queryRaw.mockResolvedValue([]);
  q.listTopLevelComments.mockImplementation((async (
    _db: unknown,
    _filter: unknown,
    page: { pinned: boolean }
  ) => (page.pinned ? [row(C_PINNED, PINNED_AT)] : [row(C_UNPINNED, null)])) as never);
});

const getAll = (input: Record<string, unknown> = {}) =>
  getCommentsInfiniteHandler({
    input: { modelId: MODEL, limit: 8, sort: ReviewSort.Newest, ...input },
    ctx: { user: { id: VIEWER, isModerator: false } },
  } as never);

const listCalls = () =>
  q.listTopLevelComments.mock.calls.map(([db, filter, page]) => ({ db, filter, page }));

describe('comment.getAll behind kysely-hot-reads-4', () => {
  it('control: the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });

  it('evaluates kysely-hot-reads-4 by key, with no entity or context, once per request', async () => {
    await getAll();
    expect(flag.mock.calls).toEqual([['kysely-hot-reads-4']]);
  });

  it('OFF: reads both lists through Prisma only', async () => {
    const { comments } = await getAll();
    expect(comments.map((c) => c.id)).toEqual([C_PINNED, C_UNPINNED]);
    expect(dbMock.dbRead.comment.findMany).toHaveBeenCalledTimes(2);
    expect(getDbWithoutLag).toHaveBeenCalledWith('commentModel', MODEL);
    expect(getKyselyWithoutLag).not.toHaveBeenCalled();
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });

  it('ON: reads the first page and the pinned block through Kysely only, on the replica', async () => {
    flag.mockResolvedValue(true);
    const { comments } = await getAll();
    expect(getKyselyWithoutLag.mock.calls).toEqual([
      ['commentModel', MODEL],
      ['commentModel', MODEL],
    ]);
    expect(listCalls()).toEqual([
      {
        db: kyselyRead,
        filter: viewerFilter,
        page: { pinned: false, createdAt: 'desc', limit: 9, offset: undefined },
      },
      { db: kyselyRead, filter: viewerFilter, page: { pinned: true } },
    ]);
    // By identity: `toEqual` compares the two Kysely clients structurally.
    for (const call of q.listTopLevelComments.mock.calls) expect(call[0]).toBe(kyselyRead);
    expect(dbMock.dbRead.comment.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comment.findMany).not.toHaveBeenCalled();
    expect(getDbWithoutLag).not.toHaveBeenCalled();
    // The Kysely rows reach the handler in the Prisma shape, pinned first.
    const author = { ...item(C_UNPINNED, null).user, profilePicture: null, cosmetics: [] };
    expect(comments).toStrictEqual([
      { ...item(C_PINNED, PINNED_AT), user: author, _count: { comments: 0 } },
      { ...item(C_UNPINNED, null), user: author, _count: { comments: 0 } },
    ]);
  });

  it('ON: follows the lag decision to the primary, as the Prisma reads do', async () => {
    flag.mockResolvedValue(true);
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    await getAll();
    expect(q.listTopLevelComments).toHaveBeenCalledTimes(2);
    for (const call of q.listTopLevelComments.mock.calls) expect(call[0]).toBe(kyselyWrite);
  });

  it('ON: oldest first and a page number reach the statement', async () => {
    flag.mockResolvedValue(true);
    await getAll({ sort: ReviewSort.Oldest, page: 3 });
    expect(listCalls()[0].page).toEqual({ pinned: false, createdAt: 'asc', limit: 9, offset: 18 });
  });

  it('ON: a cursor page reads the unpinned list through Prisma, and no pinned block', async () => {
    flag.mockResolvedValue(true);
    await getAll({ cursor: CURSOR });
    expect(dbMock.dbRead.comment.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.comment.findMany.mock.calls[0][0]).toMatchObject({
      cursor: { id: CURSOR },
      where: { pinnedAt: null },
    });
    expect(q.listTopLevelComments).not.toHaveBeenCalled();
  });

  it('ON: another sort reads the unpinned list through Prisma, the pinned block through Kysely', async () => {
    flag.mockResolvedValue(true);
    await getAll({ sort: ReviewSort.MostLiked });
    expect(dbMock.dbRead.comment.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.comment.findMany.mock.calls[0][0]).toMatchObject({
      orderBy: { reactions: { _count: 'desc' } },
      where: { pinnedAt: null },
    });
    expect(listCalls()).toEqual([{ db: kyselyRead, filter: viewerFilter, page: { pinned: true } }]);
  });

  it('ON: the viewer exclusions reach both statements', async () => {
    flag.mockResolvedValue(true);
    hidden.mockResolvedValue([{ id: AUTHOR }]);
    await getAll();
    for (const { filter } of listCalls()) expect(filter.excludedUserIds).toEqual([AUTHOR]);
  });
});
