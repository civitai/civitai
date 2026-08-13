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
  LADDER_CONCURRENCY,
  PODIUM_SIZE,
  runPool,
} from '~/server/games/daily-challenge/challenge-ladder';
import {
  buildGroupComparisonPrompt,
  compareGroup,
  type ComparisonImage,
} from '~/server/games/daily-challenge/challenge-pairwise';
import * as store from '~/server/games/daily-challenge/challenge-pairwise-store';
import {
  DEFAULT_BOUT_BUDGET,
  GROUP_SIZE,
  planGroups,
  relationsFromRanking,
  swissStandings,
} from '~/server/games/daily-challenge/challenge-swiss';
import { logToAxiom } from '~/server/logging/client';

/**
 * How many passes the close-time settle may make before giving up.
 *
 * 🔴 This loop MUST be able to terminate on its own. A pass returns 0 when nothing is left to
 * compare, and the loop breaks on that — but a bound is here as well, because a fake or a bug that
 * keeps a pass returning groups forever produces a pure microtask loop, which vitest's
 * `setTimeout`-based `testTimeout` cannot observe. Measured elsewhere in this repo: 4.2M iterations
 * in 4s with a 300ms timeout that never fired. CI hangs with nothing to read.
 */
const MAX_SETTLE_PASSES = DEFAULT_BOUT_BUDGET + 2;

/**
 * Rolling Swiss, served as group calls.
 *
 * Entries are compared against opponents of similar current strength, a few at a time, on every
 * review tick the challenge already runs. Nothing is placed at arrival and there is no close-time
 * stage over the whole field — at 476 entries the simulation puts close-time work at 57 calls of
 * 735, nearly all of it the podium.
 *
 * That division is the point, not the cheapness. The ladder cannot be divided — its insertion is
 * serial by construction — and that single fact is where the 28-minute close stage, the expired
 * claim, the concurrent second run and the swapped first and second place all come from.
 *
 * The absolute pass still runs alongside this and is untouched: it produces the CivBot comment, the
 * summary and the theme gate, none of which a comparison between images can express.
 */
export const rollingSwissEngine: ChallengeJudgingEngine = {
  key: JUDGING_ENGINES.RollingSwiss,
  ranksFullField: true,
  dedupesAfterRanking: true,
  shortlistSize: PODIUM_SIZE,

  /**
   * Register the entry and spend nothing. Arrival costs no model calls here: the ladder's arrival
   * placement was `ceil(log2(n+1))` SERIAL comparisons — ~132s against a 2,000-entry ladder, which
   * is what made a mature daily place 0-3 entries per tick and then fall onto the unbounded rerun.
   * An entry becomes comparable simply by existing; `advance` picks it up on the next tick.
   */
  async recordEntry(ctx: JudgingEngineContext, entry: JudgedEntryRef): Promise<void> {
    const standings = await store.getStandings(ctx.challengeId);
    await store.insertStanding({
      challengeId: ctx.challengeId,
      imageId: entry.imageId,
      userId: entry.userId,
      rank: standings.length + 1,
      comparisons: 0,
    });
  },

  async advance<T extends RankableEntry>(
    ctx: JudgingEngineContext,
    pool: T[],
    maxCalls: number
  ): Promise<number> {
    if (pool.length < GROUP_SIZE || maxCalls < 1) return 0;
    return runGroups(ctx, pool, maxCalls, await challengeProgress(ctx.challengeId));
  },

  /**
   * Settle whatever comparisons are still owed, then order the field.
   *
   * `progress` is 1 here, so the pacing ceiling is the full budget: an entry that arrived in the
   * last ten minutes catches up now. In the simulation that is ~3 comparisons per late arrival.
   */
  async rankField<T extends RankableEntry>(ctx: JudgingEngineContext, eligible: T[]): Promise<T[]> {
    if (eligible.length < 2) return eligible;

    let calls = 0;
    for (let pass = 0; pass < MAX_SETTLE_PASSES; pass++) {
      const spent = await runGroups(ctx, eligible, Number.MAX_SAFE_INTEGER, 1);
      calls += spent;
      if (spent === 0) break;
    }

    const state = await store.getSwissState(ctx.challengeId);
    const ranked = swissStandings(eligible, state.wins, state.games);
    const shortOfBudget = eligible.filter(
      (entry) => (state.games.get(entry.imageId) ?? 0) < DEFAULT_BOUT_BUDGET
    ).length;

    logToAxiom({
      // Entries that never reached their budget are the signal that pacing did not keep up with
      // arrivals, which is the failure mode this structure has. It is a warning, not a footnote.
      type: shortOfBudget ? 'warning' : 'info',
      name: 'challenge-swiss-close',
      challengeId: ctx.challengeId,
      field: eligible.length,
      closeCalls: calls,
      shortOfBudget,
      minGames: Math.min(...eligible.map((e) => state.games.get(e.imageId) ?? 0)),
    }).catch(() => undefined);

    await store.replaceStandings(
      ctx.challengeId,
      ranked.map((entry) => ({
        imageId: entry.imageId,
        userId: entry.userId,
        winRate:
          (state.wins.get(entry.imageId) ?? 0) / Math.max(1, state.games.get(entry.imageId) ?? 0),
      }))
    );
    return ranked;
  },

  /**
   * No opinion beyond the ranking. The caller's own winner pick reads the order this produced,
   * which is the same contract the ladder's podium ends on.
   */
  async selectWinners(): Promise<EngineWinner[] | null> {
    return null;
  },
};

/**
 * One tick's worth of group comparisons. Returns calls actually spent.
 *
 * Groups run concurrently but are planned ONCE, from a single snapshot of the tallies. Re-planning
 * mid-flight would let two lanes pick the same pair before either had recorded it, which is the
 * third concurrency race this subsystem has had.
 */
async function runGroups<T extends RankableEntry>(
  ctx: JudgingEngineContext,
  pool: T[],
  maxCalls: number,
  progress: number
): Promise<number> {
  const state = await store.getSwissState(ctx.challengeId);
  const groups = planGroups({
    pool,
    wins: state.wins,
    games: state.games,
    played: state.played,
    progress,
    budget: DEFAULT_BOUT_BUDGET,
    maxGroups: maxCalls,
  });
  if (!groups.length) return 0;

  const images = await loadComparisonImages(groups.flat().map((entry) => entry.imageId));
  const systemPrompt = buildGroupComparisonPrompt({
    theme: ctx.theme,
    themeElements: ctx.themeElements,
    categories: ctx.categories,
    criteriaByKey: ctx.criteriaByKey,
    groupSize: GROUP_SIZE,
  });

  let calls = 0;
  let malformed = 0;
  let buzz = 0;

  await runPool(groups, LADDER_CONCURRENCY, async (group) => {
    const groupImages = group
      .map((entry) => images.get(entry.imageId))
      .filter((image): image is ComparisonImage => !!image);
    // A group we cannot fully load is not a group. Comparing the remainder would silently change
    // the question from "rank four" to "rank three" and bill for it.
    if (groupImages.length !== group.length) return;

    const verdict = await compareGroup({ systemPrompt, group: groupImages });
    calls++;
    buzz += verdict.buzzCost;

    if (!verdict.order) {
      malformed++;
      return;
    }

    // Written against the SNAPSHOT's played set, so a pair another lane recorded in the meantime is
    // still attempted here and lands on the conflict clause rather than being skipped by a read
    // that raced. Cheap either way: it is one row, not one call.
    const relations = relationsFromRanking(verdict.order, state.played);
    for (const [index, relation] of relations.entries()) {
      await store.recordComparison({
        challengeId: ctx.challengeId,
        phase: 'swiss',
        verdict: {
          imageIdA: relation.winnerImageId,
          imageIdB: relation.loserImageId,
          firstSeatImageId: groupImages[0].imageId,
          winnerImageId: relation.winnerImageId,
          margin: null,
          perCategory: {},
          reason: null,
          model: verdict.model,
          rerouted: false,
          usage: verdict.usage,
          // One CALL produced all of these rows, so its cost belongs to the group once. Spreading
          // it across six rows would make each look a sixth as expensive as it was; repeating it
          // would sextuple the challenge's recorded spend. The first row carries it.
          buzzCost: index === 0 ? verdict.buzzCost : 0,
        },
      });
    }
  });

  const spend = Math.ceil(buzz);
  if (spend > 0) await incrementOperationSpent(ctx.challengeId, spend);
  if (malformed) {
    logToAxiom({
      type: 'warning',
      name: 'challenge-swiss-malformed',
      challengeId: ctx.challengeId,
      calls,
      malformed,
    }).catch(() => undefined);
  }
  return calls;
}

/**
 * How far through the challenge we are, 0..1. Drives the pacing ceiling, so a challenge with no
 * usable dates must not read as "finished" — that would hand day one the whole budget, which is
 * the arrival-cohort failure. Falls back to 0, i.e. the floor allowance.
 */
async function challengeProgress(challengeId: number): Promise<number> {
  const [row] = await dbRead.$queryRaw<{ startsAt: Date | null; endsAt: Date | null }[]>`
    SELECT "startsAt", "endsAt" FROM "Challenge" WHERE id = ${challengeId}
  `;
  if (!row?.startsAt || !row?.endsAt) return 0;
  const total = row.endsAt.getTime() - row.startsAt.getTime();
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (Date.now() - row.startsAt.getTime()) / total));
}

async function loadComparisonImages(imageIds: number[]): Promise<Map<number, ComparisonImage>> {
  const ids = [...new Set(imageIds)];
  if (!ids.length) return new Map();
  const rows = await dbRead.$queryRaw<{ id: number; url: string; nsfwLevel: number }[]>`
    SELECT id, url, "nsfwLevel" FROM "Image" WHERE id IN (${Prisma.join(ids)})
  `;
  return new Map(
    rows.map((row) => [row.id, { imageId: row.id, url: row.url, nsfwLevel: row.nsfwLevel }])
  );
}
