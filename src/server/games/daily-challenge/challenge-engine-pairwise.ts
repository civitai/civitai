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
  findSlot,
  reinsertAll,
  roundRobinPairs,
  tallyPodium,
  type Bout,
  type BoutResult,
} from '~/server/games/daily-challenge/challenge-ladder';
import {
  buildComparisonPrompt,
  comparePair,
  type ComparisonImage,
  type ComparisonPhase,
} from '~/server/games/daily-challenge/challenge-pairwise';
import * as store from '~/server/games/daily-challenge/challenge-pairwise-store';
import { logToAxiom } from '~/server/logging/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

/** How many of the ladder's leaders play the round-robin that decides places. */
export const PODIUM_SIZE = 15;

const PODIUM_CONCURRENCY = 8;

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
    const { index, bouts } = await findSlot(entry.imageId, ladder, session.bout);
    await store.insertStanding({
      challengeId: ctx.challengeId,
      imageId: entry.imageId,
      userId: entry.userId,
      rank: index + 1,
      comparisons: bouts,
    });
    await session.settle();
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
    const { order } = await reinsertAll(startingOrder, session.bout);
    await session.settle();

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
    // stage decides money and a disagreement between the seatings is a real tie.
    const jobs = roundRobinPairs(contenders.map((entry) => entry.imageId)).flatMap(([x, y]) => [
      { x, y, step: 0 },
      { x, y, step: 1 },
    ]);
    await limitConcurrency(
      jobs.map((job) => async () => {
        await session.bout(job.x, job.y, job.step);
      }),
      PODIUM_CONCURRENCY
    );
    await session.settle();

    const ladderRank = new Map(contenders.map((entry, i) => [entry.imageId, i]));
    const table = tallyPodium(
      contenders.map((entry) => entry.imageId),
      await store.getComparisons(ctx.challengeId, ['podium']),
      (imageId) => ladderRank.get(imageId) ?? Number.MAX_SAFE_INTEGER
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
 * One engine call's worth of comparisons: the pair cache, the seat counter, the persistence of
 * each verdict, and the spend it accrued. `settle` reports the totals once, so a challenge is
 * charged and logged per stage rather than per bout.
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
  const results = new Map<string, number | null>();
  const pairKey = (x: number, y: number) => (x < y ? `${x}:${y}` : `${y}:${x}`);

  let step = 0;
  let buzz = 0;
  let comparisons = 0;
  let reroutes = 0;

  const bout: Bout = async (challengerId, opponentId, boutStep): Promise<BoutResult> => {
    const key = pairKey(challengerId, opponentId);
    if (phase !== 'podium' && results.has(key)) {
      return toResult(results.get(key) ?? null, challengerId);
    }

    const challenger = images.get(challengerId);
    const opponent = images.get(opponentId);
    if (!challenger || !opponent) {
      throw new Error(`Missing image for comparison ${challengerId} vs ${opponentId}`);
    }

    // Seats alternate on the session's own counter rather than the caller's step, so a stage made
    // of many short searches still alternates instead of always opening on the same seat.
    const verdict = await comparePair({
      systemPrompt,
      categories: ctx.categories,
      challenger,
      opponent,
      step: step + boutStep,
    });
    step++;
    comparisons++;
    buzz += verdict.buzzCost;
    if (verdict.rerouted) reroutes++;

    await store.recordComparison({ challengeId: ctx.challengeId, phase, verdict });
    results.set(key, verdict.winnerImageId);
    return toResult(verdict.winnerImageId, challengerId);
  };

  return {
    bout,
    /** Seed the cache from comparisons this challenge already paid for. */
    seed(stored: store.StoredComparison[]) {
      for (const row of stored) results.set(pairKey(row.imageIdA, row.imageIdB), row.winnerImageId);
    },
    async settle() {
      const spend = Math.ceil(buzz);
      if (spend > 0) await incrementOperationSpent(ctx.challengeId, spend);
      logToAxiom({
        type: 'info',
        name: 'challenge-pairwise-stage',
        challengeId: ctx.challengeId,
        phase,
        comparisons,
        reroutes,
        buzz: spend,
      }).catch(() => undefined);
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
