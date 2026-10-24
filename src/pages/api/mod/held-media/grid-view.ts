import type { NextApiRequest, NextApiResponse } from 'next';
import { heldGridCount } from '@civitai/shared/held-media';
import { logToAxiom } from '~/server/logging/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import type { SessionUser } from '~/types/session';

/** The CSAM report page's one audit row per load of held media: the count, no image ids. */
async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  if (!getFeatureFlags({ user, req }).csamReports)
    return void res.status(403).json({ error: 'Forbidden' });
  const count = heldGridCount(req.body);
  if (count == null) return void res.status(400).json({ error: 'Bad count' });

  await trackModActivity(user.id, {
    entityType: 'heldMediaGrid',
    entityId: count,
    activity: 'heldMedia:grid',
  }).catch((e) => console.error('[held-media] audit row failed', e));
  logToAxiom({ type: 'info', name: 'held-media-grid', moderatorId: user.id, count }).catch(
    () => null
  );
  res.status(204).end();
}

export default ModEndpoint(handler, ['POST']);
