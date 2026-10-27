import * as z from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import {
  getServiceDealFileDownloadUrl,
  resolveServiceDealFileDownload,
} from '~/server/services/creator-service-deal-file.service';

const querySchema = z.object({ fileId: z.coerce.number().int().positive() });

/**
 * Sends a party to a short-lived signed URL for one delivery file. Deliberately NOT behind the
 * `creatorServices` flag: a buyer's paid files must stay reachable when the flag is off. Every
 * refusal is the same 404, so a file id reveals nothing about who it belongs to.
 */
export default AuthedEndpoint(async function downloadServiceDealFile(req, res, user) {
  // A signed redirect is per-user; never let an edge cache hand it to anyone else.
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const query = querySchema.safeParse(req.query);
  if (!query.success) return res.status(404).json({ error: 'Not found' });

  const target = await resolveServiceDealFileDownload({
    fileId: query.data.fileId,
    userId: user.id,
    isModerator: !!user.isModerator,
  });
  if (!target) return res.status(404).json({ error: 'Not found' });

  return res.redirect(await getServiceDealFileDownloadUrl(target, new Tracker(req, res)));
});
