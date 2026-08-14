import { TagTarget } from '~/shared/utils/prisma/enums';
import type { NextApiRequest, NextApiResponse } from 'next';
import { publicApiContext2 } from '~/server/createContext';

import { handleEndpointError, PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getPaginationLinks } from '~/server/utils/pagination-helpers';

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiCaller = await publicApiContext2(req, res);
  try {
    const { items, ...metadata } = await apiCaller.tag.getAll({
      ...req.query,
      withModels: true,
      entityType: [TagTarget.Model],
    });
    const { nextPage, prevPage, baseUrl } = getPaginationLinks({
      ...metadata,
      req,
    });

    res.status(200).json({
      items:
        items?.map(({ models = [], name }) => ({
          name,
          link: `${baseUrl.origin}/api/v1/models?tag=${name}`,
        })) ?? [],
      metadata: {
        ...metadata,
        nextPage,
        prevPage,
      },
    });
  } catch (error) {
    // civitai#3845 (population B) — see the note on `v1/creators.ts`. Same
    // hand-rolled copy, same drift, same delegation.
    handleEndpointError(res, error);
    return;
  }
});
