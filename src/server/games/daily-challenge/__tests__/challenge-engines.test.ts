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
  comparePair.mockImplementation(async ({ challenger, opponent, step }) => {
    const first = step % 2 === 0 ? challenger : opponent;
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
    const { reinsertAll } = await import('~/server/games/daily-challenge/challenge-ladder');
    const spy = vi
      .spyOn(await import('~/server/games/daily-challenge/challenge-ladder'), 'reinsertAll')
      .mockImplementation(async (order, bout) => {
        const result = await reinsertAll(order, bout);
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
  it('plays both seats of every shortlist pair and ranks by win rate', async () => {
    trueOrderComparisons();
    const field = [entry(2), entry(1), entry(3)];
    store.getComparisons.mockResolvedValue([
      { imageIdA: 1, imageIdB: 2, winnerImageId: 1, firstSeatImageId: 1, reason: null },
      { imageIdA: 1, imageIdB: 3, winnerImageId: 1, firstSeatImageId: 1, reason: null },
      { imageIdA: 2, imageIdB: 3, winnerImageId: 2, firstSeatImageId: 2, reason: null },
    ]);

    const winners = await pairwiseLadderEngine.selectWinners(ctx, field, 3);

    // 3 pairs x 2 seats.
    expect(comparePair).toHaveBeenCalledTimes(6);
    expect(winners?.map((w) => w.imageId)).toEqual([1, 2, 3]);
    expect(winners?.[0]).toMatchObject({ userId: 100, imageId: 1 });
    expect(winners?.[0].reason).toMatch(/head-to-head/);
  });

  it('returns only as many winners as there are prize places', async () => {
    trueOrderComparisons();
    store.getComparisons.mockResolvedValue([]);
    const winners = await pairwiseLadderEngine.selectWinners(
      ctx,
      [entry(1), entry(2), entry(3), entry(4)],
      2
    );
    expect(winners).toHaveLength(2);
  });

  it('shortlists the ladder leaders rather than round-robining the whole field', async () => {
    trueOrderComparisons();
    store.getComparisons.mockResolvedValue([]);
    const field = Array.from({ length: 30 }, (_, i) => entry(i + 1));

    await pairwiseLadderEngine.selectWinners(ctx, field, 3);

    const expectedPairs = (PODIUM_SIZE * (PODIUM_SIZE - 1)) / 2;
    expect(comparePair).toHaveBeenCalledTimes(expectedPairs * 2);
  });

  it('writes the podium order back over the ladder, keeping the rest of the field behind it', async () => {
    trueOrderComparisons();
    store.getComparisons.mockResolvedValue([
      { imageIdA: 1, imageIdB: 2, winnerImageId: 2, firstSeatImageId: 1, reason: null },
    ]);

    await pairwiseLadderEngine.selectWinners(ctx, [entry(1), entry(2)], 2);

    const written = store.replaceStandings.mock.calls.at(-1)?.[1] as { imageId: number }[];
    expect(written.map((row) => row.imageId)).toEqual([2, 1]);
  });

  it('defers to the caller when there is nothing to compare', async () => {
    await expect(pairwiseLadderEngine.selectWinners(ctx, [entry(1)], 3)).resolves.toBeNull();
  });
});
