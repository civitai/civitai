import type { NextApiRequest, NextApiResponse } from 'next';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { publicApiContext2 } from '~/server/public-api-context';
import { handleEndpointError, PublicEndpoint } from '~/server/utils/endpoint-helpers';
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
    // civitai#3845 (population B): this catch used to be a hand-rolled copy of
    // `handleEndpointError` that had drifted — it kept the abort/TRPCError/parse
    // logic but NOT the genericization, so a `throwDbError`-wrapped driver error
    // still put raw invocation text on the wire at a 500, and the else-branch
    // serialized the whole error OBJECT (a Prisma error's enumerable own props
    // carry the table + column). Delegating removes the copy rather than patching
    // it; see `endpoint-helpers.ts` and `rest-envelope-ledger.test.ts`.
    handleEndpointError(res, error);
    return;
  }
});
