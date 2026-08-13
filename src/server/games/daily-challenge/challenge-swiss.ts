/**
 * The pairing rule for rolling Swiss, served as groups.
 *
 * Pure and synchronous: it decides WHO meets WHOM given the current tallies and returns groups.
 * Nothing here calls a model or touches the database, because every measured failure of this
 * structure was a failure of the pairing rule, and a rule that can only be exercised through an
 * engine is a rule that gets tested through mocks of everything else.
 *
 * Every threshold below is a measured failure, not a preference. See
 * `_local/docs/plans/pairwise-judging-decision.md` Part 7 and `sim/structures.mjs`.
 */

/** Entries per model call. 4 is what `kway.mjs` measured; other sizes are unmeasured. */
export const GROUP_SIZE = 4;

/**
 * Groups are drawn from a band of this many, not as adjacent runs of GROUP_SIZE.
 *
 * 🔴 Adjacent fours straight down the strength table do not work. An entry's three opponents are
 * always its immediate neighbours, so it never leaves its stratum, and once those pairs are used it
 * stalls with budget unspent. Measured: top-3 1.63 at budget 9 — and RAISING the budget made it
 * worse (1.37 at 36), which is the signature of a structure that has stopped mixing rather than one
 * that is merely under-played. 8 is the smallest band that mixes while still matching on strength.
 */
export const BAND_SIZE = 8;

/** Comparisons each entry owes over the life of the challenge. Swept in the simulation; top-3 plateaus here. */
export const DEFAULT_BOUT_BUDGET = 9;

/** Ordered relations one group call returns. Four entries yield six. */
export const RELATIONS_PER_CALL = (GROUP_SIZE * (GROUP_SIZE - 1)) / 2;

/**
 * A safety ceiling on calls per tick, NOT a throughput model.
 *
 * 🔴 Nearly every constant in the ladder was back-solved from a measured 9-second median bout to
 * fit a 10-minute window, which is how that design became load-bearing on the model provider's
 * latency: if the provider slows down, the arithmetic that made it safe stops holding and the
 * symptom is a blown claim rather than anything that looks like a latency problem. So the pacing
 * below is derived from the CHALLENGE clock, which no provider can change, and this constant only
 * stops a single tick running away. A quad call's latency is unmeasured; do not turn this into a
 * calculation that pretends otherwise.
 */
export const MAX_CALLS_PER_TICK = 64;

export type SwissEntry = { imageId: number };

export type PairingInput<T extends SwissEntry> = {
  pool: T[];
  wins: Map<number, number>;
  games: Map<number, number>;
  played: Set<string>;
  /** Fraction of the challenge elapsed, 0..1. At close this is 1. */
  progress: number;
  budget: number;
  maxGroups: number;
};

const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * How many comparisons an entry may have played by now.
 *
 * 🔴 The budget must be PACED against the challenge clock, not spent eagerly. Day one brings ~14%
 * of a field; if those entries may burn all nine comparisons immediately they play only each other,
 * finish, and are never compared with anyone who arrives later — the field silently partitions into
 * arrival cohorts whose scores are not comparable. Measured with eager spend: top-1 0.35, against
 * 0.775 for synchronised Swiss at identical cost.
 *
 * The floor lets a brand-new entry start immediately rather than waiting for the clock, and it is
 * GROUP_SIZE - 1 because the smallest unit of work here yields three comparisons at once.
 */
export function allowance(progress: number, budget: number): number {
  return Math.max(GROUP_SIZE - 1, Math.ceil(budget * Math.min(1, Math.max(0, progress))));
}

/**
 * A smoothed win rate, not a win count.
 *
 * A newcomer with 0 games and an early arrival with 9 are not comparable on wins. (wins + 1) /
 * (games + 2) puts an unplayed entry mid-table, where it can be sorted against the field, instead
 * of at the bottom with the genuinely bad ones.
 */
export function strength(
  id: number,
  wins: Map<number, number>,
  games: Map<number, number>
): number {
  return ((wins.get(id) ?? 0) + 1) / ((games.get(id) ?? 0) + 2);
}

/**
 * Deterministic shuffle within a band. Seeded off entry ids and games played so a tick reproduces,
 * and so an entry meets different opponents as its own count moves.
 */
function shuffleBand<T extends SwissEntry>(band: T[], offset: number, games: Map<number, number>) {
  for (let k = band.length - 1; k > 0; k--) {
    const seed = band[k].imageId * 2654435761 + offset * 40503 + (games.get(band[k].imageId) ?? 0);
    const j = seed % (k + 1);
    [band[k], band[j]] = [band[j], band[k]];
  }
}

/**
 * The groups to compare next, at most `maxGroups`.
 *
 * 🔴 Entries are ordered by STRENGTH, with games played only as a tiebreak. Sorting by games first
 * — the obvious reading of "everyone gets adequate play" — pairs whoever is behind with whoever
 * else is behind, which is random pairing wearing a Swiss hat. Measured at the same budget and the
 * same spend: top-1 0.30 and top-3 1.13, against 0.775 and 2.38 for synchronised Swiss. The budget
 * is a FILTER on who still owes comparisons, never the sort key.
 */
export function planGroups<T extends SwissEntry>(input: PairingInput<T>): T[][] {
  const { pool, wins, games, played, budget, maxGroups } = input;
  const ceiling = Math.min(budget, allowance(input.progress, budget));

  const waiting = pool
    .filter((entry) => (games.get(entry.imageId) ?? 0) < ceiling)
    .sort(
      (a, b) =>
        strength(b.imageId, wins, games) - strength(a.imageId, wins, games) ||
        (games.get(a.imageId) ?? 0) - (games.get(b.imageId) ?? 0)
    );

  const banded: T[] = [];
  for (let i = 0; i < waiting.length; i += BAND_SIZE) {
    const band = waiting.slice(i, i + BAND_SIZE);
    shuffleBand(band, i, games);
    banded.push(...band);
  }

  const groups: T[][] = [];
  let cursor = 0;
  while (cursor + GROUP_SIZE <= banded.length && groups.length < maxGroups) {
    const group = banded.slice(cursor, cursor + GROUP_SIZE);
    cursor += GROUP_SIZE;
    // A group whose every pair has already been judged is not worth a request — we would be paying
    // for six answers we already own.
    const fresh = countFreshPairs(group, played);
    if (fresh > 0) groups.push(group);
  }
  return groups;
}

export function countFreshPairs<T extends SwissEntry>(group: T[], played: Set<string>): number {
  let fresh = 0;
  for (let i = 0; i < group.length; i++)
    for (let j = i + 1; j < group.length; j++)
      if (!played.has(pairKey(group[i].imageId, group[j].imageId))) fresh++;
  return fresh;
}

/** The ordered relations a ranked group yields, skipping pairs already owned. */
export function relationsFromRanking(
  orderedImageIds: number[],
  played: Set<string>
): { winnerImageId: number; loserImageId: number }[] {
  const out: { winnerImageId: number; loserImageId: number }[] = [];
  for (let i = 0; i < orderedImageIds.length; i++)
    for (let j = i + 1; j < orderedImageIds.length; j++) {
      const winnerImageId = orderedImageIds[i];
      const loserImageId = orderedImageIds[j];
      if (played.has(pairKey(winnerImageId, loserImageId))) continue;
      out.push({ winnerImageId, loserImageId });
    }
  return out;
}

/**
 * How many calls this tick may spend, paced against the challenge clock.
 *
 * The whole job needs `field * budget / 2` comparisons, which is that over `RELATIONS_PER_CALL`
 * calls. By the time a challenge is a quarter elapsed, a quarter of them should be done — so this
 * returns the shortfall against that target and nothing more.
 *
 * Self-correcting by construction: it compares work DONE against work due by now rather than
 * dividing what is left by ticks remaining. A tick that is skipped, or a job that was down for an
 * hour, is caught up by the next tick instead of quietly losing that work forever.
 *
 * Returns 0 when we are ahead of the clock. That is the point — spending eagerly is what partitions
 * the field into arrival cohorts (top-1 0.35 measured).
 */
export function tickCallBudget(input: {
  fieldSize: number;
  callsSoFar: number;
  progress: number;
  budget: number;
}): number {
  const { fieldSize, callsSoFar, budget } = input;
  const progress = Math.min(1, Math.max(0, input.progress));
  const totalCalls = Math.ceil((fieldSize * budget) / 2 / RELATIONS_PER_CALL);
  const dueByNow = Math.ceil(totalCalls * progress);
  return Math.max(0, Math.min(MAX_CALLS_PER_TICK, dueByNow - callsSoFar));
}

/**
 * Final table, best first. Ranked by win rate rather than raw wins: entries legitimately differ in
 * games played — a late arrival owes fewer — and raw wins would rank the field by arrival time
 * wearing a score.
 */
export function swissStandings<T extends SwissEntry>(
  pool: T[],
  wins: Map<number, number>,
  games: Map<number, number>
): T[] {
  return [...pool].sort(
    (a, b) =>
      strength(b.imageId, wins, games) - strength(a.imageId, wins, games) ||
      (games.get(b.imageId) ?? 0) - (games.get(a.imageId) ?? 0) ||
      a.imageId - b.imageId
  );
}
