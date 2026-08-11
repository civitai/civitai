import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairwiseVerdict } from '~/server/games/daily-challenge/challenge-pairwise';

// These statements are raw SQL, so nothing above them type-checks the column list, the conflict
// target, or the order of the interpolated values. The assertions below are deliberately about
// the SQL text and the bound parameters: that is the only layer where a wrong conflict target or
// a transposed pair column can be caught without a live database.

const { executeRaw, queryRaw, transaction } = vi.hoisted(() => ({
  executeRaw: vi.fn().mockReturnValue({ __statement: true }),
  queryRaw: vi.fn().mockResolvedValue([]),
  transaction: vi.fn().mockResolvedValue([]),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: queryRaw },
  dbWrite: { $queryRaw: queryRaw, $executeRaw: executeRaw, $transaction: transaction },
}));

const store = await import('~/server/games/daily-challenge/challenge-pairwise-store');

/** The SQL of a Prisma tagged-template call, with parameter holes marked. */
function sqlOf(call: unknown[]): string {
  const strings = call[0] as unknown as string[];
  return strings.join('?').replace(/\s+/g, ' ').trim();
}

const paramsOf = (call: unknown[]) => call.slice(1);

/** Every value bound by the call, flattening any nested Prisma.Sql fragments. */
function boundValues(call: unknown[]): unknown[] {
  return paramsOf(call).flatMap((param) => {
    const nested = (param as { values?: unknown[] })?.values;
    return Array.isArray(nested) ? nested : [param];
  });
}

const verdict = (over: Partial<PairwiseVerdict> = {}): PairwiseVerdict => ({
  imageIdA: 20,
  imageIdB: 10,
  firstSeatImageId: 20,
  winnerImageId: 10,
  margin: 'clear',
  perCategory: { Theme: 10 },
  reason: 'sharper',
  model: 'test-judge',
  rerouted: false,
  usage: { promptTokens: 1, completionTokens: 1 },
  buzzCost: 2.4,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  executeRaw.mockReturnValue({ __statement: true });
  queryRaw.mockResolvedValue([]);
  transaction.mockResolvedValue([]);
});

describe('recordComparison', () => {
  it('stores the pair low-id first, whichever entry was the challenger', async () => {
    await store.recordComparison({ challengeId: 424, phase: 'podium', verdict: verdict() });
    const params = paramsOf(executeRaw.mock.calls[0]);

    // challengeId, phase, imageIdA, imageIdB, firstSeat, winner, ...
    expect(params.slice(0, 5)).toEqual([424, 'podium', 10, 20, 20]);
  });

  it('normalises the pair identically when the challenger is the low id', async () => {
    await store.recordComparison({
      challengeId: 424,
      phase: 'podium',
      verdict: verdict({ imageIdA: 10, imageIdB: 20, firstSeatImageId: 10 }),
    });
    const params = paramsOf(executeRaw.mock.calls[0]);
    expect(params.slice(2, 5)).toEqual([10, 20, 10]);
  });

  it('conflicts on exactly the columns the unique index covers', async () => {
    await store.recordComparison({ challengeId: 424, phase: 'podium', verdict: verdict() });
    const sql = sqlOf(executeRaw.mock.calls[0]);

    // Must match ChallengeEntryComparison_pair_key. Drop firstSeatImageId from this list and the
    // podium's second seat becomes a conflict that DO NOTHING silently discards.
    expect(sql).toMatch(
      /ON CONFLICT \("challengeId", "phase", "imageIdA", "imageIdB", "firstSeatImageId"\) DO NOTHING/
    );
  });

  it('keeps both seats of a pair distinct, so the podium can store two rows', async () => {
    await store.recordComparison({
      challengeId: 424,
      phase: 'podium',
      verdict: verdict({ firstSeatImageId: 20 }),
    });
    await store.recordComparison({
      challengeId: 424,
      phase: 'podium',
      verdict: verdict({ firstSeatImageId: 10 }),
    });

    const seats = executeRaw.mock.calls.map((call) => paramsOf(call)[4]);
    expect(new Set(seats).size).toBe(2);
  });

  it('rounds the recorded cost UP — a sub-Buzz comparison must not bill as free', async () => {
    await store.recordComparison({
      challengeId: 424,
      phase: 'arrive',
      verdict: verdict({ buzzCost: 0.2 }),
    });
    expect(paramsOf(executeRaw.mock.calls[0])).toContain(1);
  });

  it('stores a tie as a null winner rather than dropping the row', async () => {
    await store.recordComparison({
      challengeId: 424,
      phase: 'arrive',
      verdict: verdict({ winnerImageId: null }),
    });
    expect(paramsOf(executeRaw.mock.calls[0])[5]).toBeNull();
  });
});

describe('insertStanding', () => {
  it('shifts the entries at or below the new rank down, and never itself', async () => {
    await store.insertStanding({
      challengeId: 424,
      imageId: 7,
      userId: 70,
      rank: 3,
      comparisons: 4,
    });

    const shift = sqlOf(executeRaw.mock.calls[0]);
    expect(shift).toMatch(/UPDATE "ChallengeEntryStanding" SET "rank" = "rank" \+ 1/);
    expect(shift).toMatch(/"rank" >= \? AND "imageId" <> \?/);
    expect(paramsOf(executeRaw.mock.calls[0])).toEqual([424, 3, 7]);
  });

  it('runs the shift and the insert as ONE transaction', async () => {
    // Between the two statements two entries share a rank. A reader in that window sees a
    // standings list with a duplicate position.
    await store.insertStanding({
      challengeId: 424,
      imageId: 7,
      userId: 70,
      rank: 3,
      comparisons: 4,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it('accumulates the comparison count on re-placement instead of overwriting it', async () => {
    await store.insertStanding({
      challengeId: 424,
      imageId: 7,
      userId: 70,
      rank: 3,
      comparisons: 4,
    });
    const insert = sqlOf(executeRaw.mock.calls[1]);
    expect(insert).toMatch(
      /"comparisons" = "ChallengeEntryStanding"\."comparisons" \+ EXCLUDED\."comparisons"/
    );
    expect(insert).toMatch(/ON CONFLICT \("challengeId", "imageId"\)/);
  });
});

describe('replaceStandings', () => {
  it('numbers ranks from 1 in the order it was given', async () => {
    await store.replaceStandings(424, [
      { imageId: 30, userId: 300 },
      { imageId: 10, userId: 100 },
      { imageId: 20, userId: 200 },
    ]);

    // The row tuples are one joined Prisma.Sql fragment, so the bound values live on it rather
    // than as positional args of the outer template.
    const values = boundValues(executeRaw.mock.calls[1]);
    const ranks = values.filter((_, i) => i % 6 === 3);
    expect(ranks).toEqual([1, 2, 3]);
    const imageIds = values.filter((_, i) => i % 6 === 1);
    expect(imageIds).toEqual([30, 10, 20]);
  });

  it('deletes and re-inserts in one transaction', async () => {
    await store.replaceStandings(424, [{ imageId: 1, userId: 10 }]);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it('does not emit a VALUES-less INSERT when there is nothing to write', async () => {
    // `INSERT ... VALUES` with an empty list is a syntax error, so an empty field has to skip the
    // statement rather than build one with no rows.
    await store.replaceStandings(424, []);
    expect(transaction.mock.calls[0][0]).toHaveLength(1);
    expect(sqlOf(executeRaw.mock.calls[0])).toMatch(/DELETE FROM "ChallengeEntryStanding"/);
  });
});

describe('getComparisons', () => {
  it('asks for nothing when given no phases, rather than every phase', async () => {
    const rows = await store.getComparisons(424, []);
    expect(rows).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('selects the seat column the tally needs to tell the two bouts apart', async () => {
    await store.getComparisons(424, ['podium']);
    expect(sqlOf(queryRaw.mock.calls[0])).toMatch(/"firstSeatImageId"/);
  });
});

describe('getStandings', () => {
  it('returns the ladder in rank order — the caller treats index 0 as the leader', async () => {
    await store.getStandings(424);
    expect(sqlOf(queryRaw.mock.calls[0])).toMatch(/ORDER BY "rank" ASC/);
  });
});
