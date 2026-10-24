/**
 * One-off recovery tool for a challenge whose review phase was lost (e.g. a judge-provider outage)
 * and which then completed with no winners. Delete after use.
 *
 * Mod-only. POST /api/admin/temp/challenge-review-replay
 *
 *   { "challengeId": 601, "step": "review", "cursor": "<ISO>" }
 *     Starts replaying the original 10-minute review ticks from `cursor` (default: the challenge
 *     start) through `endsAt + 10min` in the background, and answers 202 at once: one tick can
 *     outlast the request timeout. Each tick logs `challenge-review-replay` to Axiom with the
 *     next cursor, so an interrupted run resumes from the last one logged. Re-running is safe:
 *     entries the judge already commented on are skipped.
 *
 *   { "challengeId": 601, "step": "status" }
 *     Whether a replay is running on this pod, and how many entries are judged so far.
 *
 *   { "challengeId": 601, "step": "winners" }
 *     Reopens the Completed challenge and runs the normal winner pick and payout.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { getChallengeById } from '~/server/games/daily-challenge/challenge-helpers';
import {
  challengeToLegacyFormat,
  getChallengeConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  challengeReviewInternals,
  pickWinnersForChallenge,
} from '~/server/jobs/daily-challenge-processing';
import { logToAxiom } from '~/server/logging/client';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';

const TICK_MS = 10 * 60 * 1000;

const schema = z.object({
  challengeId: z.number().int().positive(),
  step: z.enum(['review', 'status', 'winners']),
  cursor: z.coerce.date().optional(),
});

// Per pod only: call `review` once, and check `status` before starting another.
const running = new Set<number>();

async function countWinners(challengeId: number) {
  const [row] = await dbWrite.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "ChallengeWinner" WHERE "challengeId" = ${challengeId}
  `;
  return Number(row?.count ?? 0);
}

async function countJudged(collectionId: number, judgedTagId: number) {
  const [row] = await dbWrite.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "CollectionItem"
    WHERE "collectionId" = ${collectionId}
      AND "tagId" = ${judgedTagId}
      AND note IS NOT NULL
  `;
  return Number(row?.count ?? 0);
}

export default ModEndpoint(
  async function (req: NextApiRequest, res: NextApiResponse) {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
    }
    const { challengeId, step, cursor } = parsed.data;

    const challenge = await getChallengeById(challengeId);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
    if (!challenge.collectionId)
      return res.status(400).json({ error: 'Challenge has no collection' });

    if (challenge.status !== ChallengeStatus.Completed) {
      return res.status(400).json({ error: `Challenge is ${challenge.status}, not Completed` });
    }
    if ((await countWinners(challengeId)) > 0) {
      return res.status(400).json({ error: 'Challenge already has winners' });
    }

    const details = challengeToLegacyFormat(challenge);
    const config = await getChallengeConfig();
    const judgedCount = await countJudged(challenge.collectionId, config.judgedTagId);

    if (step === 'status') {
      return res.status(200).json({ running: running.has(challengeId), judgedCount });
    }

    if (step === 'review') {
      if (running.has(challengeId)) {
        return res.status(409).json({ error: 'A replay is already running on this pod' });
      }
      const collectionId = challenge.collectionId;
      // Entries are promoted up to endsAt (plus a few seconds), so the last window must reach past it.
      const lastTickStart = challenge.endsAt.getTime() + TICK_MS;
      const firstTickStart = (cursor ?? challenge.startsAt).getTime();

      running.add(challengeId);
      void (async () => {
        let tickStart = firstTickStart;
        try {
          while (tickStart < lastTickStart) {
            await challengeReviewInternals.reviewEntriesForChallenge(details, {
              replayWindow: { from: new Date(tickStart), to: new Date(tickStart + TICK_MS) },
            });
            tickStart += TICK_MS;
            logToAxiom({
              type: 'info',
              name: 'challenge-review-replay',
              challengeId,
              nextCursor: tickStart < lastTickStart ? new Date(tickStart).toISOString() : null,
              judgedCount: await countJudged(collectionId, config.judgedTagId),
            }).catch(() => undefined);
          }
        } catch (e) {
          logToAxiom({
            type: 'error',
            name: 'challenge-review-replay',
            challengeId,
            cursor: new Date(tickStart).toISOString(),
            message: (e as Error).message,
          }).catch(() => undefined);
        } finally {
          running.delete(challengeId);
        }
      })();

      return res.status(202).json({
        started: true,
        from: new Date(firstTickStart).toISOString(),
        ticks: Math.ceil((lastTickStart - firstTickStart) / TICK_MS),
        judgedCount,
      });
    }

    if (judgedCount === 0) {
      return res.status(400).json({ error: 'No judged entries; run the review step first' });
    }

    const { count } = await dbWrite.challenge.updateMany({
      where: { id: challengeId, status: ChallengeStatus.Completed },
      data: { status: ChallengeStatus.Active },
    });
    if (count !== 1)
      return res.status(409).json({ error: 'Challenge status changed concurrently' });

    try {
      await pickWinnersForChallenge(details, config);
    } catch (e) {
      logToAxiom({
        type: 'error',
        name: 'challenge-review-replay',
        challengeId,
        step: 'winners',
        message: (e as Error).message,
      }).catch(() => undefined);
      // Left Active on purpose: the hourly completion job's recovery picks it up from here.
      return res.status(500).json({
        error: 'Winner pick failed; the error is logged to Axiom as challenge-review-replay',
        status: ChallengeStatus.Active,
      });
    }

    const [after] = await dbRead.$queryRaw<{ status: string }[]>`
    SELECT status::text FROM "Challenge" WHERE id = ${challengeId}
  `;
    const winners = await dbWrite.$queryRaw<
      { userId: number; imageId: number | null; place: number; buzzAwarded: number }[]
    >`
    SELECT "userId", "imageId", place, "buzzAwarded"
    FROM "ChallengeWinner"
    WHERE "challengeId" = ${challengeId}
    ORDER BY place
  `;
    return res.status(200).json({ status: after?.status ?? null, judgedCount, winners });
  },
  ['POST']
);
