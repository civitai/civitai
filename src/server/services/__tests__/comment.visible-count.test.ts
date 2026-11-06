import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads4 from '@civitai/db-queries/hot-reads-4';
import { dbMock } from '~/__tests__/mocks/db.mock';

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
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: async () => dbMock.dbRead,
  // The Kysely statements are stubbed below, so the client they are handed is never used.
  getKyselyWithoutLag: async () => ({}),
  preventReplicationLag: vi.fn(),
}));
// The count and the pinned block are Kysely statements; their rows, against a real database, are
// pinned in hot-reads-4.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-4', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads4>()),
  countTopLevelComments: vi.fn(),
  listTopLevelComments: vi.fn(),
}));

const queries = vi.mocked(await import('@civitai/db-queries/hot-reads-4'));
const { topLevelCommentsWhere } = await import('../hot-reads-4.reads');
const { getVisibleCommentCount, getComments, getPinnedCommentsViaKysely } = await import(
  '../comment.service'
);

const MODEL_ID = 10;
const user = (isModerator = false) => ({ id: 42, isModerator } as never);

/** Each count statement's filter and scope, in call order. */
const countCalls = () =>
  queries.countTopLevelComments.mock.calls.map(([, filter, scope]) => ({ filter, scope }));

beforeEach(() => {
  vi.clearAllMocks();
  queries.countTopLevelComments.mockReset().mockResolvedValue(0);
  queries.listTopLevelComments.mockReset().mockResolvedValue([]);
  dbMock.dbRead.comment.findMany.mockReset();
  dbMock.dbRead.model.findUnique.mockReset();
  hidden.mockResolvedValue([]);
  blockedBy.mockResolvedValue([]);
  blocked.mockResolvedValue([]);
});

describe('getVisibleCommentCount', () => {
  it('issues ONE count over the list filter when the unpinned and pinned filters agree', async () => {
    queries.countTopLevelComments.mockResolvedValueOnce(23);
    dbMock.dbRead.comment.findMany.mockResolvedValue([]);

    await expect(
      getVisibleCommentCount({ input: { modelId: MODEL_ID }, user: user() })
    ).resolves.toBe(23);
    await getComments({ input: { modelId: MODEL_ID }, select: {}, user: user() });

    // Before this change the count always issued two statements (pinnedAt null + not null).
    expect(countCalls().map(({ scope }) => scope)).toEqual(['any']);
    // ...and read each of the viewer's exclusion lists twice, once per where. getComments reads
    // each once more, so 2 here means the count read each list once.
    for (const list of [hidden, blockedBy, blocked]) expect(list).toHaveBeenCalledTimes(2);
    const [listWhere] = dbMock.dbRead.comment.findMany.mock.calls.map(([arg]) => arg.where);
    const { pinnedAt, ...listWhereWithoutPin } = listWhere;
    expect(pinnedAt).toBeNull();
    // The count's filter is the one the (Prisma) list's where is built from.
    expect(countCalls().map(({ filter }) => topLevelCommentsWhere(filter))).toEqual([
      listWhereWithoutPin,
    ]);
  });

  it('applies the same filters as the list for a non-moderator with excluded users', async () => {
    hidden.mockResolvedValue([{ id: 1 }]);
    blocked.mockResolvedValue([{ id: 2 }]);

    await getVisibleCommentCount({ input: { modelId: MODEL_ID }, user: user() });

    expect(countCalls()).toEqual([
      {
        filter: {
          modelId: MODEL_ID,
          userId: undefined,
          excludedUserIds: [1, 2],
          excludeTosViolations: true,
          hidden: false,
        },
        scope: 'any',
      },
    ]);
  });

  it('does not filter tosViolation for moderators and honours the hidden flag', async () => {
    await getVisibleCommentCount({ input: { modelId: MODEL_ID, hidden: true }, user: user(true) });

    // Hidden replies render in their thread, not in the "See N hidden comments" modal, so the
    // hidden count must stay top-level too: the count statement reads top-level comments only.
    expect(countCalls()).toHaveLength(1);
    for (const { filter } of countCalls()) {
      expect(filter.excludeTosViolations).toBe(false);
      expect(filter.hidden).toBe(true);
    }
  });

  it('keeps blocked-by users excluded from the pinned count even for the model owner, like the pinned list', async () => {
    blockedBy.mockResolvedValue([{ id: 9 }]);
    dbMock.dbRead.model.findUnique.mockResolvedValue({ userId: 42 });

    await getVisibleCommentCount({ input: { modelId: MODEL_ID }, user: user() });

    const [unpinned, pinned] = countCalls();
    expect(unpinned.scope).toBe('unpinned');
    expect(unpinned.filter.excludedUserIds).toEqual([]);
    expect(pinned.scope).toBe('pinned');
    expect(pinned.filter.excludedUserIds).toEqual([9]);
  });
});

// Parity on fixtures: the count must equal what the unpinned list (`getComments`, Prisma) plus the
// pinned block (`getPinnedCommentsViaKysely`) return to the same viewer. Every read evaluates its
// filter over the fixture rows: Prisma's `findMany` the where it is given, and the stubbed Kysely
// count and pinned block the where `topLevelCommentsWhere` builds from their filter. So this pins
// that the count and the lists agree when they are built from the same filter; it never runs the
// real Kysely SQL. What that statement returns against a real database is pinned in
// hot-reads-4.kysely-parity.test.ts.
type Row = {
  id: number;
  modelId: number;
  userId: number;
  parentId: number | null;
  tosViolation: boolean;
  hidden: boolean | null;
  pinnedAt: Date | null;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const matches = (r: Row, where: Record<string, any>) =>
  Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    const value = r[key as keyof Row];
    if (cond === null) return value === null;
    if (typeof cond === 'object' && !(cond instanceof Date)) {
      if ('notIn' in cond) return !cond.notIn.includes(value);
      if ('equals' in cond) return cond.equals === null ? value === null : value === cond.equals;
      if ('not' in cond && cond.not === null) return value !== null;
      throw new Error(`fixture evaluator: unsupported condition on ${key}`);
    }
    return value === cond;
  });

const PIN = new Date('2026-01-01');
const row = (id: number, over: Partial<Row> = {}): Row => ({
  id,
  modelId: MODEL_ID,
  userId: 100,
  parentId: null,
  tosViolation: false,
  hidden: false,
  pinnedAt: null,
  ...over,
});
const rows: Row[] = [
  row(1), // visible top-level, unpinned
  row(2, { userId: 101 }),
  row(3, { pinnedAt: PIN }), // visible top-level, pinned
  row(4, { parentId: 1 }), // reply: never counted
  row(5, { modelId: MODEL_ID + 1 }), // other model
  row(6, { userId: 102, tosViolation: true, pinnedAt: PIN }), // moderators only
  row(7, { hidden: true }), // the hidden view only
  row(8, { hidden: null }), // NULL hidden matches neither `hidden: false` nor `hidden: true`
  row(9, { userId: 9 }), // a blocker, unpinned
  row(10, { userId: 9, pinnedAt: PIN }), // a blocker, pinned
  row(12, { userId: 9, pinnedAt: PIN }), // a second pinned blocker row, so a pinned/unpinned where swap changes the owner's total
  row(11, { userId: 1, pinnedAt: PIN }), // a hidden user
];

describe('getVisibleCommentCount parity with the lists', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter = ({ where }: any) => rows.filter((r) => matches(r, where));
    const pinnedAt = (scope: string) =>
      scope === 'unpinned'
        ? { pinnedAt: null }
        : scope === 'pinned'
        ? { pinnedAt: { not: null } }
        : {};
    queries.countTopLevelComments.mockImplementation((async (
      _db: unknown,
      f: Parameters<typeof topLevelCommentsWhere>[0],
      scope: string
    ) => filter({ where: { ...topLevelCommentsWhere(f), ...pinnedAt(scope) } }).length) as never);
    queries.listTopLevelComments.mockImplementation((async (
      _db: unknown,
      f: Parameters<typeof topLevelCommentsWhere>[0],
      page: { pinned: boolean }
    ) =>
      filter({
        where: { ...topLevelCommentsWhere(f), ...pinnedAt(page.pinned ? 'pinned' : 'unpinned') },
      }).map((r) => ({ ...r, reactions: [] }))) as never);
    dbMock.dbRead.comment.findMany.mockImplementation((async (arg: unknown) =>
      filter(arg)) as never);
  });

  const listed = async (input: { modelId: number; hidden?: boolean }, viewer: never) => {
    const [list, pinned] = await Promise.all([
      getComments({ input, select: {}, user: viewer }),
      getPinnedCommentsViaKysely({ input, user: viewer }),
    ]);
    return list.length + pinned.length;
  };

  it.each([
    ['viewer with no exclusions', {}, false, undefined, 7],
    ['moderator', {}, true, undefined, 8],
    ['hidden comments view', { hidden: true }, false, undefined, 1],
    [
      'viewer with a hidden user and a blocker',
      { hiddenIds: [1], blockedByIds: [9] },
      false,
      undefined,
      3,
    ],
    ['model owner with a blocker', { hiddenIds: [1], blockedByIds: [9] }, false, 42, 4],
  ] as const)('%s', async (_label, lists, isMod, ownerId, expected) => {
    const l = lists as { hiddenIds?: number[]; blockedByIds?: number[]; hidden?: boolean };
    hidden.mockResolvedValue((l.hiddenIds ?? []).map((id) => ({ id })));
    blockedBy.mockResolvedValue((l.blockedByIds ?? []).map((id) => ({ id })));
    dbMock.dbRead.model.findUnique.mockResolvedValue(
      ownerId ? ({ userId: ownerId } as never) : null
    );
    const input = { modelId: MODEL_ID, hidden: l.hidden };

    const count = await getVisibleCommentCount({ input, user: user(isMod) });

    expect(count).toBe(expected);
    expect(count).toBe(await listed(input, user(isMod)));
  });
});
