import { MetricTimeframe, NsfwLevel } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ImageSort } from '~/server/common/enums';
import { usernameSchema } from '~/server/schema/user.schema';
import { getAllImages } from '~/server/services/image.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import {
  getPagination,
  getPaginationLinks,
  getPagingData,
} from '~/server/utils/pagination-helpers';
import { booleanString, commaDelimitedNumberArray, numericString } from '~/utils/zod-helpers';

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
  imageId: numericString().optional(),
  username: usernameSchema.optional(),
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.AllTime),
  sort: z.nativeEnum(ImageSort).default(ImageSort.Newest),
  nsfw: z
    .union([z.nativeEnum(NsfwLevel), booleanString()])
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      if (typeof value === 'boolean') return value ? NsfwLevel.X : NsfwLevel.None;
      return value;
    }),
  tags: commaDelimitedNumberArray({ message: 'tags should be a number array' }).optional(),
});

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const reqParams = imagesEndpointSchema.safeParse(req.query);
  if (!reqParams.success) return res.status(400).json({ error: reqParams.error });

  const { limit, page, ...data } = reqParams.data;
  const { skip } = getPagination(limit, page);
  if (skip && skip > 100)
    return res.status(400).json({ error: 'Page is too high. We will add cursor support shortly' });
  const { items, ...metadata } = getPagingData(
    await getAllImages({ ...data, limit, skip, periodMode: 'published', include: ['count'] }),
    limit,
    page
  );

  const { nextPage, prevPage } = getPaginationLinks({ ...metadata, req });

  res.status(200).json({
    items: items.map((image) => ({
      id: image.id,
      url: getEdgeUrl(image.url, { width: image.width ?? 450 }),
      hash: image.hash,
      width: image.width,
      height: image.height,
      nsfwLevel: image.nsfw,
      nsfw: image.nsfw !== NsfwLevel.None,
      createdAt: image.createdAt,
      postId: image.postId,
      stats: {
        cryCount: image.stats?.cryCountAllTime ?? 0,
        laughCount: image.stats?.laughCountAllTime ?? 0,
        likeCount: image.stats?.likeCountAllTime ?? 0,
        dislikeCount: image.stats?.dislikeCountAllTime ?? 0,
        heartCount: image.stats?.heartCountAllTime ?? 0,
        commentCount: image.stats?.commentCountAllTime ?? 0,
      },
      meta: image.meta,
      username: image.user.username,
    })),
    metadata: {
      ...metadata,
      nextPage,
      prevPage,
    },
  });
});
