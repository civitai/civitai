import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Store from '~/server/games/daily-challenge/challenge-pairwise-store';
import type * as Pairwise from '~/server/games/daily-challenge/challenge-pairwise';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';
import type * as Flipt from '~/server/flipt/client';

const { queryRaw, isFliptMock } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  isFliptMock: vi.fn().mockResolvedValue(true),
}));

// The engine only reads Image rows directly; everything else it touches goes through the store.
vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: queryRaw },
  dbWrite: { $queryRaw: queryRaw, $executeRaw: vi.fn(), $transaction: vi.fn() },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Flipt>()),
  isFlipt: isFliptMock,
}));

vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeHelpers>()),
  incrementOperationSpent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/games/daily-challenge/challenge-pairwise-store', async (importOriginal) => ({
  ...(await importOriginal<typeof Store>()),
  getStandings: vi.fn(),
  insertStanding: vi.fn(),
  replaceStandings: vi.fn(),
  recordComparison: vi.fn(),
  getComparisons: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/challenge-pairwise', async (importOriginal) => ({
  ...(await importOriginal<typeof Pairwise>()),
  comparePair: vi.fn(),
}));

const store = vi.mocked(
  await import('~/server/games/daily-challenge/challenge-pairwise-store')
) as unknown as Record<keyof typeof Store, ReturnType<typeof vi.fn>>;
const { comparePair } = vi.mocked(
  await import('~/server/games/daily-challenge/challenge-pairwise')
);
const { incrementOperationSpent } = vi.mocked(
  await import('~/server/games/daily-challenge/challenge-helpers')
);
const { legacyAbsoluteEngine } = await import(
  '~/server/games/daily-challenge/challenge-engine-legacy'
);
const { pairwiseLadderEngine, PODIUM_SIZE } = await import(
  '~/server/games/daily-challenge/challenge-engine-pairwise'
);
const { buildJudgingEngineContext, resolveJudgingEngine } = await import(
  '~/server/games/daily-challenge/challenge-engine-registry'
);
const { JUDGING_ENGINES } = await import('~/server/games/daily-challenge/challenge-judging-engine');
const { FIXED_JUDGING_CATEGORIES } = await import(
  '~/server/games/daily-challenge/daily-challenge-scoring'
);

const ctx = buildJudgingEngineContext({
  challengeId: 424,
  collectionId: 7,
  theme: 'Neon Dreams',
});

const entry = (imageId: number) => ({
  imageId,
  userId: imageId * 100,
  username: `u${imageId}`,
  weightedRating: 5,
});

/** Lower imageId is the better entry, so the true order of any field is ascending. */
function trueOrderComparisons() {
  const recorded: Pairwise.PairwiseVerdict[] = [];
  comparePair.mockImplementation(async ({ challenger, opponent, seat }) => {
    const first = seat === 1 ? challenger : opponent;
    const verdict: Pairwise.PairwiseVerdict = {
      imageIdA: challenger.imageId,
      imageIdB: opponent.imageId,
      firstSeatImageId: first.imageId,
      winnerImageId: Math.min(challenger.imageId, opponent.imageId),
      margin: 'clear',
      perCategory: {},
      reason: 'because',
      model: 'test-judge',
      rerouted: false,
      usage: { promptTokens: 10, completionTokens: 1 },
      buzzCost: 0.5,
    };
    recorded.push(verdict);
    return verdict;
  });
  return recorded;
}

/**
 * The same fake, but each comparison takes a real tick. Instantly-resolving mocks serialise the
 * engine's concurrency and hide anything that depends on two bouts being in flight at once —
 * which is the only regime a seating race can appear in.
 */
function delayedComparisons(delayMs = 5) {
  const recorded: Pairwise.PairwiseVerdict[] = [];
  comparePair.mockImplementation(async ({ challenger, opponent, seat }) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const first = seat === 1 ? challenger : opponent;
    const verdict: Pairwise.PairwiseVerdict = {
      imageIdA: challenger.imageId,
      imageIdB: opponent.imageId,
      firstSeatImageId: first.imageId,
      winnerImageId: Math.min(challenger.imageId, opponent.imageId),
      margin: 'clear',
      perCategory: {},
      reason: 'because',
      model: 'test-judge',
      rerouted: false,
      usage: { promptTokens: 10, completionTokens: 1 },
      buzzCost: 0.5,
    };
    recorded.push(verdict);
    return verdict;
  });
  return recorded;
}

/**
 * An in-memory stand-in for the comparison table that keeps the two properties the real one has
 * and that a canned `getComparisons` mock throws away: the pair columns are normalised low-id
 * first, and a repeated (phase, pair, seat) is DISCARDED rather than stored twice. That discard is
 * how a seating bug turns into a missing row instead of an error, so a fixture without it cannot
 * observe the bug at all.
 */
function fakeComparisonStore() {
  const rows: (Store.StoredComparison & { phase: string })[] = [];
  store.recordComparison.mockImplementation(
    async ({ phase, verdict }: Parameters<typeof Store.recordComparison>[0]) => {
      const [imageIdA, imageIdB] = [verdict.imageIdA, verdict.imageIdB].sort((a, b) => a - b);
      const exists = rows.some(
        (r) =>
          r.phase === phase &&
          r.imageIdA === imageIdA &&
          r.imageIdB === imageIdB &&
          r.firstSeatImageId === verdict.firstSeatImageId
      );
      if (exists) return;
      rows.push({
        phase,
        imageIdA,
        imageIdB,
        firstSeatImageId: verdict.firstSeatImageId,
        winnerImageId: verdict.winnerImageId,
        reason: verdict.reason,
      });
    }
  );
  store.getComparisons.mockImplementation(async (_challengeId: number, phases: string[]) =>
    rows.filter((r) => phases.includes(r.phase))
  );
  return rows;
}

/** pair -> the set of images that actually sat first across that pair's bouts. */
function seatsPlayed(verdicts: Pairwise.PairwiseVerdict[]) {
  const seats = new Map<string, Set<number>>();
  for (const v of verdicts) {
    const key = [v.imageIdA, v.imageIdB].sort((a, b) => a - b).join(':');
    if (!seats.has(key)) seats.set(key, new Set());
    seats.get(key)!.add(v.firstSeatImageId);
  }
  return seats;
}

beforeEach(() => {
  vi.clearAllMocks();
  isFliptMock.mockResolvedValue(true);
  store.getStandings.mockResolvedValue([]);
  store.getComparisons.mockResolvedValue([]);
  store.insertStanding.mockResolvedValue(undefined);
  store.replaceStandings.mockResolvedValue(undefined);
  store.recordComparison.mockResolvedValue(undefined);
  queryRaw.mockImplementation(async () =>
    Array.from({ length: 40 }, (_, i) => ({ imageId: i + 1, url: `uuid-${i + 1}`, nsfwLevel: 1 }))
  );
});

describe('legacy absolute engine', () => {
  it('is the identity — the field it is handed is the field it returns', async () => {
    const field = [entry(3), entry(1), entry(2)];
    await expect(legacyAbsoluteEngine.rankField(ctx, field)).resolves.toBe(field);
  });

  it('has no opinion about winners, so the LLM winner pick still runs', async () => {
    await expect(legacyAbsoluteEngine.selectWinners(ctx, [entry(1)], 3)).resolves.toBeNull();
  });

  it('spends nothing and writes nothing when an entry is recorded', async () => {
    await legacyAbsoluteEngine.recordEntry(ctx, {
      imageId: 1,
      userId: 2,
      username: 'u',
      url: 'uuid-1',
      nsfwLevel: 1,
    });
    expect(comparePair).not.toHaveBeenCalled();
    expect(store.insertStanding).not.toHaveBeenCalled();
    expect(incrementOperationSpent).not.toHaveBeenCalled();
  });
});

describe('engine registry', () => {
  it('defaults to legacy for an unset or unrecognised column value', async () => {
    expect((await resolveJudgingEngine(null)).key).toBe(JUDGING_ENGINES.LegacyAbsolute);
    expect((await resolveJudgingEngine('some-future-engine')).key).toBe(
      JUDGING_ENGINES.LegacyAbsolute
    );
  });

  it('runs an opted-in challenge on the pairwise engine', async () => {
    expect((await resolveJudgingEngine('pairwise-ladder')).key).toBe(
      JUDGING_ENGINES.PairwiseLadder
    );
  });

  it('falls back to legacy while the flag is off, without touching the column', async () => {
    isFliptMock.mockResolvedValue(false);
    expect((await resolveJudgingEngine('pairwise-ladder')).key).toBe(
      JUDGING_ENGINES.LegacyAbsolute
    );
  });

  it('does not ask Flipt at all for a legacy challenge', async () => {
    await resolveJudgingEngine(null);
    expect(isFliptMock).not.toHaveBeenCalled();
  });

  it('falls back to the fixed rubric when the challenge defines no categories', () => {
    expect(ctx.categories).toEqual(FIXED_JUDGING_CATEGORIES);
  });

  it("carries the challenge's own categories and weights through to the engine", () => {
    const built = buildJudgingEngineContext({
      challengeId: 1,
      collectionId: 2,
      theme: 't',
      categories: [
        { key: 'theme', label: 'Theme', weight: 70, criteria: 'fits' },
        { key: 'creativity', label: 'Creativity', weight: 30, criteria: 'novel' },
      ],
    });
    expect(built.categories).toEqual([
      { key: 'theme', label: 'Theme', weight: 70 },
      { key: 'creativity', label: 'Creativity', weight: 30 },
    ]);
    expect(built.criteriaByKey).toEqual({ theme: 'fits', creativity: 'novel' });
  });
});

describe('pairwise engine — recording an arrival', () => {
  it('binary-searches the standing ladder and records the place it found', async () => {
    trueOrderComparisons();
    store.getStandings.mockResolvedValue(
      [10, 20, 30, 40].map((imageId, i) => ({
        imageId,
        userId: imageId,
        rank: i + 1,
        comparisons: 0,
      }))
    );
    queryRaw.mockResolvedValue(
      [10, 20, 25, 30, 40].map((imageId) => ({ imageId, url: `uuid-${imageId}`, nsfwLevel: 1 }))
    );

    await pairwiseLadderEngine.recordEntry(ctx, {
      imageId: 25,
      userId: 250,
      username: 'u25',
      url: 'uuid-25',
      nsfwLevel: 1,
    });

    expect(store.insertStanding).toHaveBeenCalledWith(
      expect.objectContaining({ challengeId: 424, imageId: 25, userId: 250, rank: 3 })
    );
  });

  it('places the first entry without paying for a comparison', async () => {
    trueOrderComparisons();
    await pairwiseLadderEngine.recordEntry(ctx, {
      imageId: 1,
      userId: 100,
      username: 'u1',
      url: 'uuid-1',
      nsfwLevel: 1,
    });
    expect(comparePair).not.toHaveBeenCalled();
    expect(store.insertStanding).toHaveBeenCalledWith(expect.objectContaining({ rank: 1 }));
  });

  it('charges the challenge for the comparisons it made', async () => {
    trueOrderComparisons();
    store.getStandings.mockResolvedValue(
      [10, 20, 30, 40].map((imageId, i) => ({
        imageId,
        userId: imageId,
        rank: i + 1,
        comparisons: 0,
      }))
    );
    await pairwiseLadderEngine.recordEntry(ctx, {
      imageId: 25,
      userId: 250,
      username: 'u25',
      url: 'uuid-25',
      nsfwLevel: 1,
    });
    expect(incrementOperationSpent).toHaveBeenCalledWith(424, expect.any(Number));
    expect(incrementOperationSpent.mock.calls[0][1]).toBeGreaterThan(0);
  });

  it('persists every verdict it paid for, so a later stage can reuse it', async () => {
    trueOrderComparisons();
    store.getStandings.mockResolvedValue(
      [10, 20, 30, 40].map((imageId, i) => ({
        imageId,
        userId: imageId,
        rank: i + 1,
        comparisons: 0,
      }))
    );
    await pairwiseLadderEngine.recordEntry(ctx, {
      imageId: 25,
      userId: 250,
      username: 'u25',
      url: 'uuid-25',
      nsfwLevel: 1,
    });
    expect(store.recordComparison).toHaveBeenCalledTimes(comparePair.mock.calls.length);
    expect(store.recordComparison.mock.calls[0][0]).toMatchObject({
      challengeId: 424,
      phase: 'arrive',
    });
  });
});

describe('pairwise engine — ranking the field at close', () => {
  it('returns the field in ladder order, and only the entries it was given', async () => {
    trueOrderComparisons();
    const field = [entry(3), entry(1), entry(4), entry(2)];
    store.getStandings.mockResolvedValue(
      field.map((e, i) => ({ imageId: e.imageId, userId: e.userId, rank: i + 1, comparisons: 0 }))
    );

    const ranked = await pairwiseLadderEngine.rankField(ctx, field);

    expect(ranked.map((e) => e.imageId)).toEqual([1, 2, 3, 4]);
    expect(store.replaceStandings).toHaveBeenCalledWith(424, [
      { imageId: 1, userId: 100 },
      { imageId: 2, userId: 200 },
      { imageId: 3, userId: 300 },
      { imageId: 4, userId: 400 },
    ]);
  });

  it('places an entry the arrival pass never got to', async () => {
    trueOrderComparisons();
    const field = [entry(1), entry(2), entry(3)];
    // 2's arrival comparison failed, so it has no standing row.
    store.getStandings.mockResolvedValue([
      { imageId: 1, userId: 100, rank: 1, comparisons: 2 },
      { imageId: 3, userId: 300, rank: 2, comparisons: 2 },
    ]);

    const ranked = await pairwiseLadderEngine.rankField(ctx, field);

    expect(ranked.map((e) => e.imageId)).toEqual([1, 2, 3]);
  });

  it('drops a stale standing for an entry that is no longer eligible', async () => {
    trueOrderComparisons();
    const field = [entry(1), entry(3)];
    store.getStandings.mockResolvedValue([
      { imageId: 1, userId: 100, rank: 1, comparisons: 0 },
      { imageId: 2, userId: 200, rank: 2, comparisons: 0 },
      { imageId: 3, userId: 300, rank: 3, comparisons: 0 },
    ]);

    const ranked = await pairwiseLadderEngine.rankField(ctx, field);

    expect(ranked.map((e) => e.imageId)).toEqual([1, 3]);
  });

  it('fails loudly rather than returning standings that cover a subset of the field', async () => {
    // The engine is handed four eligible entries but the ladder can only account for three. A
    // three-name ladder is not a result — it is a result-shaped subset, and reading one as the
    // challenge outcome is the bug that silently deleted 54 of 284 entries from a live run.
    trueOrderComparisons();
    const field = [entry(1), entry(2), entry(3), entry(4)];
    const { reinsertTop } = await import('~/server/games/daily-challenge/challenge-ladder');
    const spy = vi
      .spyOn(await import('~/server/games/daily-challenge/challenge-ladder'), 'reinsertTop')
      .mockImplementation(async (order, bout, topK, concurrency) => {
        const result = await reinsertTop(order, bout, topK, concurrency);
        return { ...result, order: result.order.slice(1) };
      });

    await expect(pairwiseLadderEngine.rankField(ctx, field)).rejects.toThrow(
      /cover 3 of 4 eligible entries for challenge 424/
    );
    expect(store.replaceStandings).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not compare anything when there is nothing to order', async () => {
    trueOrderComparisons();
    const field = [entry(1)];
    await expect(pairwiseLadderEngine.rankField(ctx, field)).resolves.toEqual(field);
    expect(comparePair).not.toHaveBeenCalled();
  });
});

describe('pairwise engine — picking the places', () => {
  it('ranks by win rate, from the bouts it actually played', async () => {
    fakeComparisonStore();
    trueOrderComparisons();
    const field = [entry(2), entry(1), entry(3)];

    const winners = await pairwiseLadderEngine.selectWinners(ctx, field, 3);

    expect(winners?.map((w) => w.imageId)).toEqual([1, 2, 3]);
    expect(winners?.[0]).toMatchObject({ userId: 100, imageId: 1 });
    expect(winners?.[0].reason).toMatch(/head-to-head/);
  });

  // The defect this replaces a vacuous test for. The old version asserted a call count and a
  // winner order that came entirely from a canned mock, under the title "plays both seats" — it
  // passed with every pair single-seated, which is exactly what the code did. Seats were derived
  // from a session counter read before an await and incremented after it, so two concurrent bouts
  // for one pair read the same value, took the same seat, and the second row was then discarded by
  // ON CONFLICT DO NOTHING after it had been paid for.
  it('plays BOTH seats of every shortlist pair, with comparisons genuinely in flight together', async () => {
    fakeComparisonStore();
    const recorded = delayedComparisons();
    const field = Array.from({ length: 6 }, (_, i) => entry(i + 1));

    await pairwiseLadderEngine.selectWinners(ctx, field, 3);

    const pairs = (6 * 5) / 2;
    expect(recorded).toHaveLength(pairs * 2);
    const seats = seatsPlayed(recorded);
    expect(seats.size).toBe(pairs);
    // Not "two bouts happened" — two DIFFERENT seats happened. A pair played twice on one seat
    // is a rank built on the seat bias the alternation exists to cancel, and a wasted call.
    const singleSeated = [...seats.entries()].filter(([, s]) => s.size !== 2);
    expect(singleSeated.map(([pair]) => pair)).toEqual([]);
  });

  it('never asks for the same pair and seat twice — a duplicate is silently dropped on write', async () => {
    const stored = fakeComparisonStore();
    const recorded = delayedComparisons();
    const field = Array.from({ length: 6 }, (_, i) => entry(i + 1));

    await pairwiseLadderEngine.selectWinners(ctx, field, 3);

    // Every paid comparison survived the write. The gap between these two numbers IS the defect:
    // 30 calls billed, 19 rows kept.
    expect(stored).toHaveLength(recorded.length);
    const keys = recorded.map((v) =>
      [...[v.imageIdA, v.imageIdB].sort((a, b) => a - b), v.firstSeatImageId].join(':')
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('returns only as many winners as there are prize places', async () => {
    fakeComparisonStore();
    trueOrderComparisons();
    const winners = await pairwiseLadderEngine.selectWinners(
      ctx,
      [entry(1), entry(2), entry(3), entry(4)],
      2
    );
    expect(winners).toHaveLength(2);
  });

  it('shortlists the ladder leaders rather than round-robining the whole field', async () => {
    fakeComparisonStore();
    trueOrderComparisons();
    const field = Array.from({ length: 30 }, (_, i) => entry(i + 1));

    await pairwiseLadderEngine.selectWinners(ctx, field, 3);

    const expectedPairs = (PODIUM_SIZE * (PODIUM_SIZE - 1)) / 2;
    expect(comparePair).toHaveBeenCalledTimes(expectedPairs * 2);
  });

  it('writes the podium order back over the ladder, keeping the rest of the field behind it', async () => {
    fakeComparisonStore();
    // 2 beats 1 on both seats, inverting the ladder order it arrived with.
    comparePair.mockImplementation(async ({ challenger, opponent, seat }) => ({
      imageIdA: challenger.imageId,
      imageIdB: opponent.imageId,
      firstSeatImageId: seat === 1 ? challenger.imageId : opponent.imageId,
      winnerImageId: 2,
      margin: 'clear',
      perCategory: {},
      reason: 'because',
      model: 'test-judge',
      rerouted: false,
      usage: { promptTokens: 10, completionTokens: 1 },
      buzzCost: 0.5,
    }));

    await pairwiseLadderEngine.selectWinners(ctx, [entry(1), entry(2)], 2);

    const written = store.replaceStandings.mock.calls.at(-1)?.[1] as { imageId: number }[];
    expect(written.map((row) => row.imageId)).toEqual([2, 1]);
  });

  it('still charges for the comparisons it made when the stage throws', async () => {
    // The provider bills a comparison the moment it returns, so a stage that dies half way
    // through has spent real money. Settling only on success made a mid-stage 429 look free.
    //
    // ONE call fails and every later one SUCCEEDS. The first version of this test made all
    // subsequent calls throw too, so `buzz` could not grow after settle and the real defect —
    // a pool that keeps dispatching behind an already-rejected promise, billing bouts nothing
    // records — was invisible to it. That is the same blind-regime mistake as the seat race.
    fakeComparisonStore();
    let calls = 0;
    comparePair.mockImplementation(async ({ challenger, opponent, seat }) => {
      const n = ++calls;
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (n === 4) throw new Error('HTTP 429: rate limited');
      return {
        imageIdA: challenger.imageId,
        imageIdB: opponent.imageId,
        firstSeatImageId: seat === 1 ? challenger.imageId : opponent.imageId,
        winnerImageId: Math.min(challenger.imageId, opponent.imageId),
        margin: 'clear',
        perCategory: {},
        reason: 'because',
        model: 'test-judge',
        rerouted: false,
        usage: { promptTokens: 10, completionTokens: 1 },
        buzzCost: 4,
      };
    });

    const field = Array.from({ length: 8 }, (_, i) => entry(i + 1));
    await expect(pairwiseLadderEngine.selectWinners(ctx, field, 3)).rejects.toThrow(/rate limited/);

    // Every comparison that returned is accounted for, and none arrived after the accounting.
    const billed = (calls - 1) * 4;
    expect(incrementOperationSpent).toHaveBeenCalledTimes(1);
    expect(incrementOperationSpent).toHaveBeenCalledWith(424, billed);
  });

  it('stops buying comparisons once a stage has failed', async () => {
    // 28 pairs x 2 seats = 56 jobs. A pool that keeps dispatching after the failure would run
    // essentially all of them; one that stops runs at most a lane's worth more.
    fakeComparisonStore();
    let calls = 0;
    comparePair.mockImplementation(async ({ challenger, opponent, seat }) => {
      const n = ++calls;
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (n === 4) throw new Error('HTTP 429: rate limited');
      return {
        imageIdA: challenger.imageId,
        imageIdB: opponent.imageId,
        firstSeatImageId: seat === 1 ? challenger.imageId : opponent.imageId,
        winnerImageId: Math.min(challenger.imageId, opponent.imageId),
        margin: 'clear',
        perCategory: {},
        reason: 'because',
        model: 'test-judge',
        rerouted: false,
        usage: { promptTokens: 10, completionTokens: 1 },
        buzzCost: 4,
      };
    });

    const field = Array.from({ length: 8 }, (_, i) => entry(i + 1));
    await expect(pairwiseLadderEngine.selectWinners(ctx, field, 3)).rejects.toThrow(/rate limited/);

    expect(calls).toBeLessThan(20);
  });

  it('defers to the caller when there is nothing to compare', async () => {
    await expect(pairwiseLadderEngine.selectWinners(ctx, [entry(1)], 3)).resolves.toBeNull();
  });
});
