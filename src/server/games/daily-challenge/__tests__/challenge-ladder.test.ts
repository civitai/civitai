import { describe, expect, it } from 'vitest';
import {
  assertLadderCoverage,
  findSlot,
  reinsertAll,
  roundRobinPairs,
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
