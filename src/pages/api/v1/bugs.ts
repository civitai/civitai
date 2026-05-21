import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { publicApiContext2 } from '~/server/createContext';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiCaller = await publicApiContext2(req, res);
  try {
    const { limit, cursor, statuses, includeClosed, tags, search } = req.query as Record<
      string,
      string | string[] | undefined
    >;

    const parsedStatuses = Array.isArray(statuses)
      ? statuses
      : typeof statuses === 'string'
      ? statuses
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const parsedTags = Array.isArray(tags)
      ? tags
      : typeof tags === 'string'
      ? tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const { items, nextCursor } = await apiCaller.bug.getInfinite({
      limit: limit ? Number(limit) : undefined,
      cursor: cursor ? Number(cursor) : undefined,
      statuses: parsedStatuses,
      includeClosed: includeClosed === 'true',
      tags: parsedTags,
      search: typeof search === 'string' ? search : undefined,
    });

    return res.status(200).json({ items, metadata: { nextCursor } });
  } catch (error) {
    if (error instanceof TRPCError) {
      const status = getHTTPStatusCodeFromError(error);
      const parsedError = (() => {
        try {
          return JSON.parse(error.message);
        } catch {
          return { message: error.message };
        }
      })();
      res.status(status).json(parsedError);
    } else {
      res.status(500).json({ message: 'An unexpected error occurred', error });
    }
  }
});
