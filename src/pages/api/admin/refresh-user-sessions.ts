import type { AxiomAPIRequest } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { refreshSession } from '~/server/auth/session-invalidation';

// Refresh sessions for a targeted list of users — re-derives each user's session
// payload from the DB on their next request and signals active clients to
// refresh. Use when invalidateAllSessions (site-wide) is overkill.
//
// GET /api/admin/refresh-user-sessions?token=$WEBHOOK_TOKEN&userIds=1,2,3
// (also accepts a JSON body { "userIds": [1, 2, 3] } via POST)
const schema = z.object({
  userIds: z.preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z.array(z.coerce.number().int().positive()).min(1)
  ),
});

export default WebhookEndpoint(async function (req: AxiomAPIRequest, res: NextApiResponse) {
  const source = req.method === 'POST' ? req.body : req.query;
  const result = schema.safeParse(source);
  if (!result.success) {
    return res.status(400).json({ ok: false, error: result.error.flatten() });
  }

  const { userIds } = result.data;
  const refreshed: number[] = [];
  const failed: { userId: number; error: string }[] = [];

  for (const userId of userIds) {
    try {
      await refreshSession(userId);
      refreshed.push(userId);
    } catch (error) {
      failed.push({ userId, error: error instanceof Error ? error.message : 'unknown' });
    }
  }

  return res.status(200).json({ ok: true, refreshedCount: refreshed.length, refreshed, failed });
});
