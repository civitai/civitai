import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import type { Session } from '~/types/session';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { getNextPage } from '~/server/utils/pagination-helpers';
import {
  admitComicsRequest,
  comicsBrowsingLevel,
  listPublicComics,
  parseComicsCursor,
} from '~/server/utils/public-comics';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ComicGenre } from '~/shared/utils/prisma/enums';
import { booleanString } from '~/utils/zod-helpers';

const schema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(100).optional(),
  sort: z.enum(['Newest', 'MostFollowed', 'MostChapters']).default('Newest'),
  period: z.enum(['Day', 'Week', 'Month', 'Year', 'AllTime']).optional(),
  genre: z.nativeEnum(ComicGenre).optional(),
  username: z.string().max(100).optional(),
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
  const { nsfw, cursor, ...params } = parsed.data;
  // An empty cursor means the first page.
  const parsedCursor = cursor ? parseComicsCursor(cursor, params.sort) : undefined;
  if (parsedCursor === null) return res.status(400).json({ error: 'Invalid cursor' });

  try {
    const browsingLevel = comicsBrowsingLevel(req, res, nsfw);
    const { items, nextCursor } = await listPublicComics({
      ...params,
      cursor: parsedCursor,
      browsingLevel,
    });
    const { nextPage } = getNextPage({ req, nextCursor });
    return res.status(200).json({ items, metadata: { nextCursor, nextPage } });
  } catch (e) {
    return handleEndpointError(res, e);
  }
}
