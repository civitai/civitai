import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Pairwise from '~/server/games/daily-challenge/challenge-pairwise';
import type * as Store from '~/server/games/daily-challenge/challenge-pairwise-store';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';

// The playground exists to answer "what would this challenge's ranking have been" WITHOUT changing
// the challenge. That is a claim about writes that never happen, so it is asserted rather than
// documented: the store and the spend counter are real modules here, doubled only so the test can
// see that nothing reached them.

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: queryRaw },
  dbWrite: { $queryRaw: queryRaw, $executeRaw: vi.fn(), $transaction: vi.fn() },
}));

vi.mock('~/server/games/daily-challenge/challenge-pairwise-store', async (importOriginal) => ({
  ...(await importOriginal<typeof Store>()),
  getStandings: vi.fn(),
  insertStanding: vi.fn(),
  replaceStandings: vi.fn(),
  recordComparison: vi.fn(),
  getComparisons: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeHelpers>()),
  incrementOperationSpent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/games/daily-challenge/challenge-pairwise', async (importOriginal) => ({
  ...(await importOriginal<typeof Pairwise>()),
  comparePair: vi.fn(),
}));

const store = vi.mocked(await import('~/server/games/daily-challenge/challenge-pairwise-store'));
const { comparePair } = vi.mocked(
  await import('~/server/games/daily-challenge/challenge-pairwise')
);
const { incrementOperationSpent } = vi.mocked(
  await import('~/server/games/daily-challenge/challenge-helpers')
);
const { runLadderDryRun } = await import(
  '~/server/games/daily-challenge/challenge-ladder-playground'
);
const { FIXED_JUDGING_CATEGORIES } = await import(
  '~/server/games/daily-challenge/daily-challenge-scoring'
);

const field = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    imageId: i + 1,
    userId: (i + 1) * 100,
    username: `u${i + 1}`,
  }));

/** Lower imageId is the better entry, so the true order of any field is ascending. */
function trueOrder(buzzPerBout = 0.5) {
  comparePair.mockImplementation(async ({ challenger, opponent, seat }) => ({
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
    buzzCost: buzzPerBout,
  }));
}

const run = (entries = field(6), over: Record<string, unknown> = {}) =>
  runLadderDryRun({
    challengeId: 424,
    entries,
    theme: 'Neon Dreams',
    categories: FIXED_JUDGING_CATEGORIES,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  trueOrder();
  queryRaw.mockImplementation(async () =>
    Array.from({ length: 80 }, (_, i) => ({ imageId: i + 1, url: `uuid-${i + 1}`, nsfwLevel: 1 }))
  );
});

describe('runLadderDryRun — touches no challenge state', () => {
  it('writes no standings', async () => {
    await run();
    expect(store.insertStanding).not.toHaveBeenCalled();
    expect(store.replaceStandings).not.toHaveBeenCalled();
  });

  it('writes no comparison rows', async () => {
    await run();
    expect(store.recordComparison).not.toHaveBeenCalled();
  });

  it('does not read the challenge standings either — a dry run must not depend on prior runs', async () => {
    // If it seeded from stored comparisons, two dry runs of the same challenge would disagree, and
    // the second would be cheaper for reasons the operator cannot see.
    await run();
    expect(store.getStandings).not.toHaveBeenCalled();
    expect(store.getComparisons).not.toHaveBeenCalled();
  });

  it('charges nothing to the challenge, even though the comparisons were real', async () => {
    const result = await run();
    expect(incrementOperationSpent).not.toHaveBeenCalled();
    // The Buzz was still spent with the provider — it is reported, not hidden.
    expect(result.buzz).toBeGreaterThan(0);
  });
});

describe('runLadderDryRun — the answer', () => {
  it('returns the ladder order the engine would have produced', async () => {
    const result = await run(field(6));
    expect(result.standings.map((s) => s.imageId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.standings[0]).toMatchObject({ rank: 1, userId: 100, username: 'u1' });
  });

  it('reports what the run cost, so a bigger one can be judged before it is started', async () => {
    const result = await run(field(6));
    expect(result.comparisons).toBeGreaterThan(0);
    expect(result.buzz).toBeCloseTo(result.comparisons * 0.5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('honours a smaller K, which is the point of being able to try one', async () => {
    const wide = field(20);
    const bounded = await run(wide, { topK: 4, includePodium: false });
    const looser = await run(wide, { topK: 12, includePodium: false });
    expect(bounded.topK).toBe(4);
    expect(bounded.comparisons).toBeLessThan(looser.comparisons);
  });

  it('runs the podium by default and can be asked not to', async () => {
    const withPodium = await run(field(6));
    expect(withPodium.podium.length).toBeGreaterThan(0);
    expect(withPodium.podium[0]).toMatchObject({ rank: 1, imageId: 1 });

    const without = await run(field(6), { includePodium: false });
    expect(without.podium).toEqual([]);
  });

  it('surfaces the same warnings production would raise', async () => {
    const result = await run(field(6));
    expect(result).toHaveProperty('unresolvedGroups');
    expect(result).toHaveProperty('nearBoundary');
    expect(result).toHaveProperty('reroutes');
  });

  it('counts a rerouted comparison, so a refusal-heavy field is visible before opting in', async () => {
    comparePair.mockImplementation(async ({ challenger, opponent, seat }) => ({
      imageIdA: challenger.imageId,
      imageIdB: opponent.imageId,
      firstSeatImageId: seat === 1 ? challenger.imageId : opponent.imageId,
      winnerImageId: Math.min(challenger.imageId, opponent.imageId),
      margin: 'clear',
      perCategory: {},
      reason: 'because',
      model: 'permissive',
      rerouted: true,
      usage: { promptTokens: 10, completionTokens: 1 },
      buzzCost: 1,
    }));

    const result = await run(field(4));

    expect(result.reroutes).toBe(result.comparisons);
  });
});

// A dry run has no arrival placement by construction, so production's `arrivalUsable` guard would
// run this field's rerun UNBOUNDED. Any bounded dry run is therefore partly the legacy order it
// exists to evaluate against — and it said nothing about that. Measured on challenge 424 at
// topK=6: ranks 7-64 were never compared, two of five entries tied at 8.85 reached the
// re-inserted set on a Math.random() tiebreak, and no warning was emitted.
describe('runLadderDryRun — says when its answer is partly the legacy order', () => {
  it('warns, and marks the rows it never measured', async () => {
    const result = await run(field(20), { topK: 6, includePodium: false });

    expect(result.measured).toBe(6);
    expect(result.unmeasured).toBe(14);
    expect(result.warnings.join('\n')).toMatch(/PARTIAL RANKING/);
    expect(result.warnings.join('\n')).toMatch(/Math\.random/);

    expect(result.standings.filter((s) => s.compared)).toHaveLength(6);
    expect(result.standings.filter((s) => !s.compared)).toHaveLength(14);
  });

  it('flags a podium drawn from entries that were never re-inserted', async () => {
    const result = await run(field(20), { topK: 6 });

    expect(result.warnings.join('\n')).toMatch(/PODIUM DRAWN FROM UNRANKED ENTRIES/);
  });

  it('stays quiet when the whole field was measured — a warning that always fires is noise', async () => {
    const result = await run(field(6), { topK: 6 });

    expect(result.measured).toBe(6);
    expect(result.unmeasured).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.standings.every((s) => s.compared)).toBe(true);
  });
});
