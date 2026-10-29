import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { resetPlayer } from '~/server/services/games/new-order.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const SMITE_LIMIT = 3;
const RESET_REASON = 'Your New Order career has been reset due to excessive smites.';

const schema = z.object({ playerId: z.coerce.number().int().positive() });

// The Knights app calls this when a player's smites call for a reset, as the original game does in `smitePlayer`.
// Idempotent: the limit is checked here, and the reset cleanses the smites, so a repeated call is `not-due`.
// The Knights career-reset notice finds the reset by RESET_REASON.
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { playerId } = parsed.data;

  const active = await dbWrite.newOrderSmite.count({
    where: { targetPlayerId: playerId, cleansedAt: null },
  });
  if (active < SMITE_LIMIT) return res.status(200).json({ playerId, outcome: 'not-due' });

  await resetPlayer({ playerId, withNotification: true, reason: RESET_REASON });
  return res.status(200).json({ playerId, outcome: 'reset' });
});
