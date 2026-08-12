import { describe, expect, it } from 'vitest';
import {
  assertLadderCoverage,
  findSlot,
  reinsertTop,
  RERUN_TOP_K,
  LADDER_CONCURRENCY,
  CLAIM_WINDOW_MINUTES,
  projectedCloseMinutes,
  MAX_TIE_GROUP,
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

describe('reinsertTop', () => {
  it('re-inserts only the top K, and leaves the tail at its arrival position', async () => {
    const { bout, seats } = trueOrderBout();
    // A roughly-ordered arrival ladder — which is the precondition a binary search needs — with
    // 50 sitting too high. Only the first 3 are re-inserted.
    const arrival = [10, 20, 50, 30, 40, 60, 70, 80, 90, 100, 110, 120];

    const { order } = await reinsertTop(arrival, bout, 3);

    expect(order.slice(0, 5)).toEqual([10, 20, 30, 40, 50]);
    // Nothing below K searched: every bout has a re-inserted entry as its challenger.
    const rerunSet = new Set([10, 20, 50]);
    expect(seats.every((s) => rerunSet.has(s.challenger))).toBe(true);
  });

  it('lets a re-inserted leader fall past entries that were never re-inserted', async () => {
    const { bout } = trueOrderBout();
    // 90 arrived first but is the weakest; it must end up behind 20 and 30, which are outside K.
    const { order } = await reinsertTop([90, 10, 20, 30], bout, 1);
    expect(order.indexOf(90)).toBeGreaterThan(order.indexOf(30));
  });

  it('costs K searches, not one per entry', async () => {
    const { bout, seats } = trueOrderBout();
    const arrival = Array.from({ length: 60 }, (_, i) => (i + 1) * 10);

    const { bouts } = await reinsertTop(arrival, bout, 10);

    // 10 searches over a 60-long list is ~6 bouts each; a full-field rerun would be ~60 searches.
    expect(bouts).toBe(seats.length);
    expect(bouts).toBeLessThan(10 * 8);
  });

  it('runs the re-insertions concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const slowBout: Bout = async (challenger, opponent) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return challenger < opponent ? 'challenger' : 'opponent';
    };
    await reinsertTop([80, 10, 60, 20, 70, 30, 50, 40], slowBout, 8, 4);
    expect(peak).toBeGreaterThan(1);
  });

  it('leaves an oversized tie group in arrival order instead of resolving it serially', async () => {
    // Every entry ties, so they all land on one key. Resolving that group is a serial chain, and
    // an unbounded chain is unbounded wall clock inside a stage with ~10 minutes to live.
    const alwaysTie: Bout = async () => 'tie';
    const arrival = Array.from({ length: MAX_TIE_GROUP + 4 }, (_, i) => i + 1);

    const { order, unresolvedGroups } = await reinsertTop(arrival, alwaysTie, arrival.length);

    expect(unresolvedGroups).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(arrival);
  });

  it('returns every entry it was given', async () => {
    const { bout } = trueOrderBout();
    const arrival = [5, 1, 4, 2, 3, 9, 7, 8, 6];
    const { order } = await reinsertTop(arrival, bout, 4);
    expect([...order].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('flags a finisher that entered the rerun near the K boundary', async () => {
    const { bout } = trueOrderBout();
    // The strongest entry in the field arrived at rank 17 of a K=20 rerun and finishes first —
    // exactly the case that says K is close to binding.
    const arrival = [
      100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 260, 1, 270,
      280, 290, 300, 310, 320, 330,
    ];

    const { nearBoundary } = await reinsertTop(arrival, bout, 20);

    expect(nearBoundary).toContain(1);
  });

  it('does not flag an entry that arrived comfortably inside K', async () => {
    const { bout } = trueOrderBout();
    const arrival = Array.from({ length: 25 }, (_, i) => (i + 1) * 10);
    const { nearBoundary } = await reinsertTop(arrival, bout, 20);
    expect(nearBoundary).toEqual([]);
  });

  it('stays silent when the rerun is no wider than the shortlist it feeds', async () => {
    // At K <= 15 every re-inserted entry is a potential finalist, so "near the boundary" carries
    // no information and the warning would fire on ordinary runs.
    const { bout } = trueOrderBout();
    const arrival = Array.from({ length: 30 }, (_, i) => (i + 1) * 10);
    const { nearBoundary } = await reinsertTop(arrival, bout, 12);
    expect(nearBoundary).toEqual([]);
  });

  it('keeps K above the arrival rank a finalist was actually observed to need', () => {
    // Challenge 424: every entry that finished in the final top 15 was already inside the arrival
    // top 27. K below that would have excluded a real finalist on the one field we have measured.
    expect(RERUN_TOP_K).toBeGreaterThan(27);
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

  it('treats a thrown `undefined` as a failure, not as a success', async () => {
    // Tracking failure by `value !== undefined` lets exactly one kind of throw through as though
    // the work had succeeded — and the caller then reads `out[i]` as a real result.
    const seen: number[] = [];
    await expect(
      runPool([0, 1, 2, 3, 4, 5, 6, 7], 2, async (item) => {
        seen.push(item);
        await new Promise((resolve) => setTimeout(resolve, 1));
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        if (item === 1) throw undefined;
        return item;
      })
    ).rejects.toBeUndefined();
    expect(seen.length).toBeLessThan(8);
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

describe('close-time concurrency is load-bearing', () => {
  // The gap this closes: changing only the DEFAULT concurrency failed nothing, because every test
  // passed its own. If the default is what keeps the stage inside the completion claim, moving it
  // has to break something.
  const FIELD = 284;

  it('fits the completion claim at the shipped concurrency', () => {
    const minutes = projectedCloseMinutes({ entries: FIELD });
    expect(minutes).toBeLessThan(CLAIM_WINDOW_MINUTES);
  });

  it('does NOT fit at half the shipped concurrency — so this is not a free knob', () => {
    const minutes = projectedCloseMinutes({
      entries: FIELD,
      concurrency: Math.floor(LADDER_CONCURRENCY / 2),
    });
    expect(minutes).toBeGreaterThan(CLAIM_WINDOW_MINUTES);
  });

  it('leaves real headroom rather than scraping the limit', () => {
    // Scraping in means an ordinary slow day for the provider blows the claim. Measured latency is
    // 9s median but 12.4s on the self-hosted route, so require the shipped setting to survive that.
    const slow = projectedCloseMinutes({ entries: FIELD, boutSeconds: 12.4 });
    expect(slow).toBeLessThan(CLAIM_WINDOW_MINUTES);
  });

  // Ranking the whole field instead of one entry per user is a change to the SEARCH DEPTH and
  // nothing else: the rerun is bounded at K, the podium is 15, and arrival already ran per entry.
  // log2(285) = 9 against log2(64) = 6, so ~3 extra bouts per re-inserted entry.
  it('still fits once the full field is ranked rather than one entry per user', () => {
    const FULL_FIELD = 285;
    const DEDUPED_FIELD = 64;

    expect(projectedCloseMinutes({ entries: FULL_FIELD })).toBeLessThan(CLAIM_WINDOW_MINUTES);
    // Still fits at the slow route's latency, which is the number that matters on a bad day.
    expect(projectedCloseMinutes({ entries: FULL_FIELD, boutSeconds: 12.4 })).toBeLessThan(
      CLAIM_WINDOW_MINUTES
    );
    // And it is not free — if the two projections were equal this test would be pinning nothing.
    expect(projectedCloseMinutes({ entries: FULL_FIELD })).toBeGreaterThan(
      projectedCloseMinutes({ entries: DEDUPED_FIELD })
    );
  });

  it('would not fit if the rerun were unbounded', () => {
    // The design change this PR made, as arithmetic: bounding the rerun is what buys the window,
    // not the concurrency alone.
    const unbounded = projectedCloseMinutes({ entries: FIELD, topK: FIELD });
    expect(unbounded).toBeGreaterThan(CLAIM_WINDOW_MINUTES);
  });

  it('actually uses that default when no concurrency is passed', async () => {
    let inFlight = 0;
    let peak = 0;
    const slowBout: Bout = async (challenger, opponent) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return challenger < opponent ? 'challenger' : 'opponent';
    };
    const arrival = Array.from({ length: 40 }, (_, i) => (i + 1) * 10);

    await reinsertTop(arrival, slowBout);

    expect(peak).toBeGreaterThan(Math.floor(LADDER_CONCURRENCY / 2));
  });
});
