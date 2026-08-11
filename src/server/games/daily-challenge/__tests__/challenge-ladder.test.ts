import { describe, expect, it } from 'vitest';
import {
  assertLadderCoverage,
  findSlot,
  reinsertAll,
  roundRobinPairs,
  runPool,
  spliceAt,
  tallyPodium,
  type Bout,
  type Seat,
} from '~/server/games/daily-challenge/challenge-ladder';

/**
 * A comparator with a known true order: the lower id is the better entry. Counts its bouts so a
 * test can assert a search stayed logarithmic instead of walking the ladder.
 */
function trueOrderBout() {
  const seats: { challenger: number; opponent: number; seat: Seat }[] = [];
  const bout: Bout = async (challenger, opponent, seat) => {
    seats.push({ challenger, opponent, seat });
    return challenger < opponent ? 'challenger' : 'opponent';
  };
  return { bout, seats };
}

describe('findSlot', () => {
  it('binary-searches an entry into its true place', async () => {
    const ladder = [10, 20, 30, 40, 50];
    const { bout, seats } = trueOrderBout();

    const { index, bouts } = await findSlot(35, ladder, bout);

    expect(index).toBe(3);
    expect(spliceAt(ladder, 35, index)).toEqual([10, 20, 30, 35, 40, 50]);
    expect(bouts).toBe(seats.length);
    expect(bouts).toBeLessThanOrEqual(3);
  });

  it('places a tie below the incumbent — an entry has to win to climb', async () => {
    const alwaysTie: Bout = async () => 'tie';
    const { index } = await findSlot(99, [1, 2, 3], alwaysTie);
    expect(index).toBe(3);
  });

  it('places into an empty ladder without asking for a comparison', async () => {
    const { bout, seats } = trueOrderBout();
    const { index } = await findSlot(7, [], bout);
    expect(index).toBe(0);
    expect(seats).toHaveLength(0);
  });

  it('stays logarithmic on a full-size field, and terminates on a self-contradicting judge', async () => {
    // 300 entries is a real challenge field. A search that degraded to a walk would cost ~300
    // paid comparisons per arrival, so the bout count is the thing worth pinning — and an
    // inconsistent comparator must still terminate rather than spin: a microtask loop starves the
    // macrotask queue, so vitest's setTimeout-based testTimeout would never fire and CI would hang.
    const ladder = Array.from({ length: 300 }, (_, i) => (i + 1) * 10);
    let flip = false;
    const inconsistent: Bout = async () => {
      flip = !flip;
      return flip ? 'challenger' : 'opponent';
    };

    const { bouts } = await findSlot(1, ladder, inconsistent);

    expect(bouts).toBeLessThanOrEqual(Math.ceil(Math.log2(ladder.length)) + 1);
  });
});

describe('reinsertAll', () => {
  // The second run is a repair pass over a roughly-ordered ladder, not a sort: each entry
  // binary-searches the others, which only means anything while the list is close to ordered.
  it('repairs an entry the arrival pass misplaced', async () => {
    // 60 arrived early against a short ladder and sits above five entries that all beat it.
    const { bout } = trueOrderBout();
    const { order } = await reinsertAll([60, 10, 20, 30, 40, 50], bout);
    expect(order).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('leaves an already-correct ladder alone', async () => {
    const { bout } = trueOrderBout();
    const { order } = await reinsertAll([10, 20, 30, 40, 50], bout);
    expect(order).toEqual([10, 20, 30, 40, 50]);
  });

  it('places an entry that was appended with no arrival placement at all', async () => {
    // What the repair pass exists for: an entry whose arrival comparison failed is put on the end
    // by rankField and has to find its real place here.
    const { bout } = trueOrderBout();
    const { order } = await reinsertAll([10, 20, 40, 50, 30], bout);
    expect(order).toEqual([10, 20, 30, 40, 50]);
  });

  it('searches concurrently — serially this outlives the completion claim', async () => {
    // One LLM round-trip deep per bout, serially, is ~90 minutes for a 284-entry field. The
    // completion claim is reclaimed after 10, so a second run starts a second podium and a
    // second path to createChallengeWinner. Concurrency is what keeps the stage inside the claim.
    let inFlight = 0;
    let peak = 0;
    const slowBout: Bout = async (challenger, opponent) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return challenger < opponent ? 'challenger' : 'opponent';
    };

    const { order } = await reinsertAll([80, 10, 60, 20, 70, 30, 50, 40], slowBout, 4);

    expect(peak).toBeGreaterThan(1);
    expect(order).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it('converges from an arbitrary order, which is what a late opt-in hands it', async () => {
    // rankField appends entries the arrival pass never placed. A challenge switched to this
    // engine near its close has no arrival placements at all, so the starting order is whatever
    // the query returned — and one pass over that improves it without finishing.
    const { bout } = trueOrderBout();
    const scrambled = [70, 30, 90, 10, 50, 20, 80, 40, 60];

    const { order, passes } = await reinsertAll(scrambled, bout, 4);

    expect(order).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(passes).toBeGreaterThan(1);
  });

  it('stops as soon as the order settles rather than always paying for every pass', async () => {
    const { bout } = trueOrderBout();
    const { passes } = await reinsertAll([10, 20, 30, 40, 50], bout, 4);
    expect(passes).toBe(1);
  });

  it('resolves entries that searched to the same slot by comparing them, not by arrival order', async () => {
    // Concurrent searches all read the same frozen list, so ties on the index are expected. The
    // prototype broke them by arrival order, which is the misplacement this pass exists to fix.
    const { bout } = trueOrderBout();
    const { order } = await reinsertAll([10, 20, 30, 55, 54, 53], bout, 4);
    expect(order.indexOf(53)).toBeLessThan(order.indexOf(54));
    expect(order.indexOf(54)).toBeLessThan(order.indexOf(55));
  });

  it('returns every entry it was given', async () => {
    const { bout } = trueOrderBout();
    const field = [5, 1, 4, 2, 3];
    const { order } = await reinsertAll(field, bout);
    expect([...order].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('assertLadderCoverage', () => {
  it('passes when the standings cover the whole field', () => {
    expect(() => assertLadderCoverage(1, [3, 1, 2], [1, 2, 3])).not.toThrow();
  });

  it('fails loudly, naming the missing entries, when an entry never reached the ladder', () => {
    expect(() => assertLadderCoverage(424, [1, 2], [1, 2, 3, 4])).toThrow(
      /cover 2 of 4 eligible entries for challenge 424; missing 3, 4/
    );
  });
});

describe('tallyPodium', () => {
  const rank = (id: number) => id;

  it('orders by win rate and splits a tie between both entries', () => {
    const table = tallyPodium(
      [1, 2, 3],
      [
        { imageIdA: 1, imageIdB: 2, winnerImageId: 1 },
        { imageIdA: 1, imageIdB: 3, winnerImageId: 1 },
        { imageIdA: 2, imageIdB: 3, winnerImageId: null },
      ],
      rank,
      1
    );

    expect(table.map((row) => row.imageId)).toEqual([1, 2, 3]);
    expect(table[0]).toMatchObject({ wins: 2, games: 2, winRate: 1 });
    expect(table[1]).toMatchObject({ wins: 0.5, games: 2, winRate: 0.25 });
  });

  it('breaks an equal win rate by ladder rank rather than arbitrarily', () => {
    const table = tallyPodium(
      [9, 4],
      [
        { imageIdA: 9, imageIdB: 4, winnerImageId: 9 },
        { imageIdA: 9, imageIdB: 4, winnerImageId: 4 },
      ],
      rank,
      2
    );
    expect(table.map((row) => row.imageId)).toEqual([4, 9]);
  });

  it('refuses to rank a shortlist whose bouts did not all happen', () => {
    // A bout naming an entry outside the shortlist is not a bout this shortlist played, so both
    // contenders are short of their games. Returning a table of zeroes here would hand the caller
    // a win rate computed from nothing, which reads exactly like a real result.
    expect(() =>
      tallyPodium([1, 2], [{ imageIdA: 1, imageIdB: 99, winnerImageId: 99 }], rank, 1)
    ).toThrow(/Podium is incomplete: 2 of 2 contenders did not play 1 bouts/);
  });

  it('refuses a shortlist that played one seat when it was told to play two', () => {
    expect(() =>
      tallyPodium([1, 2], [{ imageIdA: 1, imageIdB: 2, winnerImageId: 1 }], rank, 2)
    ).toThrow(/did not play 2 bouts/);
  });
});

describe('roundRobinPairs', () => {
  it('pairs every contender with every other exactly once', () => {
    expect(roundRobinPairs([1, 2, 3, 4])).toHaveLength(6);
    expect(roundRobinPairs([1, 2, 3])).toEqual([
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
  });
});

describe('runPool', () => {
  it('runs with real concurrency rather than one at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    await runPool(
      Array.from({ length: 24 }, (_, i) => i),
      6,
      async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 3));
        inFlight--;
      }
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it('stops dispatching after a failure instead of running the whole list', async () => {
    // limitConcurrency rejects from its catch but its finally still calls run(), so the pool
    // drains the entire job list behind an already-resumed caller. For bouts that cost money,
    // that is spend arriving after the stage has settled its accounting.
    const started: number[] = [];
    await expect(
      runPool(
        Array.from({ length: 100 }, (_, i) => i),
        4,
        async (item) => {
          started.push(item);
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (item === 3) throw new Error('boom');
        }
      )
    ).rejects.toThrow('boom');

    expect(started.length).toBeLessThan(20);
  });

  it('waits for work already in flight before throwing', async () => {
    let finished = 0;
    await expect(
      runPool([0, 1, 2, 3], 4, async (item) => {
        await new Promise((resolve) => setTimeout(resolve, item === 0 ? 1 : 20));
        if (item === 0) throw new Error('boom');
        finished++;
      })
    ).rejects.toThrow('boom');

    // The three slow lanes were already running; none of them is still pending after the throw.
    expect(finished).toBe(3);
  });

  it('reports the FIRST failure, not whichever landed last', async () => {
    await expect(
      runPool([0, 1], 2, async (item) => {
        await new Promise((resolve) => setTimeout(resolve, item === 0 ? 1 : 10));
        throw new Error(item === 0 ? 'first' : 'second');
      })
    ).rejects.toThrow('first');
  });
});

describe('findSlot seating', () => {
  it('does not open every search on the same seat', async () => {
    // `step` restarts at 0 for each entry, so parity alone would seat every challenger first on
    // its OPENING bout — the one comparison every search makes, and the highest-leverage one.
    const openingSeats = new Set<Seat>();
    for (const challenger of [10, 11, 12, 13]) {
      const { bout, seats } = trueOrderBout();
      await findSlot(challenger, [1, 2, 3, 4, 5, 6, 7], bout);
      openingSeats.add(seats[0].seat);
    }
    expect(openingSeats).toEqual(new Set([1, 2]));
  });

  it('still alternates within a single search', async () => {
    const { bout, seats } = trueOrderBout();
    await findSlot(50, [1, 2, 3, 4, 5, 6, 7], bout);
    const alternating = seats.every((s, i) => i === 0 || s.seat !== seats[i - 1].seat);
    expect(alternating).toBe(true);
  });
});
