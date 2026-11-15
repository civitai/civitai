import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { resetPlayer } from '~/server/services/games/new-order.service';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

// The caller says how many active smites call for a reset (its own rule), so the number lives in one place; the floor
// only stops a bad value from resetting a player who has barely been smote.
const MIN_SMITE_LIMIT = 2;
const RESET_REASON = 'Your New Order career has been reset due to excessive smites.';

const schema = z.object({
  playerId: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().min(MIN_SMITE_LIMIT),
});

const activeSmites = (playerId: number) =>
  dbWrite.newOrderSmite.count({ where: { targetPlayerId: playerId, cleansedAt: null } });

// The Knights app calls this when a player's smites call for a reset, as the original game does in `smitePlayer`.
// Idempotent: the limit is checked here, and the reset cleanses the smites, so a repeated call is `not-due`.
// The lock makes check-and-reset one step, so two callers cannot both reset (the second finds the smites cleansed).
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { playerId, limit } = parsed.data;

  const outcome = await withDistributedLock(
    { key: `knights:reset-player:${playerId}`, ttl: 30, maxRetries: 20, autoRenew: true },
    async (): Promise<'reset' | 'not-due'> => {
      if ((await activeSmites(playerId)) < limit) return 'not-due';
      try {
        await resetPlayer({ playerId, withNotification: true, reason: RESET_REASON });
      } catch (error) {
        // The career is reset once its transaction commits; what follows (counters, signal, notification) is
        // best effort. A retry would see `not-due` and never redo it, so answer reset and leave a trace instead.
        if ((await activeSmites(playerId)) >= limit) throw error;
        const e = error as Error;
        await logToAxiom({
          type: 'error',
          name: 'knights-reset-side-effects-failed',
          details: { playerId },
          message: e.message,
          stack: e.stack,
        }).catch(() => undefined);
      }
      return 'reset';
    }
  );

  // Lock not acquired: another reset of this player is in flight. The caller retries.
  if (outcome === null) return res.status(503).json({ error: 'Reset in progress' });
  return res.status(200).json({ playerId, outcome });
});
