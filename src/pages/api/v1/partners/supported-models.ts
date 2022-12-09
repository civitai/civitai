import { ModelFileType, Partner } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { NextApiRequest, NextApiResponse } from 'next';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';

import { appRouter } from '~/server/routers';
import { PartnerEndpoint } from '~/server/utils/endpoint-helpers';
import { getPaginationLinks } from '~/server/utils/pagination-helpers';

export default PartnerEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  partner: Partner
) {
  res.status(204);
});
