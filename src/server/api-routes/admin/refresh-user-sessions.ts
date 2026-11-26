import type { AxiomAPIRequest } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import * as z from 'zod';
import { AdminTokenEndpoint } from '~/server/utils/endpoint-helpers';
import { refreshSession } from '~/server/auth/session-invalidation';

// Refresh sessions for a targeted list of users — re-derives each user's session
// payload from the DB on their next request and signals active clients to
// refresh. Use when invalidateAllSessions (site-wide) is overkill.
//
// POST /api/admin/refresh-user-sessions with header `x-admin-token: $SESSION_RESET_TOKEN` and a
// JSON body { "userIds": [1, 2, 3] }. No query string is accepted.
const schema = z.object({
  userIds: z.array(z.coerce.number().int().positive()).min(1),
});

export default AdminTokenEndpoint(
  'SESSION_RESET_TOKEN',
  async function (req: AxiomAPIRequest, res: NextApiResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ ok: false, error: result.error.flatten() });
    }

    const { userIds } = result.data;
    const refreshed: number[] = [];
    const failed: { userId: number; error: string }[] = [];

    for (const userId of userIds) {
      try {
        await refreshSession(userId, { caller: 'admin' });
        refreshed.push(userId);
      } catch (error) {
        failed.push({ userId, error: error instanceof Error ? error.message : 'unknown' });
      }
    }

    return res.status(200).json({ ok: true, refreshedCount: refreshed.length, refreshed, failed });
  },
  { audit: 'refresh-user-sessions' }
);
