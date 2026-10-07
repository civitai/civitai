import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import { countJudgingPairs } from '~/server/services/crucible.service';
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
