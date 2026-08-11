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
 * In-flight comparisons at close. Sized against MEASURED two-image bout latency — 9s median on the
 * blend, 12.4s on the self-hosted route with a 56s worst case — not against a mock. The harness ran
 * this stage at 12-16 against OpenRouter without rate-limiting.
 */
export const LADDER_CONCURRENCY = 16;

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
    // Seats alternate down the search, and the parity is SEEDED from the challenger so that the
    // opening bout — the highest-leverage comparison of a binary search, and the only one every
    // search makes — is not always seat 1. `step` restarts at 0 for each entry, so parity alone
    // would put every challenger in the first seat on its most consequential comparison.
    const seat: Seat = (step + challengerId) % 2 === 0 ? 1 : 2;
    const result = await bout(challengerId, list[mid], seat);
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
 * Bounded-concurrency map that STOPS on the first failure and then waits for the work already in
 * flight before throwing.
 *
 * Not `limitConcurrency`: that one rejects its promise from the catch but still calls `run()` in
 * the `finally`, so the pool keeps dispatching the entire remaining job list after the caller has
 * already resumed. For a pool whose tasks cost money that is unbounded spend nothing is left to
 * account for — measured at 11x under-counted on a 210-bout stage that failed at bout 20.
 */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;

  const lane = async () => {
    while (next < items.length && failure === undefined) {
      const i = next++;
      try {
        out[i] = await worker(items[i], i);
      } catch (error) {
        failure ??= error;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failure !== undefined) throw failure;
  return out;
}

/**
 * The second run: pull every entry out and re-insert it against the finished ladder. Measured on
 * the prototype this takes worst-case misplacement from 3 places to 1, which per-bout confirmation
 * does not buy. It is also the repair pass — an entry that never got placed on arrival is placed
 * here, which is what makes the coverage assertion at the call site meaningful.
 *
 * Every entry searches the SAME frozen order, concurrently. That is sound only because this pass
 * does not mutate the list it searches — unlike arrival, where each insertion has to see the live
 * standings. Serially it is one LLM round-trip deep per bout: ~90 minutes for a 284-entry field,
 * which outlives the 10-minute completion claim and lets a second run start a second podium.
 */
export async function reinsertAll(
  order: readonly number[],
  bout: Bout,
  concurrency = LADDER_CONCURRENCY,
  maxPasses = 4
): Promise<{ order: number[]; bouts: number; passes: number }> {
  let current = [...order];
  let bouts = 0;
  let passes = 0;

  // A binary search is only meaningful against a roughly-ordered list, and one concurrent pass
  // over a badly-ordered one improves it without finishing the job — which matters because
  // `rankField` appends entries the arrival pass never placed, and a challenge opted in near its
  // close has a starting order that is arbitrary. Repeat until the order stops moving. Passes
  // after the first are nearly free: every pair they ask for has already been answered and the
  // caller's cache returns it without a comparison.
  while (passes < maxPasses) {
    const pass = await reinsertOnce(current, bout, concurrency);
    passes++;
    bouts += pass.bouts;
    const settled =
      pass.order.length === current.length && pass.order.every((id, i) => id === current[i]);
    current = pass.order;
    if (settled) break;
  }

  return { order: current, bouts, passes };
}

async function reinsertOnce(
  order: readonly number[],
  bout: Bout,
  concurrency: number
): Promise<{ order: number[]; bouts: number }> {
  const frozen = [...order];
  const placed = await runPool(frozen, concurrency, async (id) => {
    const others = frozen.filter((x) => x !== id);
    const slot = await findSlot(id, others, bout);
    return { id, key: slot.index, bouts: slot.bouts };
  });

  // Searching a frozen list means two entries can land on the same index, and their order relative
  // to each other is then genuinely unmeasured. The prototype resolved that by arrival order,
  // which is the misplacement this pass exists to remove. They all belong between the same two
  // neighbours, so ordering them among themselves — and only them — settles it. Groups are small
  // and the extra bouts are few.
  const groups = new Map<number, number[]>();
  for (const row of placed) {
    if (!groups.has(row.key)) groups.set(row.key, []);
    groups.get(row.key)!.push(row.id);
  }

  let bouts = placed.reduce((sum, row) => sum + row.bouts, 0);
  const result: number[] = [];
  for (const key of [...groups.keys()].sort((a, b) => a - b)) {
    const tied = groups.get(key)!;
    if (tied.length === 1) {
      result.push(tied[0]);
      continue;
    }
    let settled: number[] = [];
    for (const id of tied) {
      const slot = await findSlot(id, settled, bout);
      bouts += slot.bouts;
      settled = spliceAt(settled, id, slot.index);
    }
    result.push(...settled);
  }

  return { order: result, bouts };
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
