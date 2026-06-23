/**
 * Debug endpoint — manually run participation reconciliation for ONE challenge.
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query
 * param (see WebhookEndpoint). Not reachable without the secret; no public UI.
 *
 * Usage:
 *   POST /api/testing/challenge-reconcile?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "challengeId": 306 }
 *
 * Actions:
 *   (single action — reconcile)
 *   POST body: { challengeId: number }
 *   Returns:   { promoted: number, paid: number }
 *
 * Idempotent: a second call on the same challenge returns { promoted: 0, paid: 0 }
 * because participants are already promoted/recorded.
 *
 * Permanent changes are scoped to a single challengeId per call so a
 * misuse never cascades across the DB.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import {
  getChallengeConfig,
  challengeToLegacyFormat,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { getChallengeById } from '~/server/games/daily-challenge/challenge-helpers';
import { reconcileCompletedChallenge } from '~/server/games/daily-challenge/challenge-rewards';

const schema = z.object({ challengeId: z.number() });

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.safeParse(req.body);
  if (!payload.success) {
    return res.status(400).json({ error: 'Invalid request', issues: payload.error.issues });
  }

  const { challengeId } = payload.data;
  const record = await getChallengeById(challengeId);
  if (!record) return res.status(404).json({ error: 'challenge not found' });

  const config = await getChallengeConfig();
  const result = await reconcileCompletedChallenge(challengeToLegacyFormat(record), config);
  return res.status(200).json(result);
});
