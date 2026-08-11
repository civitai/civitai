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
  // A separate flag rather than `failure !== undefined`: a worker is allowed to throw `undefined`,
  // and testing the value alone would let that one failure through as a success.
  let failed = false;
  let failure: unknown;

  const lane = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        out[i] = await worker(items[i], i);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failed) throw failure;
  return out;
}

/**
 * How many of the arrival ladder's leaders are re-inserted at close.
 *
 * Measured on the only real full field we have (challenge 424, 284 entries, luna): every entry
 * that finished in the final top 15 was already inside the **arrival top 27**. Final top 3 needed
 * arrival top 7; final top 10 needed 13. 40 is ~1.5x the observed requirement, not a guess.
 *
 * Two honest limits on that evidence. It is mildly circular — the "final" ranking it is measured
 * against is itself the output of an unbounded rerun — though the direction is right: that
 * unbounded rerun moved nobody from beyond rank 27 into the top 15. And it is one field under one
 * judge, not a law; a field whose arrival order is noisier could need more. `rankField` warns when
 * a finisher entered the rerun near this boundary, which is the cheap signal that it wants raising.
 */
export const RERUN_TOP_K = 40;

/**
 * Tie groups larger than this are left in arrival order rather than resolved by comparison.
 * Resolving a group is inherently serial (each member searches the members already settled), so an
 * unbounded group is an unbounded serial chain inside a stage that has ~10 minutes to live.
 */
export const MAX_TIE_GROUP = 8;

export type RerunResult = {
  order: number[];
  bouts: number;
  /** Groups left in arrival order because they exceeded MAX_TIE_GROUP. */
  unresolvedGroups: number;
  /** Re-inserted entries whose ARRIVAL rank was close enough to K to suggest K is too small. */
  nearBoundary: number[];
};

/**
 * The second run, bounded: re-insert the top `topK` of the arrival ladder against the FULL
 * standings, and leave everything below that at its arrival position.
 *
 * Re-inserting the whole field was priced at 5,491-8,461 comparisons and 71-306 minutes for a
 * 284-entry field, against a 10-minute completion claim — it raced the claim rather than fitting
 * inside it. Bounding the rerun instead of the field keeps arrival placement ranking everyone
 * (that stage is spread over days and is unchanged) and spends the close-time budget where the
 * money is.
 *
 * This is NOT the cut that was removed in round 2. That one was `Math.random()` breaking ties on a
 * saturated 0-10 absolute score — a coin flip deciding who could be ranked. This is a cut on the
 * ladder's own measured order, with no random component and no saturated scale.
 *
 * Single pass, deliberately. A repeat-until-settled loop was measured never to settle (0/200 seeds
 * under a judge with the seat bias we actually have), so it always ran its cap; and later passes
 * cost 41-65% of the first rather than being free, because a changed order means changed midpoints
 * means new pairs. Four passes at this K would put the stage back outside the claim window.
 */
export async function reinsertTop(
  order: readonly number[],
  bout: Bout,
  topK = RERUN_TOP_K,
  concurrency = LADDER_CONCURRENCY
): Promise<RerunResult> {
  const frozen = [...order];
  const contenders = frozen.slice(0, Math.min(topK, frozen.length));
  if (frozen.length < 2 || contenders.length < 1) {
    return { order: frozen, bouts: 0, unresolvedGroups: 0, nearBoundary: [] };
  }

  const placed = await runPool(contenders, concurrency, async (id) => {
    const others = frozen.filter((x) => x !== id);
    const slot = await findSlot(id, others, bout);
    return { id, key: slot.index, bouts: slot.bouts, from: frozen.indexOf(id) };
  });
  let bouts = placed.reduce((sum, row) => sum + row.bouts, 0);

  // `key` indexes the list WITHOUT this entry, so map it back to a position between two frozen
  // neighbours before mixing it with the entries that kept their arrival index.
  const positionOf = (row: { key: number; from: number }) =>
    row.key < row.from ? row.key - 0.5 : row.key + 0.5;

  const reinserted = new Set(contenders);
  const slots: { id: number; pos: number }[] = frozen
    .map((id, index) => ({ id, pos: index }))
    .filter((row) => !reinserted.has(row.id));
  for (const row of placed) slots.push({ id: row.id, pos: positionOf(row) });

  // Entries that searched to the same position have no measured order relative to each other.
  // Comparing them settles it — which NARROWS the prototype's arrival-order fallback rather than
  // removing it: a group that mutually ties, or one too large to resolve, still falls back.
  const groups = new Map<number, number[]>();
  for (const row of slots) {
    const key = Math.floor(row.pos);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row.id);
  }

  let unresolvedGroups = 0;
  const contested = [...groups.entries()].filter(([, ids]) => ids.length > 1);
  // Groups are independent of each other, so they resolve in parallel even though each one is
  // internally serial.
  const resolved = await runPool(contested, concurrency, async ([, ids]) => {
    if (ids.length > MAX_TIE_GROUP) {
      unresolvedGroups++;
      return ids;
    }
    let settled: number[] = [];
    for (const id of ids) {
      const slot = await findSlot(id, settled, bout);
      bouts += slot.bouts;
      settled = spliceAt(settled, id, slot.index);
    }
    return settled;
  });

  const ordering = new Map<number, number[]>();
  contested.forEach(([key], i) => ordering.set(key, resolved[i]));

  const finalOrder: number[] = [];
  const emitted = new Set<number>();
  for (const row of [...slots].sort((a, b) => a.pos - b.pos)) {
    if (emitted.has(row.id)) continue;
    const group = ordering.get(Math.floor(row.pos));
    if (group) {
      for (const id of group) {
        finalOrder.push(id);
        emitted.add(id);
      }
    } else {
      finalOrder.push(row.id);
      emitted.add(row.id);
    }
  }

  // An entry that started near the K boundary and finished high says the boundary is close to
  // binding. Cheap to compute, and it is the only warning we get before K is actually too small.
  // Only meaningful when the bound actually excluded someone (K covering the whole field leaves
  // no boundary to be near) AND when the rerun is wider than the shortlist it feeds — at
  // topK <= PODIUM_WATCH every re-inserted entry is a potential finalist and the signal is noise.
  const boundary = Math.floor(topK * 0.75);
  const nearBoundary =
    frozen.length > topK && topK > PODIUM_WATCH
      ? placed
          .filter((row) => row.from >= boundary && finalOrder.indexOf(row.id) < PODIUM_WATCH)
          .map((row) => row.id)
      : [];

  return { order: finalOrder, bouts, unresolvedGroups, nearBoundary };
}

/** Finishing this high is what makes a near-boundary arrival rank worth warning about. */
const PODIUM_WATCH = 15;

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
