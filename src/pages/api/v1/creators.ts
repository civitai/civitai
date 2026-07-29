import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { publicApiContext2 } from '~/server/createContext';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { isClientAbortError } from '~/server/utils/errorHandling';
import { getPaginationLinks } from '~/server/utils/pagination-helpers';

type CreatorItem = {
  username: string | null;
  image?: string | null;
  // Published-model count is computed in the DB via Prisma `_count` (see
  // getCreatorsHandler) instead of fetching every model row.
  _count?: { models?: number } | null;
};

/**
 * Map a getCreators item to the public v1 response shape. Exported (and pure) so
 * the modelCount derivation from `_count.models` is unit-testable without the
 * Next API handler harness. Keeps the historical shape: modelCount is omitted
 * (undefined) when zero/absent.
 */
export function mapCreatorItem({ _count, username, image }: CreatorItem, baseUrlOrigin: string) {
  return {
    username,
    modelCount: _count?.models ? _count.models : undefined,
    link: `${baseUrlOrigin}/api/v1/models?username=${username}`,
    image: image ? getEdgeUrl(image, { width: 96, name: username ?? undefined }) : undefined,
  };
}

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiCaller = await publicApiContext2(req, res);
  try {
    const { items, ...metadata } = await apiCaller.user.getCreators(req.query);
    const { nextPage, prevPage, baseUrl } = getPaginationLinks({ ...metadata, req });

    return res.status(200).json({
      items: items.map((item) => mapCreatorItem(item, baseUrl.origin)),
      metadata: {
        ...metadata,
        nextPage,
        prevPage,
      },
    });
  } catch (error) {
    if (isClientAbortError(error)) {
      // Client disconnected mid-request — not a server fault. 499, not 500.
      if (!res.headersSent) res.status(499).end();
      return;
    }
    if (error instanceof TRPCError) {
      const status = getHTTPStatusCodeFromError(error);
      // Some TRPCErrors carry a JSON-stringified body (zod/validation); others
      // (throwDbError-wrapped INTERNAL_SERVER_ERRORs) carry a plain string. A
      // blind JSON.parse on the plain-string case throws, escapes this catch,
      // and surfaces a raw unhandled 500 — so guard it with a fallback.
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
