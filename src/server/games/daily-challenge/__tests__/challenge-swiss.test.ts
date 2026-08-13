import { describe, expect, it } from 'vitest';
import {
  allowance,
  BAND_SIZE,
  countFreshPairs,
  DEFAULT_BOUT_BUDGET,
  GROUP_SIZE,
  MAX_CALLS_PER_TICK,
  planGroups,
  RELATIONS_PER_CALL,
  relationsFromRanking,
  strength,
  swissStandings,
  tickCallBudget,
} from '~/server/games/daily-challenge/challenge-swiss';

/**
 * These test the PAIRING RULE, which is where every measured failure of this structure lived. Each
 * case is written so that reverting the thing it protects prints something a reader can act on —
 * a named entry, a pair, a count — rather than timing out or passing vacuously.
 */

const entries = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ imageId: offset + i + 1 }));

const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Plays every group a plan produces, best-first by imageId so the outcome is deterministic. */
function play(
  groups: { imageId: number }[][],
  wins: Map<number, number>,
  games: Map<number, number>,
  played: Set<string>
) {
  for (const group of groups) {
    const ordered = [...group].sort((a, b) => a.imageId - b.imageId);
    for (let i = 0; i < ordered.length; i++)
      for (let j = i + 1; j < ordered.length; j++) {
        const key = pairKey(ordered[i].imageId, ordered[j].imageId);
        if (played.has(key)) continue;
        played.add(key);
        wins.set(ordered[i].imageId, (wins.get(ordered[i].imageId) ?? 0) + 1);
        games.set(ordered[i].imageId, (games.get(ordered[i].imageId) ?? 0) + 1);
        games.set(ordered[j].imageId, (games.get(ordered[j].imageId) ?? 0) + 1);
      }
  }
}

describe('pacing', () => {
  it('never lets an entry exceed its clock-paced allowance', () => {
    const pool = entries(48);
    const wins = new Map<number, number>();
    const games = new Map<number, number>();
    const played = new Set<string>();

    // A tenth of the way in. Reverting the pacing line makes the ceiling the full budget, so an
    // entry reaches 9 comparisons on the first ticks and this fails naming the entry and its count.
    const progress = 0.1;
    for (let tick = 0; tick < 20; tick++) {
      const groups = planGroups({
        pool,
        wins,
        games,
        played,
        progress,
        budget: DEFAULT_BOUT_BUDGET,
        maxGroups: 8,
      });
      play(groups, wins, games, played);
    }

    const cap = allowance(progress, DEFAULT_BOUT_BUDGET);
    const over = [...games.entries()].filter(([, count]) => count > cap);
    expect({ cap, over }).toEqual({ cap, over: [] });
  });

  it('lets a brand new entry start immediately rather than waiting for the clock', () => {
    expect(allowance(0, DEFAULT_BOUT_BUDGET)).toBe(GROUP_SIZE - 1);
  });

  it('opens the full budget at close', () => {
    expect(allowance(1, DEFAULT_BOUT_BUDGET)).toBe(DEFAULT_BOUT_BUDGET);
  });
});

describe('tick call budget', () => {
  const field = 476;

  it('spends nothing when it is already ahead of the clock', () => {
    // Half the challenge gone, but the whole job's calls already done.
    const total = Math.ceil((field * DEFAULT_BOUT_BUDGET) / 2 / RELATIONS_PER_CALL);
    expect(
      tickCallBudget({
        fieldSize: field,
        callsSoFar: total,
        progress: 0.5,
        budget: DEFAULT_BOUT_BUDGET,
      })
    ).toBe(0);
  });

  it('releases roughly a quarter of the work by a quarter elapsed', () => {
    const total = Math.ceil((field * DEFAULT_BOUT_BUDGET) / 2 / RELATIONS_PER_CALL);
    const due = tickCallBudget({
      fieldSize: field,
      callsSoFar: 0,
      progress: 0.25,
      budget: DEFAULT_BOUT_BUDGET,
    });
    // Capped by the per-tick ceiling, so assert the ceiling bound it rather than the clock.
    expect(due).toBe(Math.min(MAX_CALLS_PER_TICK, Math.ceil(total * 0.25)));
  });

  /**
   * Coverage of the self-correcting property, not a revert guard: rewriting the budget as
   * "remaining work / ticks remaining" keeps this green (both sides shrink together) and is caught
   * by the quarter-elapsed test above instead. Verified by mutation, not assumed.
   */
  it('catches up after skipped ticks instead of losing that work', () => {
    const behind = tickCallBudget({
      fieldSize: field,
      callsSoFar: 0,
      progress: 0.3,
      budget: DEFAULT_BOUT_BUDGET,
    });
    const onPace = tickCallBudget({
      fieldSize: field,
      callsSoFar: Math.ceil(((field * DEFAULT_BOUT_BUDGET) / 2 / RELATIONS_PER_CALL) * 0.29),
      progress: 0.3,
      budget: DEFAULT_BOUT_BUDGET,
    });
    expect(behind).toBeGreaterThan(onPace);
  });

  it('never exceeds the per-tick safety ceiling', () => {
    expect(
      tickCallBudget({
        fieldSize: 100_000,
        callsSoFar: 0,
        progress: 1,
        budget: DEFAULT_BOUT_BUDGET,
      })
    ).toBe(MAX_CALLS_PER_TICK);
  });
});

describe('sort key', () => {
  it('orders by strength, not by games played', () => {
    // `weak` has played least, `strong` has played most and won everything. Sorting by games first
    // would put `weak` at the front of the table; sorting by strength puts `strong` there.
    const wins = new Map([
      [1, 6],
      [2, 0],
    ]);
    const games = new Map([
      [1, 6],
      [2, 1],
    ]);
    expect(strength(1, wins, games)).toBeGreaterThan(strength(2, wins, games));
  });

  /**
   * 🔴 The two tests above exercise `strength()`, NOT the rule. Mutating `planGroups` to sort by
   * games-played first — the exact revert that measured top-1 0.30 against synchronised Swiss's
   * 0.775 — left all of them green. This is the one that catches it: the two orderings are made to
   * disagree completely, so the first group is drawn from opposite ends of the pool under each.
   */
  it('draws the first group from the STRONGEST entries, not the least-played', () => {
    const strong = entries(8); // ids 1-8: won 6 of 6
    const weak = entries(8, 8); // ids 9-16: never played
    const wins = new Map(strong.map((e) => [e.imageId, 6]));
    const games = new Map(strong.map((e) => [e.imageId, 6]));

    const groups = planGroups({
      pool: [...strong, ...weak],
      wins,
      games,
      played: new Set(),
      progress: 1,
      budget: DEFAULT_BOUT_BUDGET,
      maxGroups: 1,
    });

    const strongIds = new Set(strong.map((e) => e.imageId));
    const first = groups[0].map((e) => e.imageId);
    // Sorting by games first puts the eight unplayed entries at the front, so this prints ids in
    // the 9-16 range and names the revert.
    expect(first.filter((id) => !strongIds.has(id))).toEqual([]);
  });

  it('puts an unplayed entry mid-table, not at the bottom with the genuinely bad', () => {
    const wins = new Map([
      [1, 0],
      [3, 5],
    ]);
    const games = new Map([
      [1, 8],
      [3, 5],
    ]);
    const unplayed = strength(2, wins, new Map());
    expect(unplayed).toBeGreaterThan(strength(1, wins, games));
    expect(unplayed).toBeLessThan(strength(3, wins, games));
  });
});

describe('band mixing', () => {
  /**
   * 🔴 The opponent-count test below does NOT catch removing the shuffle: over repeated passes the
   * strength table reorders anyway, so entries meet new opponents regardless. This one does, and it
   * is deterministic — with every entry tied on strength and games the sort is stable, so without
   * the shuffle the first group is exactly the first GROUP_SIZE of the pool.
   */
  it('does not take the first group straight off the top of the table', () => {
    const pool = entries(BAND_SIZE * 2);
    const groups = planGroups({
      pool,
      wins: new Map(),
      games: new Map(),
      played: new Set(),
      progress: 1,
      budget: DEFAULT_BOUT_BUDGET,
      maxGroups: 1,
    });
    const straightOffTheTop = pool.slice(0, GROUP_SIZE).map((e) => e.imageId);
    expect(groups[0].map((e) => e.imageId)).not.toEqual(straightOffTheTop);
  });

  it('gives an entry more than GROUP_SIZE - 1 distinct opponents', () => {
    const pool = entries(BAND_SIZE * 3);
    const wins = new Map<number, number>();
    const games = new Map<number, number>();
    const played = new Set<string>();

    for (let tick = 0; tick < 12; tick++) {
      const groups = planGroups({
        pool,
        wins,
        games,
        played,
        progress: 1,
        budget: DEFAULT_BOUT_BUDGET,
        maxGroups: 6,
      });
      if (!groups.length) break;
      play(groups, wins, games, played);
    }

    const opponents = new Map<number, Set<number>>();
    for (const key of played) {
      const [a, b] = key.split(':').map(Number);
      if (!opponents.has(a)) opponents.set(a, new Set());
      if (!opponents.has(b)) opponents.set(b, new Set());
      opponents.get(a)!.add(b);
      opponents.get(b)!.add(a);
    }

    // Coverage, not a revert guard: removing the shuffle leaves this green, which is why the test
    // above exists. Keep it as a floor on how much the field actually mixes.
    const fewest = Math.min(...[...opponents.values()].map((set) => set.size));
    expect(fewest).toBeGreaterThan(GROUP_SIZE - 1);
  });
});

describe('no wasted calls', () => {
  it('never proposes a group whose every pair is already owned', () => {
    const pool = entries(GROUP_SIZE);
    const played = new Set<string>();
    for (let i = 0; i < GROUP_SIZE; i++)
      for (let j = i + 1; j < GROUP_SIZE; j++)
        played.add(pairKey(pool[i].imageId, pool[j].imageId));

    const groups = planGroups({
      pool,
      wins: new Map(),
      games: new Map(),
      played,
      progress: 1,
      budget: DEFAULT_BOUT_BUDGET,
      maxGroups: 4,
    });
    expect(groups).toEqual([]);
  });

  it('drops relations for pairs already owned rather than re-recording them', () => {
    const played = new Set([pairKey(1, 2)]);
    const relations = relationsFromRanking([1, 2, 3], played);
    expect(relations).toEqual([
      { winnerImageId: 1, loserImageId: 3 },
      { winnerImageId: 2, loserImageId: 3 },
    ]);
  });

  it('counts fresh pairs in a group', () => {
    const group = entries(GROUP_SIZE);
    expect(countFreshPairs(group, new Set())).toBe((GROUP_SIZE * (GROUP_SIZE - 1)) / 2);
  });
});

describe('the settle loop terminates', () => {
  /**
   * 🔴 The close-time settle in the engine repeats `planGroups` until it returns nothing. If it
   * could keep returning groups forever the engine would spin in a pure microtask loop, which
   * vitest's setTimeout-based testTimeout CANNOT observe — the run hangs with no assertion and no
   * timeout. So this asserts the plan goes empty on its own, under a cap, and fails fast if it
   * does not.
   */
  it('runs dry within the budget rather than looping forever', () => {
    const pool = entries(GROUP_SIZE * 3);
    const wins = new Map<number, number>();
    const games = new Map<number, number>();
    const played = new Set<string>();

    const CAP = 200;
    let passes = 0;
    while (passes < CAP) {
      const groups = planGroups({
        pool,
        wins,
        games,
        played,
        progress: 1,
        budget: DEFAULT_BOUT_BUDGET,
        maxGroups: 8,
      });
      if (!groups.length) break;
      play(groups, wins, games, played);
      passes++;
    }
    expect(passes).toBeLessThan(CAP);
  });
});

describe('standings', () => {
  it('ranks by win rate, so a late arrival is not punished for owing fewer comparisons', () => {
    const pool = entries(2);
    // Entry 1: 2 wins from 8. Entry 2: 2 wins from 2. Raw wins tie; the rate does not.
    const wins = new Map([
      [1, 2],
      [2, 2],
    ]);
    const games = new Map([
      [1, 8],
      [2, 2],
    ]);
    expect(swissStandings(pool, wins, games).map((e) => e.imageId)).toEqual([2, 1]);
  });
});
