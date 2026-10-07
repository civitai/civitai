import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import {
  countJudgingPairs,
  getJudgingStatuses,
  getJudgingSuggestions,
} from '~/server/services/crucible.service';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY as CAP } from '~/shared/constants/crucible.constants';

const JUDGE = 42;
const queryRaw = dbMock.dbRead.$queryRaw;

/** Redis state per crucible for JUDGE: votes per entry and voted pair keys. */
function judgeState(state: Record<number, { votes?: Record<number, number>; voted?: string[] }>) {
  const crucibleOf = (key: string) => Number(key.split(':').at(-2));
  redisMock.sysRedis.hGetAll.mockImplementation(async (key: string) =>
    Object.fromEntries(
      Object.entries(state[crucibleOf(key)]?.votes ?? {}).map(([id, n]) => [id, String(n)])
    )
  );
  redisMock.sysRedis.sMembers.mockImplementation(
    async (key: string) => state[crucibleOf(key)]?.voted ?? []
  );
}

const entries = (byCrucible: Record<number, number[]>) =>
  Object.entries(byCrucible).flatMap(([crucibleId, ids]) =>
    ids.map((id) => ({ crucibleId: Number(crucibleId), id }))
  );

describe('countJudgingPairs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    judgeState({});
  });

  it('counts each crucible from one entries query', async () => {
    queryRaw.mockResolvedValue(entries({ 1: [10, 11, 12], 2: [20, 21] }));
    judgeState({ 2: { voted: ['20:21'], votes: { 20: 1, 21: 1 } } });

    const counts = await countJudgingPairs({ crucibleIds: [1, 2], userId: JUDGE, viewerLevel: 1 });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(counts.get(1)).toEqual({ remainingPairs: 3, visibleEntries: 3, judged: false });
    expect(counts.get(2)).toEqual({ remainingPairs: 0, visibleEntries: 2, judged: true });
  });

  it('answers a crucible with no visible entries', async () => {
    queryRaw.mockResolvedValue([]);

    const counts = await countJudgingPairs({ crucibleIds: [3], userId: JUDGE, viewerLevel: 1 });

    expect(counts.get(3)).toEqual({ remainingPairs: 0, visibleEntries: 0, judged: false });
  });

  // No counter is stored, so a late entry re-opens pairs for a judge who was caught up.
  it('re-opens pairs for a caught-up judge when a new entry arrives', async () => {
    judgeState({ 1: { voted: ['10:11'], votes: { 10: CAP, 11: CAP } } });

    queryRaw.mockResolvedValue(entries({ 1: [10, 11] }));
    expect(
      (await countJudgingPairs({ crucibleIds: [1], userId: JUDGE, viewerLevel: 1 })).get(1)
    ).toMatchObject({ remainingPairs: 0 });

    queryRaw.mockResolvedValue(entries({ 1: [10, 11, 12] }));
    expect(
      (await countJudgingPairs({ crucibleIds: [1], userId: JUDGE, viewerLevel: 1 })).get(1)!
        .remainingPairs
    ).toBeGreaterThan(0);
  });

  it('reads each crucible once when an id repeats', async () => {
    queryRaw.mockResolvedValue(entries({ 1: [10, 11] }));

    const counts = await countJudgingPairs({ crucibleIds: [1, 1], userId: JUDGE, viewerLevel: 1 });

    expect(counts.size).toBe(1);
    expect(redisMock.sysRedis.sMembers).toHaveBeenCalledTimes(1);
  });

  it('makes no queries for no crucibles', async () => {
    const counts = await countJudgingPairs({ crucibleIds: [], userId: JUDGE, viewerLevel: 1 });

    expect(counts.size).toBe(0);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

const findMany = dbMock.dbRead.crucible.findMany;
const crucibleRow = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  userId: 555,
  nsfwLevel: 1,
  textNsfw: false,
  ingestion: 'Scanned',
  image: { ingestion: 'Scanned' },
  ...extra,
});

describe('getJudgingStatuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    judgeState({});
  });

  it('reports available, caught up and never judged', async () => {
    findMany.mockResolvedValue([crucibleRow(1), crucibleRow(2), crucibleRow(3)]);
    queryRaw.mockResolvedValue(entries({ 1: [10, 11, 12], 2: [20, 21], 3: [30, 31] }));
    judgeState({
      1: { voted: ['10:11'], votes: { 10: 1, 11: 1 } },
      2: { voted: ['20:21'], votes: { 20: 1, 21: 1 } },
    });

    const statuses = await getJudgingStatuses({ crucibleIds: [1, 2, 3], userId: JUDGE });

    expect(statuses).toEqual([
      { crucibleId: 1, judged: true, available: true, votesUsedUp: false },
      { crucibleId: 2, judged: true, available: false, votesUsedUp: true },
      { crucibleId: 3, judged: false, available: true, votesUsedUp: false },
    ]);
  });

  it('does not call a judge caught up when their browsing level hides the entries', async () => {
    findMany.mockResolvedValue([crucibleRow(1)]);
    queryRaw.mockResolvedValue(entries({ 1: [10] }));
    judgeState({ 1: { voted: ['10:11'], votes: { 10: 1, 11: 1 } } });

    const [status] = await getJudgingStatuses({ crucibleIds: [1], userId: JUDGE });

    expect(status).toMatchObject({ judged: true, available: false, votesUsedUp: false });
  });

  it('asks only for active crucibles that have not ended', async () => {
    findMany.mockResolvedValue([]);

    await getJudgingStatuses({ crucibleIds: [1], userId: JUDGE });

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      id: { in: [1] },
      status: CrucibleStatus.Active,
      OR: [{ endAt: null }, { endAt: { gt: expect.any(Date) } }],
    });
  });

  it('omits crucibles the viewer may not see', async () => {
    findMany.mockResolvedValue([
      crucibleRow(1, { ingestion: 'Pending' }), // under scan
      crucibleRow(2, { userId: 777 }), // host blocked the viewer
      crucibleRow(3),
    ]);
    queryRaw.mockResolvedValue(entries({ 3: [30, 31] }));

    const statuses = await getJudgingStatuses({
      crucibleIds: [1, 2, 3],
      userId: JUDGE,
      blockedByUserIds: [777],
    });

    expect(statuses.map((s) => s.crucibleId)).toEqual([3]);
  });

  // R (4) is not in CRUCIBLE_SFW_LEVELS (PG and PG13 only).
  it('omits crucibles that are not on site for a green viewer', async () => {
    findMany.mockResolvedValue([crucibleRow(1, { nsfwLevel: 4 })]);

    expect(await getJudgingStatuses({ crucibleIds: [1], userId: JUDGE, isGreen: true })).toEqual([]);
  });
});

describe('getJudgingSuggestions', () => {
  beforeEach(() => judgeState({}));

  it('skips crucibles the judge has no pairs left in', async () => {
    queryRaw
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]) // candidates, newest first
      .mockResolvedValueOnce(entries({ 1: [10, 11], 2: [20, 21], 3: [30, 31] }));
    judgeState({ 1: { voted: ['10:11'], votes: { 10: 1, 11: 1 } } });
    findMany.mockImplementation(async ({ where }: { where: { id: { in: number[] } } }) =>
      where.id.in.map((id) => ({ id }))
    );
    dbMock.dbRead.crucibleEntry.groupBy.mockResolvedValue([]);

    const suggestions = await getJudgingSuggestions({ userId: JUDGE, limit: 1 });

    expect(suggestions.map((c) => c.id)).toEqual([2]);
    expect(findMany.mock.calls.at(-1)![0].where).toEqual({ id: { in: [2] } });
  });
});
