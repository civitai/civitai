import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import type { JudgingCategory } from '~/server/games/daily-challenge/daily-challenge-scoring';
import {
  buildComparisonPrompt,
  comparePair,
  type ComparisonImage,
  type PairwiseVerdict,
} from '~/server/games/daily-challenge/challenge-pairwise';
import {
  reinsertTop,
  roundRobinPairs,
  runPool,
  tallyPodium,
  LADDER_CONCURRENCY,
  PODIUM_SIZE,
  RERUN_TOP_K,
  type Bout,
  type BoutResult,
  type Seat,
} from '~/server/games/daily-challenge/challenge-ladder';

export type PlaygroundEntry = { imageId: number; userId: number; username: string };

export type PlaygroundLadderResult = {
  standings: {
    rank: number;
    imageId: number;
    userId: number;
    username: string;
    /**
     * Whether this entry was re-inserted, i.e. whether its position was MEASURED. False rows kept
     * their input index and were never compared against each other — read their relative order as
     * the legacy absolute score, not as a pairwise result.
     */
    compared: boolean;
  }[];
  podium: { rank: number; imageId: number; username: string; winRate: number; games: number }[];
  comparisons: number;
  buzz: number;
  topK: number;
  measured: number;
  unmeasured: number;
  /** Non-empty means part of this answer is the thing the dry run exists to evaluate against. */
  warnings: string[];
  unresolvedGroups: number;
  nearBoundary: number[];
  reroutes: number;
  durationMs: number;
};

/**
 * Run a real field through the ladder and report what it would have decided, **writing nothing**.
 *
 * The point is to be able to answer "what would this challenge's ranking have been" — and to try a
 * different judge or a different K against a real field — without a moderator having to opt a live
 * challenge in to find out. So: no standings, no comparison rows, no winners, no `operationSpent`.
 *
 * It reuses the ORDERING code rather than reimplementing it, which is the only way the answer means
 * anything: `reinsertTop` and `tallyPodium` take their comparisons from an injected `bout`, so the
 * algorithm under test here is the one production runs. What is deliberately not reused is the
 * engine's session — that is the layer that persists and charges.
 *
 * ⚠️ Not free. Every comparison is a real LLM call against a real model, and the Buzz is really
 * spent even though nothing records it against the challenge. `buzz` in the result is what this run
 * cost; treat it as a floor for the permissive route (see #3815).
 */
export async function runLadderDryRun(input: {
  challengeId: number;
  entries: PlaygroundEntry[];
  theme: string;
  themeElements?: string[];
  resourceConcept?: string;
  categories: JudgingCategory[];
  criteriaByKey?: Record<string, string>;
  /** Defaults to production's K. Lower it to see how much the bound is costing the ranking. */
  topK?: number;
  /** Skip the round-robin when only the ladder order is of interest. */
  includePodium?: boolean;
}): Promise<PlaygroundLadderResult> {
  const startedAt = Date.now();
  const { entries } = input;
  const byImageId = new Map(entries.map((entry) => [entry.imageId, entry]));
  const images = await loadImages(entries.map((entry) => entry.imageId));

  const systemPrompt = buildComparisonPrompt({
    theme: input.theme,
    themeElements: input.themeElements,
    resourceConcept: input.resourceConcept,
    categories: input.categories,
    criteriaByKey: input.criteriaByKey,
  });

  let comparisons = 0;
  let buzz = 0;
  let reroutes = 0;
  const cache = new Map<string, Promise<number | null>>();
  const pairKey = (x: number, y: number, seat: Seat) =>
    `${x < y ? `${x}:${y}` : `${y}:${x}`}:${seat === 1 ? x : y}`;

  const bout: Bout = async (challengerId, opponentId, seat): Promise<BoutResult> => {
    const key = pairKey(challengerId, opponentId, seat);
    let pending = cache.get(key);
    if (!pending) {
      pending = (async () => {
        const challenger = images.get(challengerId);
        const opponent = images.get(opponentId);
        if (!challenger || !opponent) {
          throw new Error(`Missing image for comparison ${challengerId} vs ${opponentId}`);
        }
        const verdict: PairwiseVerdict = await comparePair({
          systemPrompt,
          categories: input.categories,
          challenger,
          opponent,
          seat,
        });
        comparisons++;
        buzz += verdict.buzzCost;
        if (verdict.rerouted) reroutes++;
        return verdict.winnerImageId;
      })();
      pending.catch(() => cache.delete(key));
      cache.set(key, pending);
    }
    const winner = await pending;
    return winner === null ? 'tie' : winner === challengerId ? 'challenger' : 'opponent';
  };

  const inputOrder = entries.map((entry) => entry.imageId);
  const topK = input.topK ?? RERUN_TOP_K;
  // reinsertTop takes its contenders as the first topK of the order it is handed, so the measured
  // set is knowable before the run.
  const contenderIds = new Set(inputOrder.slice(0, Math.min(topK, inputOrder.length)));
  const measured = contenderIds.size;
  const unmeasured = inputOrder.length - measured;

  // 🔴 The engine refuses to bound a rerun over an order arrival did not produce (`arrivalUsable`
  // in challenge-engine-pairwise.ts). A dry run has NO arrival placement by construction, so
  // production's answer for this field would be the unbounded rerun — and any bounded dry run is
  // therefore partly the legacy order it exists to evaluate against, not a preview of production.
  //
  // The bound is kept rather than removed because playgroundRunLadderSchema caps topK at 60 on
  // purpose: an unbounded default is a several-thousand-comparison run of real, billed LLM calls
  // started from a form field. So the cost stays capped and the compromise is stated instead of
  // hidden. Measured on challenge 424 at topK=6: ranks 7-64 were never compared, and two of five
  // entries tied at 8.85 reached the re-inserted set on a Math.random() tiebreak.
  const warnings: string[] = [];
  if (unmeasured > 0) {
    warnings.push(
      `PARTIAL RANKING: topK=${topK} measured only the first ${measured} of ${inputOrder.length} entries. ` +
        `The other ${unmeasured} kept their input order — the legacy absolute score with its Math.random() ` +
        `tiebreak — and were never compared against each other. Production would not bound this field: ` +
        `a dry run has no arrival placement, so the engine's arrivalUsable guard runs the rerun unbounded.`
    );
  }

  const rerun = await reinsertTop(inputOrder, bout, topK);

  let podium: PlaygroundLadderResult['podium'] = [];
  if (input.includePodium !== false && rerun.order.length >= 2) {
    const contenders = rerun.order.slice(0, PODIUM_SIZE);
    const unmeasuredOnPodium = contenders.filter((id) => !contenderIds.has(id)).length;
    if (unmeasuredOnPodium > 0) {
      warnings.push(
        `PODIUM DRAWN FROM UNRANKED ENTRIES: ${unmeasuredOnPodium} of the ${contenders.length} ` +
          `round-robin contenders were never re-inserted, so they reached the podium on the legacy ` +
          `order alone. Raise topK to at least ${PODIUM_SIZE} for a podium worth reading.`
      );
    }
    const verdicts: { imageIdA: number; imageIdB: number; winnerImageId: number | null }[] = [];
    const jobs = roundRobinPairs(contenders).flatMap(
      ([x, y]): { x: number; y: number; seat: Seat }[] => [
        { x, y, seat: 1 },
        { x, y, seat: 2 },
      ]
    );
    await runPool(jobs, LADDER_CONCURRENCY, async (job) => {
      const result = await bout(job.x, job.y, job.seat);
      verdicts.push({
        imageIdA: job.x,
        imageIdB: job.y,
        winnerImageId: result === 'tie' ? null : result === 'challenger' ? job.x : job.y,
      });
    });
    const ladderRank = new Map(contenders.map((id, i) => [id, i]));
    podium = tallyPodium(
      contenders,
      verdicts,
      (imageId) => ladderRank.get(imageId) ?? Number.MAX_SAFE_INTEGER,
      2
    ).map((row, i) => ({
      rank: i + 1,
      imageId: row.imageId,
      username: byImageId.get(row.imageId)?.username ?? 'unknown',
      winRate: row.winRate,
      games: row.games,
    }));
  }

  return {
    standings: rerun.order.map((imageId, i) => ({
      rank: i + 1,
      imageId,
      userId: byImageId.get(imageId)?.userId ?? 0,
      username: byImageId.get(imageId)?.username ?? 'unknown',
      compared: contenderIds.has(imageId),
    })),
    podium,
    comparisons,
    buzz,
    topK,
    measured,
    unmeasured,
    warnings,
    unresolvedGroups: rerun.unresolvedGroups,
    nearBoundary: rerun.nearBoundary,
    reroutes,
    durationMs: Date.now() - startedAt,
  };
}

async function loadImages(imageIds: number[]): Promise<Map<number, ComparisonImage>> {
  const unique = [...new Set(imageIds)];
  if (!unique.length) return new Map();
  const rows = await dbRead.$queryRaw<{ imageId: number; url: string; nsfwLevel: number }[]>`
    SELECT id AS "imageId", url, "nsfwLevel"
    FROM "Image"
    WHERE id IN (${Prisma.join(unique)})
  `;
  return new Map(rows.map((row) => [row.imageId, row]));
}
