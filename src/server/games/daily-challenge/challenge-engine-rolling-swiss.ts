import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import {
  incrementOperationSpent,
  operationBudgetRemaining,
} from '~/server/games/daily-challenge/challenge-helpers';
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
import { isContentRefusal } from '~/server/games/daily-challenge/challenge-judge-routes';
import {
  buildGroupComparisonPrompt,
  compareGroup,
  type ComparisonImage,
} from '~/server/games/daily-challenge/challenge-pairwise';
import * as store from '~/server/games/daily-challenge/challenge-pairwise-store';
import {
  budgetCallCap,
  DEFAULT_BOUT_BUDGET,
  GROUP_SIZE,
  planGroups,
  RELATIONS_PER_CALL,
  relationsFromRanking,
  swissStandings,
  tickCallBudget,
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

  /**
   * One tick's share of the work. The engine reads its own standings for the pool, paces itself
   * against the challenge clock, and stops at the caller's deadline whichever comes first.
   */
  async advance(ctx: JudgingEngineContext, deadlineMs: number): Promise<number> {
    const standings = await store.getStandings(ctx.challengeId);
    if (standings.length < GROUP_SIZE) return 0;

    const { progress, callsSoFar } = await challengeClock(ctx.challengeId);
    const { remaining, spent } = await operationBudgetRemaining(ctx.challengeId);

    // Two independent caps: the clock decides how much work is DUE, the budget decides how much is
    // AFFORDABLE. Both are applied at plan time — a spend ceiling enforced inside concurrent lanes
    // is not a ceiling (see `budgetCallCap`).
    const maxCalls = Math.min(
      tickCallBudget({
        fieldSize: standings.length,
        callsSoFar,
        progress,
        budget: DEFAULT_BOUT_BUDGET,
      }),
      budgetCallCap({ budgetRemaining: remaining, spentSoFar: spent, callsSoFar })
    );
    if (maxCalls < 1 || Date.now() >= deadlineMs) {
      if (remaining != null && remaining <= 0) {
        logToAxiom({
          type: 'warning',
          name: 'challenge-swiss-budget-exhausted',
          challengeId: ctx.challengeId,
          field: standings.length,
          spent,
        }).catch(() => undefined);
      }
      return 0;
    }

    const pass = await runGroups(
      ctx,
      standings.map((row) => ({ imageId: row.imageId })),
      maxCalls,
      progress,
      deadlineMs
    );
    return pass.calls;
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
      // The spend ceiling has to be re-read each pass and applied here too. Settling at close was
      // originally unbounded, which would have made the budget a limit on ticks only — the one
      // moment a runaway is most likely is the moment it was exempt.
      const { remaining, spent } = await operationBudgetRemaining(ctx.challengeId);
      const { callsSoFar } = await challengeClock(ctx.challengeId);
      const affordable = budgetCallCap({
        budgetRemaining: remaining,
        spentSoFar: spent,
        callsSoFar,
      });
      if (affordable < 1) {
        logToAxiom({
          type: 'warning',
          name: 'challenge-swiss-budget-exhausted',
          challengeId: ctx.challengeId,
          stage: 'close',
          field: eligible.length,
          spent,
        }).catch(() => undefined);
        break;
      }

      const pass = await runGroups(ctx, eligible, affordable, 1);
      calls += pass.calls;
      // 🔴 A pass that PLANNED work and completed none of it is a provider outage, not a settled
      // field, and the two must not both end the loop. Ranking an unmeasured field is not a
      // degraded ranking: with no comparison rows every entry scores the same 0.5 in `strength`,
      // so `swissStandings` falls through to its `imageId` tiebreak and the caller pays prizes on
      // upload order. Throwing leaves the challenge in 'Completing' for a later run to judge
      // properly — which is what the whole tick did before groups were caught individually.
      // `advance` deliberately keeps the tolerant behaviour; it is only at close that giving up
      // quietly costs money.
      if (pass.calls === 0 && pass.failed > 0) {
        throw new Error(
          `swiss close: ${pass.failed} of ${pass.planned} groups failed and none succeeded`
        );
      }
      if (pass.calls === 0) break;
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
type GroupPass = { calls: number; planned: number; failed: number };

async function runGroups(
  ctx: JudgingEngineContext,
  pool: { imageId: number }[],
  maxCalls: number,
  progress: number,
  deadlineMs?: number
): Promise<GroupPass> {
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
  if (!groups.length) return { calls: 0, planned: 0, failed: 0 };

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
  let unloadable = 0;
  let failed = 0;
  let refused = 0;
  let writeFailed = 0;
  const failedGroups: string[] = [];
  let firstError: string | undefined;
  let firstWriteError: string | undefined;
  let buzz = 0;

  try {
    await runPool(groups, LADDER_CONCURRENCY, async (group) => {
      // Checked per group rather than once up front: the deadline is what holds when the provider is
      // slower than we assumed, and a limit that is only tested before the work starts cannot do that.
      // The SPEND ceiling is deliberately not here — it is applied when groups are planned, because a
      // check inside concurrent lanes all read zero before any lane has paid for anything.
      if (deadlineMs != null && Date.now() >= deadlineMs) return;

      const groupImages = group
        .map((entry) => images.get(entry.imageId))
        .filter((image): image is ComparisonImage => !!image);
      // A group we cannot fully load is not a group. Comparing the remainder would silently change
      // the question from "rank four" to "rank three" and bill for it.
      if (groupImages.length !== group.length) {
        unloadable++;
        return;
      }

      // One group's failure must cost one group. `runPool` stops dispatching on the first rejection
      // and rethrows it, so an error escaping here abandoned every group not yet started AND the
      // whole review tick around it.
      //
      // The comparison and the writes are caught SEPARATELY. They are not one failure: a provider
      // that never answered cost nothing and wrote nothing, while a failed write means the call was
      // made, was billed, and left some of its six rows behind. They point at different systems and
      // one counter cannot say which happened.
      let verdict: Awaited<ReturnType<typeof compareGroup>>;
      try {
        verdict = await compareGroup({ systemPrompt, group: groupImages });
      } catch (error) {
        failed++;
        if (isRefusal(error)) refused++;
        // A group of four fails as a UNIT, so no single failure attributes to an entry. The
        // membership is logged so attribution can be done across ticks by intersection — an image in
        // every failed group and no successful one is the suspect.
        if (failedGroups.length < MAX_LOGGED_FAILED_GROUPS)
          failedGroups.push(groupImages.map((image) => image.imageId).join(','));
        firstError ??= describeError(error);
        return;
      }

      calls++;
      buzz += verdict.buzzCost;
      if (!verdict.order) {
        malformed++;
        return;
      }

      try {
        // Written against the SNAPSHOT's played set, so a pair another lane recorded in the meantime
        // is still attempted here and lands on the conflict clause rather than being skipped by a
        // read that raced. Cheap either way: it is one row, not one call.
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
      } catch (error) {
        writeFailed++;
        firstWriteError ??= describeError(error);
      }
    });
  } finally {
    // Billed whatever happens to the pool: `buzz` grows the moment a call returns, so anything
    // already paid for is in it even on a path that throws past this point.
    const spend = Math.ceil(buzz);
    if (spend > 0) await incrementOperationSpent(ctx.challengeId, spend);
  }

  if (failed) {
    logToAxiom({
      type: 'warning',
      name: 'challenge-swiss-group-failed',
      challengeId: ctx.challengeId,
      planned: groups.length,
      calls,
      failed,
      // `message` is the OpenRouter envelope and is generic for a refusal; `refused` is the
      // classified answer, read out of the raw body by `isContentRefusal`.
      refused,
      failedGroups,
      // The list is capped, so it stops being the count as soon as a whole field fails.
      failedGroupsTruncated: failed > failedGroups.length,
      message: firstError,
    }).catch(() => undefined);
  }
  if (writeFailed) {
    // Points at the DATABASE, not the provider: the call was made and billed, and some of the
    // group's six relation rows landed. `recordComparison` is one statement per row with no
    // transaction around them, so a partial group is biased — `relationsFromRanking` emits pairs in
    // ranking order, so the rows that land first are the ones the group's leader wins.
    logToAxiom({
      type: 'warning',
      name: 'challenge-swiss-write-failed',
      challengeId: ctx.challengeId,
      planned: groups.length,
      calls,
      writeFailed,
      message: firstWriteError,
    }).catch(() => undefined);
  }
  if (unloadable) {
    // A group whose images would not load is NOT a group that failed and not one that succeeded.
    // Three names rather than one counter, so a provider outage and a deleted image do not read as
    // the same event.
    logToAxiom({
      type: 'warning',
      name: 'challenge-swiss-group-unloadable',
      challengeId: ctx.challengeId,
      planned: groups.length,
      unloadable,
    }).catch(() => undefined);
  }
  if (malformed) {
    logToAxiom({
      type: 'warning',
      name: 'challenge-swiss-malformed',
      challengeId: ctx.challengeId,
      calls,
      malformed,
    }).catch(() => undefined);
  }
  return { calls, planned: groups.length, failed };
}

/**
 * A cap on the ids one tick reports. Attribution wants membership, not a transcript, and a field-
 * wide outage at close can plan hundreds of groups against an unset `operationBudget`.
 */
const MAX_LOGGED_FAILED_GROUPS = 20;

/**
 * 🔴 Both of these run INSIDE the catch that exists to stop a failure escaping. `isContentRefusal`
 * reads `.message`, `.body` and `.data$.body$` off the thrown value unguarded, and `String(error)`
 * calls `toString` — a throwing accessor on either would escape `runPool` and abandon the tick,
 * which is the exact bug this file was changed to remove.
 */
function isRefusal(error: unknown): boolean {
  try {
    return isContentRefusal(error);
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unserializable error';
  }
}

/**
 * How far through the challenge we are (0..1) and how many calls have already been spent on it.
 *
 * 🔴 A challenge with no usable dates reads as 0, never as finished. Reading it as finished would
 * open the full budget on day one, which is exactly the eager-spend failure that partitions the
 * field into arrival cohorts — top-1 0.35 against 0.775, measured.
 *
 * `callsSoFar` is derived from the recorded relations rather than counted, for the same reason
 * `getSwissState` derives its tallies: a counter that a dropped row can desynchronise is worse than
 * an extra scan. It is a floor when a call's relations were all already owned, which makes the
 * pacing slightly generous and never runaway.
 */
async function challengeClock(
  challengeId: number
): Promise<{ progress: number; callsSoFar: number }> {
  const [[row], [spend]] = await Promise.all([
    dbRead.$queryRaw<{ startsAt: Date | null; endsAt: Date | null }[]>`
      SELECT "startsAt", "endsAt" FROM "Challenge" WHERE id = ${challengeId}
    `,
    dbRead.$queryRaw<{ relations: bigint }[]>`
      SELECT COUNT(*) AS relations FROM "ChallengeEntryComparison"
      WHERE "challengeId" = ${challengeId} AND "phase" = 'swiss'
    `,
  ]);

  const callsSoFar = Math.ceil(Number(spend?.relations ?? 0) / RELATIONS_PER_CALL);
  if (!row?.startsAt || !row?.endsAt) return { progress: 0, callsSoFar };
  const total = row.endsAt.getTime() - row.startsAt.getTime();
  if (total <= 0) return { progress: 0, callsSoFar };
  const progress = Math.min(1, Math.max(0, (Date.now() - row.startsAt.getTime()) / total));
  return { progress, callsSoFar };
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
