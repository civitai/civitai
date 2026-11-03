import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads4 from '@civitai/db-queries/hot-reads-4';
import type * as LagHelpers from '~/server/db/db-lag-helpers';

// Mocked for the invariant guard that no flag check remains on these reads (not regression
// coverage).
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-4 statement stubbed: their rows, against a real database, are pinned in
// hot-reads-4.kysely-parity.test.ts. Here the two counts answer from the fixture rows below.
vi.mock('@civitai/db-queries/hot-reads-4', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads4>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
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
import { getVisibleCommentCount, getVisibleCommentCounts } from '~/server/services/comment.service';

/**
 * `comment.getVisibleCountsByModel` (`getVisibleCommentCounts`): both of the model page's counts in
 * one call. On fixture rows, each must equal the single count it replaces
 * (`getVisibleCommentCount` with `hidden: true` and with no `hidden`) for every viewer, including
 * the model owner with a blocker, where the unpinned and pinned filters differ. Plus which client
 * and statement it uses, and that `includeVisible: false` runs no visible count.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

// Pairwise distinct, and distinct from every count below.
const MODEL = 7101;
const VIEWER = 7202;
const BLOCKER = 7303;
const HIDDEN_AUTHOR = 7404;
const AUTHOR = 7505;
const OTHER_MODEL = 7606;

type Row = {
  id: number;
  modelId: number;
  userId: number;
  parentId: number | null;
  tosViolation: boolean;
  hidden: boolean | null;
  pinnedAt: Date | null;
};
type Filter = {
  modelId?: number;
  userId?: number;
  excludedUserIds: number[];
  excludeTosViolations: boolean;
  hidden?: boolean;
};
type Scope = 'any' | 'unpinned' | 'pinned';
/** A top-level comment the filter admits, before `hidden`: the conditions both counts share. */
const admits = (r: Row, f: Filter, scope: Scope) =>
  (f.modelId === undefined || r.modelId === f.modelId) &&
  (f.userId ? r.userId === f.userId : !f.excludedUserIds.includes(r.userId)) &&
  r.parentId === null &&
  (!f.excludeTosViolations || !r.tosViolation) &&
  (scope === 'any' || (scope === 'pinned') === (r.pinnedAt !== null));

const PIN = new Date('2026-01-01');
const row = (id: number, over: Partial<Row> = {}): Row => ({
  id,
  modelId: MODEL,
  userId: AUTHOR,
  parentId: null,
  tosViolation: false,
  hidden: false,
  pinnedAt: null,
  ...over,
});
const rows: Row[] = [
  row(1),
  row(2, { pinnedAt: PIN }),
  row(3, { hidden: true }),
  row(4, { hidden: true, pinnedAt: PIN }),
  row(5, { hidden: null }), // neither view
  row(6, { parentId: 1 }), // a reply: neither
  row(7, { tosViolation: true }), // moderators only
  row(8, { tosViolation: true, hidden: true }),
  row(9, { modelId: OTHER_MODEL }),
  row(10, { userId: BLOCKER }), // a blocker, unpinned
  row(11, { userId: BLOCKER, hidden: true }),
  row(12, { userId: BLOCKER, pinnedAt: PIN }),
  row(13, { userId: BLOCKER, hidden: true, pinnedAt: PIN }),
  row(14, { userId: HIDDEN_AUTHOR }),
  row(15, { userId: HIDDEN_AUTHOR, hidden: true }),
  // One more hidden row, so the two views' counts differ for every viewer and a swap shows.
  row(16, { hidden: true }),
];

/** How many fixture rows a count would find; a NULL `hidden` matches neither view. */
const countOf = (f: Filter, scope: Scope, hiddenView: boolean) =>
  rows.filter((r) => admits(r, f, scope) && r.hidden === hiddenView).length;

const viewer = (isModerator = false) => ({ id: VIEWER, isModerator } as never);

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  getDbWithoutLag.mockReset().mockResolvedValue(dbMock.dbRead);
  getKyselyWithoutLag.mockReset().mockResolvedValue(kyselyRead);
  hidden.mockReset().mockResolvedValue([]);
  blockedBy.mockReset().mockResolvedValue([]);
  blocked.mockReset().mockResolvedValue([]);
  dbMock.dbRead.model.findUnique.mockResolvedValue(null);
  q.countTopLevelComments.mockImplementation((async (_db: unknown, f: Filter, scope: Scope) =>
    countOf(f, scope, f.hidden ?? false)) as never);
  q.countTopLevelCommentsByHidden.mockImplementation((async (
    _db: unknown,
    f: Filter,
    scope: Scope
  ) => ({ visible: countOf(f, scope, false), hidden: countOf(f, scope, true) })) as never);
});

describe('getVisibleCommentCounts equals the two single counts (fixture rows)', () => {
  it.each([
    ['a viewer with no exclusions', {}, false, undefined, { visible: 5, hidden: 6 }],
    ['a moderator', {}, true, undefined, { visible: 6, hidden: 7 }],
    [
      'a viewer hiding an author',
      { hiddenIds: [HIDDEN_AUTHOR] },
      false,
      undefined,
      {
        visible: 4,
        hidden: 5,
      },
    ],
    [
      'a viewer blocked by an author',
      { blockedByIds: [BLOCKER] },
      false,
      undefined,
      {
        visible: 3,
        hidden: 4,
      },
    ],
    // The owner sees the blocker's unpinned comments, never their pinned ones.
    [
      'the model owner blocked by an author',
      { blockedByIds: [BLOCKER] },
      false,
      VIEWER,
      {
        visible: 4,
        hidden: 5,
      },
    ],
  ] as const)('%s', async (_label, lists, isMod, ownerId, expected) => {
    const l = lists as { hiddenIds?: number[]; blockedByIds?: number[] };
    hidden.mockResolvedValue((l.hiddenIds ?? []).map((id) => ({ id })));
    blockedBy.mockResolvedValue((l.blockedByIds ?? []).map((id) => ({ id })));
    dbMock.dbRead.model.findUnique.mockResolvedValue(
      ownerId ? ({ userId: ownerId } as never) : null
    );
    const user = viewer(isMod);

    const counts = await getVisibleCommentCounts({
      input: { modelId: MODEL, includeVisible: true },
      user,
    });

    expect(counts).toStrictEqual(expected);
    expect(counts).toStrictEqual({
      visible: await getVisibleCommentCount({ input: { modelId: MODEL }, user }),
      hidden: await getVisibleCommentCount({ input: { modelId: MODEL, hidden: true }, user }),
    });
  });

  it('control: the owner case is two by-hidden statements (the filters differ), the others one', async () => {
    blockedBy.mockResolvedValue([{ id: BLOCKER }]);
    dbMock.dbRead.model.findUnique.mockResolvedValue({ userId: VIEWER } as never);
    await getVisibleCommentCounts({
      input: { modelId: MODEL, includeVisible: true },
      user: viewer(),
    });
    expect(q.countTopLevelCommentsByHidden).toHaveBeenCalledTimes(2);

    q.countTopLevelCommentsByHidden.mockClear();
    dbMock.dbRead.model.findUnique.mockResolvedValue(null);
    await getVisibleCommentCounts({
      input: { modelId: MODEL, includeVisible: true },
      user: viewer(),
    });
    expect(q.countTopLevelCommentsByHidden).toHaveBeenCalledTimes(1);
    expect(q.countTopLevelComments).not.toHaveBeenCalled();
  });
});

describe('getVisibleCommentCounts routing', () => {
  it('includeVisible false: the hidden count only, visible null, no by-hidden statement', async () => {
    await expect(
      getVisibleCommentCounts({ input: { modelId: MODEL, includeVisible: false }, user: viewer() })
    ).resolves.toStrictEqual({ visible: null, hidden: 6 });
    const filters = q.countTopLevelComments.mock.calls.map(([, filter]) => filter);
    expect(filters).toHaveLength(1);
    expect(filters[0].hidden).toBe(true);
    expect(q.countTopLevelCommentsByHidden).not.toHaveBeenCalled();
  });

  it('one Kysely statement on the replica, with the filter minus `hidden` (invariant: no flag check remains)', async () => {
    q.countTopLevelCommentsByHidden.mockResolvedValue({ visible: 21, hidden: 13 });
    await expect(
      getVisibleCommentCounts({ input: { modelId: MODEL, includeVisible: true }, user: viewer() })
    ).resolves.toStrictEqual({ visible: 21, hidden: 13 });
    expect(q.countTopLevelCommentsByHidden.mock.calls).toEqual([
      [
        kyselyRead,
        { modelId: MODEL, userId: undefined, excludedUserIds: [], excludeTosViolations: true },
        'any',
      ],
    ]);
    // By identity: `toEqual` compares the two Kysely clients structurally.
    expect(q.countTopLevelCommentsByHidden.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.comment.groupBy).not.toHaveBeenCalled();
    expect(getDbWithoutLag).not.toHaveBeenCalled();
    expect(flag, 'invariant: no flag check remains').not.toHaveBeenCalled();
  });

  it('follows the lag decision to the primary', async () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    q.countTopLevelCommentsByHidden.mockResolvedValue({ visible: 21, hidden: 13 });
    await getVisibleCommentCounts({
      input: { modelId: MODEL, includeVisible: true },
      user: viewer(),
    });
    expect(q.countTopLevelCommentsByHidden.mock.calls[0][0]).toBe(kyselyWrite);
  });

  it('the owner case sums an unpinned and a pinned statement', async () => {
    blockedBy.mockResolvedValue([{ id: BLOCKER }]);
    dbMock.dbRead.model.findUnique.mockResolvedValue({ userId: VIEWER } as never);
    q.countTopLevelCommentsByHidden.mockImplementation((async (
      _db: unknown,
      _filter: unknown,
      scope: string
    ) =>
      scope === 'unpinned' ? { visible: 17, hidden: 19 } : { visible: 23, hidden: 29 }) as never);
    await expect(
      getVisibleCommentCounts({ input: { modelId: MODEL, includeVisible: true }, user: viewer() })
    ).resolves.toStrictEqual({ visible: 40, hidden: 48 });
    expect(
      q.countTopLevelCommentsByHidden.mock.calls.map(([, filter, scope]) => [
        filter.excludedUserIds,
        scope,
      ])
    ).toEqual([
      [[], 'unpinned'],
      [[BLOCKER], 'pinned'],
    ]);
  });
});
