/**
 * The ordering algorithms behind the pairwise judging engine. Pure: every comparison is asked of
 * the injected `bout`, so these run in tests against a fake comparator with no LLM and no DB.
 */

export type BoutResult = 'challenger' | 'opponent' | 'tie';

/** Which seat the CHALLENGER takes: 1 = shown first, 2 = shown second. */
export type Seat = 1 | 2;

/**
 * Decide one bout. The seat is decided here and passed explicitly — never derived downstream from
 * a shared counter, which is a race as soon as two bouts are in flight at once.
 */
export type Bout = (challengerId: number, opponentId: number, seat: Seat) => Promise<BoutResult>;

export type SlotResult = { index: number; bouts: number };

/**
 * Binary-search `challengerId` into an ordered `list` (best first). A tie places the challenger
 * below the incumbent — an entry has to actually win to climb.
 */
export async function findSlot(
  challengerId: number,
  list: readonly number[],
  bout: Bout
): Promise<SlotResult> {
  let lo = 0;
  let hi = list.length;
  let step = 0;
  // The search halves its window every step, so this ceiling is unreachable unless the loop stops
  // converging. Throwing beats spinning: a microtask loop starves the macrotask queue and a
  // vitest timeout would never fire.
  const ceiling = 2 * Math.ceil(Math.log2(list.length + 2)) + 4;
  while (lo < hi) {
    if (step >= ceiling) throw new Error(`findSlot did not converge after ${step} bouts`);
    const mid = (lo + hi) >> 1;
    // Seats alternate down the search so the second-seat advantage does not accumulate against
    // whichever entry is always the challenger.
    const result = await bout(challengerId, list[mid], step % 2 === 0 ? 1 : 2);
    if (result === 'challenger') hi = mid;
    else lo = mid + 1;
    step++;
  }
  return { index: lo, bouts: step };
}

/** Place `challengerId` into `list` at the index `findSlot` chose. Returns a new array. */
export function spliceAt(list: readonly number[], challengerId: number, index: number): number[] {
  const next = list.filter((id) => id !== challengerId);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, challengerId);
  return next;
}

/**
 * The second run: pull every entry out and re-insert it against the finished ladder. Measured on
 * the prototype this takes worst-case misplacement from 3 places to 1, which per-bout confirmation
 * does not buy. It is also the repair pass — an entry that never got placed on arrival is placed
 * here, which is what makes the coverage assertion at the call site meaningful.
 */
export async function reinsertAll(
  order: readonly number[],
  bout: Bout
): Promise<{ order: number[]; bouts: number }> {
  // Each entry is re-inserted into the LIVE order rather than scored against the original and
  // re-sorted at the end. The prototype did the latter and two entries that searched to the same
  // index then kept their arrival order, which is the misplacement this pass exists to fix.
  let current = [...order];
  let bouts = 0;
  for (const id of order) {
    const others = current.filter((x) => x !== id);
    const slot = await findSlot(id, others, bout);
    bouts += slot.bouts;
    current = spliceAt(others, id, slot.index);
  }
  return { order: current, bouts };
}

/**
 * Standings that cover a subset of the field are not a result — they are a result-shaped subset,
 * and reading one as the challenge outcome is exactly how a run that lost 54 of 284 entries to a
 * content refusal still printed a tidy ladder. Throw with both counts rather than logging.
 */
export function assertLadderCoverage(
  challengeId: number,
  order: readonly number[],
  eligibleImageIds: readonly number[]
): void {
  const covered = new Set(order);
  const missing = eligibleImageIds.filter((id) => !covered.has(id));
  if (!missing.length && covered.size === eligibleImageIds.length) return;
  throw new Error(
    `Pairwise standings cover ${covered.size} of ${eligibleImageIds.length} eligible entries for ` +
      `challenge ${challengeId}; missing ${missing.slice(0, 10).join(', ') || 'none'}`
  );
}

export type PodiumBout = {
  imageIdA: number;
  imageIdB: number;
  winnerImageId: number | null;
};

export type PodiumRow = {
  imageId: number;
  wins: number;
  games: number;
  winRate: number;
};

/**
 * Round-robin standings over the shortlist. The ladder nominates contenders; this decides places,
 * because at field scale the ladder alone put only 7 of the true top 10 inside its own top 10.
 * A tie scores half a win to each side rather than being discarded.
 *
 * `seatsPerPair` is asserted, not assumed. This stage decides money, and a win RATE is a ratio
 * that stays plausible while its denominator quietly shrinks — a contender who played half its
 * bouts still reports a tidy percentage. The bouts are written through an `ON CONFLICT DO
 * NOTHING`, so a duplicated pair+seat is discarded at the database and never raises anything;
 * counting the games is what makes that visible instead of merely cheaper.
 */
export function tallyPodium(
  contenders: readonly number[],
  bouts: readonly PodiumBout[],
  ladderRank: (imageId: number) => number,
  seatsPerPair: 1 | 2
): PodiumRow[] {
  const tally = new Map(contenders.map((id) => [id, { wins: 0, games: 0 }]));
  for (const bout of bouts) {
    const a = tally.get(bout.imageIdA);
    const b = tally.get(bout.imageIdB);
    if (!a || !b) continue;
    a.games++;
    b.games++;
    if (bout.winnerImageId === bout.imageIdA) a.wins++;
    else if (bout.winnerImageId === bout.imageIdB) b.wins++;
    else {
      a.wins += 0.5;
      b.wins += 0.5;
    }
  }
  const expected = (contenders.length - 1) * seatsPerPair;
  const short = contenders.filter((id) => tally.get(id)!.games !== expected);
  if (short.length) {
    const detail = short
      .slice(0, 5)
      .map((id) => `${id} played ${tally.get(id)!.games}`)
      .join(', ');
    throw new Error(
      `Podium is incomplete: ${short.length} of ${contenders.length} contenders did not play ` +
        `${expected} bouts (${detail}). A win rate over a short denominator still looks like a result.`
    );
  }

  return contenders
    .map((imageId) => {
      const row = tally.get(imageId)!;
      return { imageId, ...row, winRate: row.games ? row.wins / row.games : 0 };
    })
    .sort((a, b) => b.winRate - a.winRate || ladderRank(a.imageId) - ladderRank(b.imageId));
}

/** Every unordered pair of a shortlist, for the podium round-robin. */
export function roundRobinPairs(contenders: readonly number[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < contenders.length; i++) {
    for (let j = i + 1; j < contenders.length; j++) pairs.push([contenders[i], contenders[j]]);
  }
  return pairs;
}
