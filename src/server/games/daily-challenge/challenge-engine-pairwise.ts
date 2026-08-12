import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { incrementOperationSpent } from '~/server/games/daily-challenge/challenge-helpers';
import {
  JUDGING_ENGINES,
  type ChallengeJudgingEngine,
  type EngineWinner,
  type JudgedEntryRef,
  type JudgingEngineContext,
  type RankableEntry,
} from '~/server/games/daily-challenge/challenge-judging-engine';
import {
  assertLadderCoverage,
  CLAIM_WINDOW_MINUTES,
  findSlot,
  LADDER_CONCURRENCY,
  PODIUM_SIZE,
  reinsertTop,
  roundRobinPairs,
  runPool,
  tallyPodium,
  type Bout,
  type BoutResult,
  type Seat,
  RERUN_TOP_K,
} from '~/server/games/daily-challenge/challenge-ladder';
import {
  buildComparisonPrompt,
  comparePair,
  type ComparisonImage,
  type ComparisonPhase,
} from '~/server/games/daily-challenge/challenge-pairwise';
import * as store from '~/server/games/daily-challenge/challenge-pairwise-store';
import { logToAxiom } from '~/server/logging/client';

export { PODIUM_SIZE } from '~/server/games/daily-challenge/challenge-ladder';

const PODIUM_CONCURRENCY = LADDER_CONCURRENCY;

/**
 * Warn when one close-time stage runs longer than this. Deliberately below the completion claim:
 * at the claim the challenge has already been re-taken by another run, so a warning there is a
 * post-mortem. 70% of the window is enough slack to be actionable.
 */
const CLOSE_STAGE_WARN_MS = CLAIM_WINDOW_MINUTES * 60_000 * 0.7;

/**
 * Above this share of the field missing an arrival placement, the standings order is not a
 * measurement and must not be cut at K. Half is generous: even a third unplaced means a third of
 * the order is absolute score with a random tiebreak.
 */
const UNPLACED_BOUND_LIMIT = 0.5;

/**
 * Pairwise judging. An entry binary-searches the standings as it arrives and becomes a rung for
 * later arrivals; at close every entry is re-inserted against the finished ladder, and the
 * leaders play a full round-robin that decides the places.
 *
 * The absolute pass still runs alongside this and is untouched — it produces the CivBot comment,
 * the summary, and the theme gate, none of which a comparison between two images can express.
 */
export const pairwiseLadderEngine: ChallengeJudgingEngine = {
  key: JUDGING_ENGINES.PairwiseLadder,
  ranksFullField: true,
  dedupesAfterRanking: true,
  shortlistSize: PODIUM_SIZE,

  async recordEntry(ctx: JudgingEngineContext, entry: JudgedEntryRef): Promise<void> {
    const standings = await store.getStandings(ctx.challengeId);
    const ladder = standings.map((s) => s.imageId).filter((id) => id !== entry.imageId);
    const images = await loadComparisonImages([...ladder, entry.imageId]);
    images.set(entry.imageId, {
      imageId: entry.imageId,
      url: entry.url,
      nsfwLevel: entry.nsfwLevel,
    });

    const session = createSession(ctx, images, 'arrive');
    const { index, bouts } = await session.run(() => findSlot(entry.imageId, ladder, session.bout));
    await store.insertStanding({
      challengeId: ctx.challengeId,
      imageId: entry.imageId,
      userId: entry.userId,
      rank: index + 1,
      comparisons: bouts,
    });
  },

  async rankField<T extends RankableEntry>(ctx: JudgingEngineContext, eligible: T[]): Promise<T[]> {
    if (eligible.length < 2) return eligible;

    const byImageId = new Map(eligible.map((entry) => [entry.imageId, entry]));
    const standings = await store.getStandings(ctx.challengeId);
    // Entries the arrival pass never placed (a failed comparison, or a challenge switched to this
    // engine mid-flight) go on the end and are placed by the second run like everything else.
    const placed = standings.map((s) => s.imageId).filter((id) => byImageId.has(id));
    const missing = eligible.map((e) => e.imageId).filter((id) => !placed.includes(id));
    const startingOrder = [...placed, ...missing];

    const images = await loadComparisonImages(startingOrder);
    const session = createSession(ctx, images, 'rerun');
    session.seed(await store.getComparisons(ctx.challengeId, ['arrive', 'rerun']));
    // Bounding the rerun is only safe when the order it bounds came from ARRIVAL placement. When a
    // challenge was opted in too late for arrival to have run, `startingOrder` is mostly the
    // eligible order — absolute score with a Math.random() tiebreak — and cutting it at K would be
    // that coin flip deciding who reaches the podium. Such a challenge has spent no arrival budget,
    // so it can afford the unbounded rerun instead.
    const unplacedFraction = missing.length / startingOrder.length;
    const arrivalUsable = missing.length === 0 || unplacedFraction < UNPLACED_BOUND_LIMIT;
    const topK = arrivalUsable ? RERUN_TOP_K : startingOrder.length;
    const rerun = await session.run(() => reinsertTop(startingOrder, session.bout, topK));

    logToAxiom({
      type:
        rerun.unresolvedGroups || rerun.nearBoundary.length || missing.length ? 'warning' : 'info',
      name: 'challenge-pairwise-rerun',
      challengeId: ctx.challengeId,
      field: eligible.length,
      rerunTopK: topK,
      // False means arrival placement had not covered enough of the field to be worth bounding, so
      // the rerun ran unbounded. Expect a much longer stage and a much larger bout count.
      arrivalUsable,
      bouts: rerun.bouts,
      // Entries that reached the rerun with no arrival placement at all. A challenge switched to
      // this engine near its close has a starting order that is arbitrary rather than measured,
      // and a bounded rerun over an arbitrary order ranks arbitrarily.
      unplacedOnArrival: missing.length,
      // Tie groups too large to resolve by comparison; these kept their arrival order.
      unresolvedGroups: rerun.unresolvedGroups,
      // Finishers that entered the rerun near the K boundary — the signal that K wants raising.
      nearBoundary: rerun.nearBoundary,
    }).catch(() => undefined);

    const order = rerun.order;
    assertLadderCoverage(
      ctx.challengeId,
      order,
      eligible.map((entry) => entry.imageId)
    );

    const ranked = order.map((id) => byImageId.get(id)!);
    await store.replaceStandings(
      ctx.challengeId,
      ranked.map((entry) => ({ imageId: entry.imageId, userId: entry.userId }))
    );
    return ranked;
  },

  async selectWinners<T extends RankableEntry>(
    ctx: JudgingEngineContext,
    ranked: T[],
    places: number
  ): Promise<EngineWinner[] | null> {
    if (ranked.length < 2) return null;

    const contenders = ranked.slice(0, PODIUM_SIZE);
    const images = await loadComparisonImages(contenders.map((entry) => entry.imageId));
    const session = createSession(ctx, images, 'podium');

    // Both seats, unlike placement: confirmation buys nothing during a binary search, but this
    // stage decides money and a disagreement between the seatings is a real tie. The seat is on
    // the job — anything derived at call time from shared state gives concurrent bouts the same
    // seat, and the duplicate is then discarded on write after it has been paid for.
    //
    // Seating is deterministic per pair only while the pair is UNCONTENDED. Two lanes racing for
    // the same pair share one comparison via the promise cache, and whichever arrived first fixed
    // its seat — so the loser's requested seat is not the one that was played. Correct for the
    // podium (both seats are queued anyway) and immaterial for placement (which never asks for a
    // pair twice), but it is not the stronger guarantee it might read as.
    session.seed(await store.getComparisons(ctx.challengeId, ['podium']));
    const jobs = roundRobinPairs(contenders.map((entry) => entry.imageId)).flatMap(
      ([x, y]): { x: number; y: number; seat: Seat }[] => [
        { x, y, seat: 1 },
        { x, y, seat: 2 },
      ]
    );
    await session.run(() =>
      runPool(jobs, PODIUM_CONCURRENCY, (job) => session.bout(job.x, job.y, job.seat))
    );

    const ladderRank = new Map(contenders.map((entry, i) => [entry.imageId, i]));
    const table = tallyPodium(
      contenders.map((entry) => entry.imageId),
      await store.getComparisons(ctx.challengeId, ['podium']),
      (imageId) => ladderRank.get(imageId) ?? Number.MAX_SAFE_INTEGER,
      2
    );

    const byImageId = new Map(ranked.map((entry) => [entry.imageId, entry]));
    const podiumOrder = table.map((row) => byImageId.get(row.imageId)!).filter(Boolean);
    const rest = ranked.filter((entry) => !ladderRank.has(entry.imageId));
    await store.replaceStandings(
      ctx.challengeId,
      [...podiumOrder, ...rest].map((entry) => ({
        imageId: entry.imageId,
        userId: entry.userId,
        winRate: table.find((row) => row.imageId === entry.imageId)?.winRate ?? null,
      }))
    );

    return table.slice(0, places).map((row): EngineWinner => {
      const entry = byImageId.get(row.imageId)!;
      return {
        userId: entry.userId,
        imageId: row.imageId,
        reason: `Won ${formatWins(row.wins)} of ${
          row.games
        } head-to-head comparisons against the other finalists.`,
      };
    });
  },
};

const formatWins = (wins: number) => (Number.isInteger(wins) ? String(wins) : wins.toFixed(1));

/**
 * One engine call's worth of comparisons: the pair cache, the persistence of each verdict, and
 * the spend it accrued. Totals are reported once per stage rather than per bout, via `run`.
 */
function createSession(
  ctx: JudgingEngineContext,
  images: Map<number, ComparisonImage>,
  phase: ComparisonPhase
) {
  const systemPrompt = buildComparisonPrompt({
    theme: ctx.theme,
    themeElements: ctx.themeElements,
    categories: ctx.categories,
    criteriaByKey: ctx.criteriaByKey,
  });
  // Placement caches by PAIR — a binary search never wants the same two entries twice, whatever
  // the seating. The podium caches by pair AND seat, because playing both seats is the point of
  // that stage.
  //
  // ⚠️ What keeps arrive/rerun inside the two-rows-per-pair ceiling of the unique index is THIS
  // cache plus the fact that a placement search only ever compares the entry being placed against
  // incumbents — never the same pair on both seats. Neither is enforced by the schema. If a future
  // stage compares a pair on both seats during placement, the second row is dropped by ON CONFLICT
  // DO NOTHING with no error, exactly as the podium's did.
  //
  // The cache holds the in-flight PROMISE, not the settled winner. Both close-time stages are
  // concurrent now, so two lanes routinely ask for the same pair before either has answered; a
  // cache of finished results misses both and pays twice for one comparison.
  const results = new Map<string, Promise<number | null>>();
  const pairKey = (x: number, y: number) => (x < y ? `${x}:${y}` : `${y}:${x}`);
  const cacheKey = (x: number, y: number, firstSeatImageId: number) =>
    phase === 'podium' ? `${pairKey(x, y)}:${firstSeatImageId}` : pairKey(x, y);

  let buzz = 0;
  let comparisons = 0;
  let reroutes = 0;

  const bout: Bout = async (challengerId, opponentId, seat): Promise<BoutResult> => {
    const firstSeatImageId = seat === 1 ? challengerId : opponentId;
    const key = cacheKey(challengerId, opponentId, firstSeatImageId);

    let pending = results.get(key);
    if (!pending) {
      pending = (async () => {
        const challenger = images.get(challengerId);
        const opponent = images.get(opponentId);
        if (!challenger || !opponent) {
          throw new Error(`Missing image for comparison ${challengerId} vs ${opponentId}`);
        }

        const verdict = await comparePair({
          systemPrompt,
          categories: ctx.categories,
          challenger,
          opponent,
          seat,
        });
        comparisons++;
        buzz += verdict.buzzCost;
        if (verdict.rerouted) reroutes++;

        await store.recordComparison({ challengeId: ctx.challengeId, phase, verdict });
        return verdict.winnerImageId;
      })();
      // A failed comparison must not be cached as a failure: the stage aborts anyway, and leaving
      // it would poison a later retry of the same pair.
      pending.catch(() => results.delete(key));
      results.set(key, pending);
    }

    return toResult(await pending, challengerId);
  };

  const startedAt = Date.now();

  async function settle() {
    const spend = Math.ceil(buzz);
    if (spend > 0) await incrementOperationSpent(ctx.challengeId, spend);
    // The empirical form of the wall-clock arithmetic behind LADDER_CONCURRENCY. It fires BEFORE
    // the claim does, so a stage drifting toward the window announces itself instead of being
    // discovered from a double payout.
    const durationMs = Date.now() - startedAt;
    // Against the CUMULATIVE close-time clock, not this stage's own: the claim covers every stage
    // together, so six minutes of rerun plus six of podium blows it with neither stage over budget.
    const closeMs = ctx.startedAt ? Date.now() - ctx.startedAt : durationMs;
    const slow = closeMs > CLOSE_STAGE_WARN_MS;
    logToAxiom({
      type: slow ? 'warning' : 'info',
      name: 'challenge-pairwise-stage',
      challengeId: ctx.challengeId,
      phase,
      durationMs,
      closeMs,
      claimWindowMs: CLAIM_WINDOW_MINUTES * 60_000,
      comparisons,
      reroutes,
      buzz: spend,
    }).catch(() => undefined);
  }

  return {
    bout,
    /** Seed the cache from comparisons this challenge already paid for. */
    seed(stored: store.StoredComparison[]) {
      for (const row of stored) {
        results.set(
          cacheKey(row.imageIdA, row.imageIdB, row.firstSeatImageId),
          Promise.resolve(row.winnerImageId)
        );
      }
    },
    /**
     * Run a stage and account for it whether or not it finishes. Comparisons are billed by the
     * provider the moment they return, so a stage that throws half way through has still spent
     * real money; settling only on success made a mid-stage 429 look free. The accounting failure
     * is swallowed rather than allowed to replace the error that actually stopped the stage.
     */
    async run<T>(work: () => Promise<T>): Promise<T> {
      try {
        return await work();
      } finally {
        try {
          await settle();
        } catch (error) {
          logToAxiom({
            type: 'error',
            name: 'challenge-pairwise-settle',
            challengeId: ctx.challengeId,
            phase,
            message: (error as Error).message,
          }).catch(() => undefined);
        }
      }
    },
  };
}

const toResult = (winnerImageId: number | null, challengerId: number): BoutResult =>
  winnerImageId === null ? 'tie' : winnerImageId === challengerId ? 'challenger' : 'opponent';

async function loadComparisonImages(imageIds: number[]): Promise<Map<number, ComparisonImage>> {
  const unique = [...new Set(imageIds)];
  if (!unique.length) return new Map();
  const rows = await dbRead.$queryRaw<{ imageId: number; url: string; nsfwLevel: number }[]>`
    SELECT id AS "imageId", url, "nsfwLevel"
    FROM "Image"
    WHERE id IN (${Prisma.join(unique)})
  `;
  return new Map(rows.map((row) => [row.imageId, row]));
}
