import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { heldGridCount } from '@civitai/shared/held-media';
import { logToAxiom } from '~/server/logging/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import type { SessionUser } from '~/types/session';

const subject = z.object({ userId: z.number().int().positive().max(2_147_483_647) });

/**
 * The CSAM report page's summary row, once per account it opens; each image is audited as it is
 * served. The row is against the account, and ModActivity has no details column, so the count rides
 * in `activity`.
 */
async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  res.setHeader('cache-control', 'private, no-store');
  if (!getFeatureFlags({ user, req }).csamReports)
    return void res.status(403).json({ error: 'Forbidden' });
  const grid = heldGridCount(req.body);
  const parsed = subject.safeParse(req.body);
  if (!grid || !parsed.success) return void res.status(400).json({ error: 'Bad count or user' });
  if (grid.clamped) console.warn('[held-media] grid count clamped', { moderatorId: user.id });

  const { userId } = parsed.data;
  await trackModActivity(user.id, {
    entityType: 'user',
    entityId: userId,
    activity: `heldMedia:grid:${grid.count}`,
  }).catch((e) => console.error('[held-media] audit row failed', e));
  logToAxiom({
    type: 'info',
    name: 'held-media-grid',
    moderatorId: user.id,
    userId,
    count: grid.count,
  }).catch(() => null);
  res.status(204).end();
}

export default ModEndpoint(handler, ['POST']);
