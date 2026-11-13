import type { NextApiRequest, NextApiResponse } from 'next';
import {
  parseResyncUserIds,
  resyncTipaltiPayees,
} from '~/server/services/tipalti-payee-resync.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * Re-reads each user's Tipalti payee and sets tipaltiPaymentsEnabled/status from it.
 * Dry run unless `dryRun=false` is passed on a POST.
 *   GET|POST /api/mod/tipalti-resync-payee?userIds=1,2            -> report only
 *   POST     /api/mod/tipalti-resync-payee?userIds=1&dryRun=false -> write
 */
export default ModEndpoint(
  async (req: NextApiRequest, res: NextApiResponse, user) => {
    const parsed = parseResyncUserIds(req.query.userIds);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    const dryRun = req.query.dryRun !== 'false';
    if (!dryRun && req.method !== 'POST')
      return res.status(405).json({ error: 'dryRun=false requires POST' });

    const rows = await resyncTipaltiPayees({ userIds: parsed.userIds, dryRun, actorId: user.id });
    return res.status(200).json({ dryRun, rows });
  },
  ['GET', 'POST']
);
