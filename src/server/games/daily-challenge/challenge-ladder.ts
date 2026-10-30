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
 * In-flight comparisons at close. **Load-bearing for correctness, not a tuning knob** — halving it
 * as a "safety" measure puts the stage back outside the completion claim, where a second run claims
 * the challenge and starts a second podium and a second path to payout.
 *
 * The arithmetic, at the MEASURED 9s median for a two-image bout (12.4s on the self-hosted route,
 * 56s worst case) and a 284-entry field:
 *
 *   depth        = ceil(log2(284))               = 9 bouts per search, serial within one entry
 *   rerun waves  = ceil(RERUN_TOP_K / C)
 *   rerun        = waves x depth x 9s
 *   podium       = ceil(210 / C) x 9s
 *
 *   C = 16 -> 3 waves -> 4.1 min + 2.1 min = 6.2 min   inside the 10-minute claim
 *   C =  8 -> 5 waves -> 6.8 min + 4.0 min = 10.8 min  OVER
 *
 * 12-16 is also what the harness sustained against OpenRouter without rate-limiting, so this is the
 * top of the range that is both fast enough and safe. `assertConcurrencyFitsClaimWindow` below is
 * the executable form of this comment.
 */
export const LADDER_CONCURRENCY = 16;

/** Completion claim, in minutes — `resetStuckCompletingChallenges` revokes on this. */
export const CLAIM_WINDOW_MINUTES = 10;

/** Measured MEDIAN latency of one two-image comparison, in seconds. */
export const MEDIAN_BOUT_SECONDS = 9;

/**
 * Mean, which is what a budget has to be sized on. The distribution has a long tail — 12.4s median
 * on the self-hosted route, 56s worst observed — so the mean sits at 10.7-16.7s depending on the
 * fit. Projections use this rather than the median: sizing a deadline on a median means half the
 * stages are over it.
 */
export const MEAN_BOUT_SECONDS = 12;

/**
 * Sequential bouts the tie-resolution stage costs. Groups resolve in parallel with each other but
 * each group is internally serial, so this is a depth, not a count. Measured at 2.4-2.7 min at
 * concurrency 16 on an arbitrary start, i.e. ~13 bouts deep.
 */
export const TIE_STAGE_BOUT_DEPTH = 13;

/**
 * The `daily-challenge-process-entries` job lock, in seconds — `createJob`'s default
 * `lockExpiration`, which that job does not override. Duplicated here rather than imported because
 * the job module pulls in the whole processing graph; the guard test asserts the two agree.
 *
 * The lock is hard-capped at this: past it the refresh loop releases while the run is still going,
 * so a run that outlives it is overlapped by the next tick — which is the shared-snapshot race
 * again, from the other direction.
 *
 * 🔴 Raised from `createJob`'s 300s DEFAULT, which this job had simply inherited. 300s was chosen
 * for nothing in particular and is too short for a serial drain: reserving one worst-case
 * placement out of it leaves a budget that cannot clear the 8-entry burst already measured live.
 * 540s sits under the 600s cron with room for the overshoot, so a tick still cannot meet itself.
 */
export const REVIEW_JOB_LOCK_SECONDS = 9 * 60;

/** Ten minutes — the cron interval at which an overrunning run gets a concurrent sibling. */
export const REVIEW_JOB_INTERVAL_SECONDS = 10 * 60;

/**
 * Wall clock of ONE arrival placement against a ladder of `ladderSize`. Serial by construction: a
 * binary search cannot issue its next comparison until the last one answers.
 *
 * The number that matters is that this GROWS with the ladder. Sizing a per-tick cap as a fixed
 * count of placements is wrong for exactly that reason — 20 placements is ~7 minutes against the
 * 8-entry ladder it was measured on, and ~36 minutes against a 284-entry one.
 */
export function projectedPlacementSeconds(
  ladderSize: number,
  boutSeconds = MEAN_BOUT_SECONDS
): number {
  return Math.ceil(Math.log2(Math.max(1, ladderSize) + 1)) * boutSeconds;
}

/**
 * Wall clock of a whole serial drain: `placements` arrivals into a ladder that STARTS at
 * `startLadderSize` and grows by one each time.
 *
 * Validated against the live 8-entry run, which recorded per-entry comparison counts of
 * 0,1,2,2,2,3,3,3 (16 bouts). This model predicts 0,1,2,2,3,3,3,3 (17) — the first placement is
 * free because there is nothing to compare against, which is the shape that matters.
 */
export function projectedDrainSeconds(
  startLadderSize: number,
  placements: number,
  boutSeconds = MEAN_BOUT_SECONDS
): number {
  let total = 0;
  for (let i = 0; i < placements; i++) {
    total += Math.ceil(Math.log2(startLadderSize + i + 1)) * boutSeconds;
  }
  return total;
}

/** How many arrivals a budget affords, given where the ladder starts. Always at least one. */
export function placementsWithinBudget(
  startLadderSize: number,
  budgetSeconds: number,
  boutSeconds = MEAN_BOUT_SECONDS
): number {
  let spent = 0;
  let count = 0;
  while (spent < budgetSeconds) {
    spent += Math.ceil(Math.log2(startLadderSize + count + 1)) * boutSeconds;
    if (spent > budgetSeconds) break;
    count++;
  }
  return Math.max(1, count);
}

/**
 * How long one tick of `reviewEntriesForChallenge` may spend before it stops placing arrivals and
 * defers the rest. Sized so the budget PLUS one worst-case placement still fits inside the job
 * lock: 420 + 108 = 528 < 540, and under the 600s cron too. The deadline is only ever checked
 * between placements, because a placement is atomic — so the overshoot is bounded by one
 * placement rather than unbounded.
 */
export const REVIEW_TICK_BUDGET_MS = 420_000;

/**
 * Secondary bound on placements per tick. Only binds on a SHALLOW ladder, where placements are
 * cheap enough that the time budget would let hundreds through and the drain would still be the
 * longest thing in the tick. The time budget is the real guard.
 */
export const MAX_PLACEMENTS_PER_TICK = 20;

/**
 * Projected wall clock of the whole close-time stage. Exported so the arithmetic above is a thing
 * that can FAIL rather than a comment that can rot: the guard test drives this with the real
 * constants, and lowering the concurrency reds it.
 */
export function projectedCloseMinutes(input: {
  entries: number;
  topK?: number;
  concurrency?: number;
  podiumBouts?: number;
  boutSeconds?: number;
  tieDepth?: number;
}): number {
  const {
    entries,
    topK = RERUN_TOP_K,
    concurrency = LADDER_CONCURRENCY,
    podiumBouts = 210,
    boutSeconds = MEAN_BOUT_SECONDS,
    tieDepth = TIE_STAGE_BOUT_DEPTH,
  } = input;
  const depth = Math.ceil(Math.log2(Math.max(2, entries)));
  const rerunWaves = Math.ceil(Math.min(topK, entries) / concurrency);
  const podiumWaves = Math.ceil(podiumBouts / concurrency);
  // The tie stage is a real stage `reinsertTop` runs, not a rounding error — omitting it let a
  // projection of 8.5 min pass the headroom test while the stage actually took 12.2.
  return ((rerunWaves * depth + podiumWaves + tieDepth) * boutSeconds) / 60;
}

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
 * arrival top 7; final top 10 needed 13.
 *
 * 32 is 1.19x that observed requirement — thinner than the 1.5x we wanted, and the claim window is
 * why. At MEAN bout latency (not median) the whole close-time stage has to fit in 10 minutes, and
 * solving that constraint caps K here. `projectedCloseMinutes` is the constraint as code, and the
 * guard test fails if a larger K is set without the budget to pay for it.
 *
 * Two honest limits on that evidence. It is mildly circular — the "final" ranking it is measured
 * against is itself the output of an unbounded rerun — though the direction is right: that
 * unbounded rerun moved nobody from beyond rank 27 into the top 15. And it is one field under one
 * judge, not a law; a field whose arrival order is noisier could need more. `rankField` warns when
 * a finisher entered the rerun near this boundary, which is the cheap signal that it wants raising.
 */
export const RERUN_TOP_K = 32;

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
 * This is not the cut that was removed earlier — **provided the order it cuts is the arrival
 * ladder's**. That one was `Math.random()` breaking ties on a saturated 0-10 absolute score, a coin
 * flip deciding who could be ranked; this cuts the ladder's own measured order.
 *
 * ⚠️ The distinction collapses when arrival never ran. `rankField` hands this the standings order
 * with unplaced entries appended in *eligible* order — and eligible order is still absolute score
 * with a `Math.random()` tiebreak. So for a challenge with no arrival placements, cutting at K
 * would be exactly the coin flip, deciding who reaches the podium: at the measured rho 0.748
 * between such an order and truth, 99.1% of trials exclude at least one true top-15 entry, 4.1
 * finalists lost on average. The caller must not bound an unplaced field — see `rankField`.
 *
 * Single pass, deliberately — and the durable reason is not the clock. **Every quality number
 * quoted for this engine (rho 0.748 full-field, 0.770 on the blend) came from a harness that ran
 * exactly one rerun pass.** One pass is the configuration those measurements describe; multi-pass
 * was always the part nothing had validated.
 *
 * The timing agrees but is the weaker argument, because it moves whenever latency does: a
 * repeat-until-settled loop was measured never to settle (0/200 seeds under a judge with the seat
 * bias we actually have) so it always ran its cap, and later passes cost 41-65% of the first
 * rather than being free, because a changed order means changed midpoints means new pairs.
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
  // binding. Cheap, and the only warning available before K is actually too small.
  //
  // ⚠️ It filters `placed`, so it can only ever see entries that WERE re-inserted. The failure it
  // is a proxy for — a finalist that K already excluded — is structurally unobservable from here,
  // because that entry was never compared against anything. This detects the approach to the cliff,
  // never the fall.
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

/**
 * How many of the ranked leaders play the round-robin that decides places, and — the same number,
 * for the same reason — how high a finisher has to be for a near-boundary arrival rank to matter.
 */
export const PODIUM_SIZE = 15;
const PODIUM_WATCH = PODIUM_SIZE;

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
