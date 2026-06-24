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

  // End bound is calendar-day inclusive: extend to the start of the day AFTER `end` and
  // select endsAt < that, so e.g. end=2026-06-22 includes the challenge that closed 06-22.
  const endExclusive = end ? new Date(end.getTime() + 24 * 60 * 60 * 1000) : undefined;

  // Resolve target challenges. Precedence: explicit ids > date range > rolling window.
  const challenges = challengeIds?.length
    ? (await Promise.all(challengeIds.map((id) => getChallengeById(id))))
        .filter(isDefined)
        .map(challengeToLegacyFormat)
    : start && endExclusive
    ? await getChallengesToReconcileBetween(start, endExclusive)
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
      start: start ?? null,
      end: end ?? null,
      challengeCount: plan.length,
      plan,
    });
  }

  // action === 'run'
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
    start: start ?? null,
    end: end ?? null,
    challengeCount: results.length,
    totals,
    results,
  });
}, ['POST']);
