import { MetricTimeframe } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { usernameSchema } from '~/server/schema/user.schema';
import { getAllImages } from '~/server/services/image.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import {
  getPagination,
  getPaginationLinks,
  getPagingData,
} from '~/server/utils/pagination-helpers';
import { numericString } from '~/utils/zod-helpers';

export const config = {
  api: {
    responseLimit: false,
  },
};

const imagesEndpointSchema = z.object({
  limit: numericString(z.number().min(0).max(200)).default(100),
  page: numericString().optional(),
  postId: numericString().optional(),
  modelId: numericString().optional(),
  modelVersionId: numericString().optional(),
  username: usernameSchema.optional(),
  period: z.nativeEnum(MetricTimeframe).default(constants.galleryFilterDefaults.period),
  sort: z.nativeEnum(ImageSort).default(constants.galleryFilterDefaults.sort),
});

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const reqParams = imagesEndpointSchema.safeParse(req.query);
  if (!reqParams.success) return res.status(400).json({ error: reqParams.error });

  const { limit, page, ...data } = reqParams.data;
  const { skip } = getPagination(limit, page);
  const { items, ...metadata } = getPagingData(
    await getAllImages({ ...data, limit, skip, include: ['count'] }),
    limit,
    page
  );

  const { nextPage, prevPage } = getPaginationLinks({ ...metadata, req });

  res.status(200).json({
    items: items.map((image) => ({
      url: getEdgeUrl(image.url, { width: 450 }),
      id: image.id,
      hash: image.hash,
      width: image.width,
      height: image.height,
      nsfw: image.nsfw,
    })),
    metadata: {
      ...metadata,
      nextPage,
      prevPage,
    },
  });
});
