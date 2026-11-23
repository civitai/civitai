import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import type { Session } from '~/types/session';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import {
  admitComicsRequest,
  comicsBrowsingLevel,
  getPublicComicChapter,
} from '~/server/utils/public-comics';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { booleanString } from '~/utils/zod-helpers';

/**
 * GET /api/v1/comics/{id}/chapters/{number} — one chapter's pages, `number` as the site shows it
 * (from 1). Pages are served whatever the creator's download setting: `allowDownload` false means
 * a client may show them but must not offer to save them. An early-access chapter is 403 until
 * its early access ends.
 */

const schema = z.object({
  id: z.coerce.number().int().gt(0).lte(2147483647),
  number: z.coerce.number().int().gt(0).lte(100000),
  nsfw: booleanString().optional(),
});

export default MixedAuthEndpoint(handler, ['GET'], { scope: { anyOf: [TokenScope.MediaRead] } });

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  if (!(await admitComicsRequest(req, res, user))) return;

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });

  try {
    const browsingLevel = comicsBrowsingLevel(req, res, parsed.data.nsfw);
    const result = await getPublicComicChapter(parsed.data.id, parsed.data.number, browsingLevel);
    // Not cached: early access ends, and chapters are published, within the edge TTL.
    if (result.status !== 200) res.setHeader('Cache-Control', 'no-store');
    if (result.status === 404) return res.status(404).json({ error: 'Chapter not found' });
    if (result.status === 403)
      return res.status(403).json({
        error: 'This chapter is in early access.',
        earlyAccessEndsAt: result.earlyAccessEndsAt,
      });
    return res.status(200).json(result.chapter);
  } catch (e) {
    return handleEndpointError(res, e);
  }
}
