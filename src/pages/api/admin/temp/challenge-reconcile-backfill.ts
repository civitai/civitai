/**
 * One-time backfill: reconcile completed daily challenges whose entries finished
 * scanning AFTER the challenge closed, so late-rated entries get their participation
 * prize.
 * =============================================================================
 *
 * Mod-only admin route. Requires an authenticated moderator session.
 *
 * Usage:
 *   POST /api/admin/temp/challenge-reconcile-backfill
 *   Content-Type: application/json
 *
 * Body shape:
 *   {
 *     "action": "preview" | "run",
 *     "windowHours": 720,            // optional, default 720 (30d); rolling lookback fallback
 *     "challengeIds": [306, 305],    // optional; explicit targets
 *     "start": "2026-06-20",         // optional; with `end`, target a date range instead
 *     "end": "2026-06-22"            // optional; calendar-day INCLUSIVE (whole end day counted)
 *   }
 *
 * Targets (precedence: challengeIds > date range > windowHours):
 *   - challengeIds given → exactly those challenges.
 *   - start + end given  → completed challenges whose endsAt falls within [start, end]
 *     (both bounds calendar-day inclusive) that still have REVIEW CollectionItems.
 *   - otherwise → completed challenges within `windowHours` that still have REVIEW
 *     CollectionItems (same selector the hourly reconciliation job uses).
 *
 * Actions:
 *   preview - List target challenges + their stuck REVIEW item counts. No writes.
 *   run     - For each target run reconcileCompletedChallenge: re-promote now-rated
 *             entries (still skips nsfwLevel = 0) and back-pay newly-eligible
 *             non-winner, not-yet-paid users. Returns per-challenge
 *             { promoted, paid, buzzGranted } plus totals. `paid`/`buzzGranted` count
 *             only NET-NEW payees — users already paid at completion (or a prior run)
 *             are excluded, not just deduped at the Buzz API.
 *
 * Idempotency:
 *   Safe to re-run. Buzz uses externalTransactionId `challenge-entry-prize-{challengeId}-{userId}`
 *   (API-deduped) and paid users are recorded in Challenge.metadata.reconciliation.paidUserIds,
 *   so a second run pays 0 for already-handled users.
 *
 * Known limitations:
 *   - Net-new accuracy assumes every prior payout is accounted for: completion writes
 *     paidUserIds atomically with status=Completed, and reconcile appends after each run.
 *     reconcileCompletedChallenge also treats anyone already at/above the entry-prize threshold
 *     as already-paid. A user that OLD pre-feature completion failed to pay despite meeting the
 *     threshold therefore sits at/above threshold and is excluded here — they won't be back-paid.
 *     Recovering those would require checking the Buzz ledger by externalTransactionId (out of
 *     scope). Buzz dedup still guarantees nobody is ever double-paid.
 *   - Concurrent runs (the hourly reconcile job + this endpoint) on the SAME challenge race on
 *     the paidUserIds metadata write (last-write-wins). Money is safe (externalTransactionId
 *     dedup); only the bookkeeping list can drift. Avoid running both on one challenge at once.
 *   - `run` is sequential and capped at MAX_CHALLENGES per request to avoid a partial timeout;
 *     chunk larger backfills via date range or challengeIds.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { dbRead } from '~/server/db/client';
import {
  getChallengeConfig,
  challengeToLegacyFormat,
  getChallengesToReconcile,
  getChallengesToReconcileBetween,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { getChallengeById } from '~/server/games/daily-challenge/challenge-helpers';
import { reconcileCompletedChallenge } from '~/server/games/daily-challenge/challenge-rewards';
import { isDefined } from '~/utils/type-guards';

const schema = z
  .object({
    action: z.enum(['preview', 'run']),
    windowHours: z.number().positive().optional(),
    challengeIds: z.array(z.number()).optional(),
    start: z.coerce.date().optional(),
    end: z.coerce.date().optional(),
  })
  .refine((d) => (d.start ? !!d.end : !d.end), {
    message: 'start and end must be provided together',
  })
  .refine((d) => !d.start || !d.end || d.start <= d.end, {
    message: 'start must be on or before end',
  });

export default ModEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }

  const { action, challengeIds, windowHours = 720, start, end } = parsed.data;

  // Normalize the date range to whole UTC days so the bounds are calendar-day inclusive
  // regardless of any time component in the input (z.coerce.date also accepts ISO datetimes).
  // startNorm = 00:00 UTC of the start day; endExclusive = 00:00 UTC of the day AFTER the end
  // day, selected with endsAt < endExclusive — so e.g. end=2026-06-22 includes the challenge
  // that closed 2026-06-22 04:00 UTC.
  const startNorm = start
    ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
    : undefined;
  const endNorm = end
    ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()))
    : undefined;
  const endExclusive = endNorm
    ? new Date(endNorm.getTime() + 24 * 60 * 60 * 1000)
    : undefined;

  // Resolve target challenges. Precedence: explicit ids > date range > rolling window.
  const challenges = challengeIds?.length
    ? (await Promise.all(challengeIds.map((id) => getChallengeById(id))))
        .filter(isDefined)
        .map(challengeToLegacyFormat)
    : startNorm && endExclusive
    ? await getChallengesToReconcileBetween(startNorm, endExclusive)
    : await getChallengesToReconcile(windowHours);

  if (action === 'preview') {
    const plan = await Promise.all(
      challenges.map(async (challenge) => {
        const [row] = await dbRead.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*)::bigint as count
          FROM "CollectionItem"
          WHERE "collectionId" = ${challenge.collectionId} AND status = 'REVIEW'
        `;
        return {
          challengeId: challenge.challengeId,
          title: challenge.title,
          reviewItems: Number(row?.count ?? 0),
        };
      })
    );
    return res.status(200).json({
      action,
      windowHours,
      start: startNorm ?? null,
      end: endNorm ?? null,
      challengeCount: plan.length,
      plan,
    });
  }

  // action === 'run'
  // `run` processes challenges sequentially in a single HTTP request (bulk UPDATE + Buzz
  // batch + notification + metadata write each). Cap the per-request count so a wide window
  // can't blow the ingress/serverless timeout mid-run. Re-runs are idempotent, but chunk
  // large backfills via a narrower date range or explicit challengeIds.
  const MAX_CHALLENGES = 100;
  if (challenges.length > MAX_CHALLENGES) {
    return res.status(400).json({
      error: `Would process ${challenges.length} challenges in one request (max ${MAX_CHALLENGES}). Narrow the date range or pass challengeIds in batches to avoid a mid-run timeout.`,
      challengeCount: challenges.length,
    });
  }

  const config = await getChallengeConfig();
  const results: Array<{
    challengeId: number;
    title: string;
    promoted?: number;
    paid?: number;
    buzzGranted?: number;
    error?: string;
  }> = [];

  for (const challenge of challenges) {
    try {
      const { promoted, paid, buzzGranted } = await reconcileCompletedChallenge(challenge, config);
      results.push({
        challengeId: challenge.challengeId,
        title: challenge.title,
        promoted,
        paid,
        buzzGranted,
      });
    } catch (e) {
      results.push({
        challengeId: challenge.challengeId,
        title: challenge.title,
        error: (e as Error).message,
      });
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      promoted: acc.promoted + (r.promoted ?? 0),
      paid: acc.paid + (r.paid ?? 0),
      buzzGranted: acc.buzzGranted + (r.buzzGranted ?? 0),
    }),
    { promoted: 0, paid: 0, buzzGranted: 0 }
  );

  return res.status(200).json({
    action,
    windowHours,
    start: startNorm ?? null,
    end: endNorm ?? null,
    challengeCount: results.length,
    totals,
    results,
  });
}, ['POST']);
