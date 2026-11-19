import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import type { Session } from '~/types/session';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import {
  admitComicsRequest,
  comicsBrowsingLevel,
  getPublicComic,
} from '~/server/utils/public-comics';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { booleanString } from '~/utils/zod-helpers';

/** GET /api/v1/comics/{id} — one published comic and its chapter list, without page images. */

const schema = z.object({
  id: z.coerce.number().int().gt(0).lte(2147483647),
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
    const comic = await getPublicComic(parsed.data.id, browsingLevel);
    if (!comic) return res.status(404).json({ error: 'Comic not found' });
    return res.status(200).json(comic);
  } catch (e) {
    return handleEndpointError(res, e);
  }
}
