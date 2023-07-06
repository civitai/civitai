import { MetricTimeframe, NsfwLevel } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { isProd } from '~/env/other';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { usernameSchema } from '~/server/schema/user.schema';
import { getAllImages } from '~/server/services/image.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getPagination } from '~/server/utils/pagination-helpers';
import { QS } from '~/utils/qs';
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
  period: z.nativeEnum(MetricTimeframe).default(constants.galleryFilterDefaults.period),
  sort: z.nativeEnum(ImageSort).default(constants.galleryFilterDefaults.sort),
  nsfw: z
    .union([z.nativeEnum(NsfwLevel), booleanString()])
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      if (typeof value === 'boolean') return value ? NsfwLevel.X : NsfwLevel.None;
      return value;
    }),
  tags: commaDelimitedNumberArray({ message: 'tags should be a number array' }).optional(),
  cursor: numericString().optional(),
});

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const reqParams = imagesEndpointSchema.safeParse(req.query);
  if (!reqParams.success) return res.status(400).json({ error: reqParams.error });

  // Handle pagination
  const { limit, page, cursor, ...data } = reqParams.data;
  let skip: number | undefined;
  const usingPaging = page && !cursor;
  if (usingPaging) {
    ({ skip } = getPagination(limit, page));
    if (skip && skip * limit > 10000)
      // Enforce new paging limit
      return res
        .status(429)
        .json({ error: "You've requested too many pages, please use cursors instead" });
  }

  const { items, nextCursor } = await getAllImages({
    ...data,
    limit,
    skip,
    cursor,
    periodMode: 'published',
    include: ['count'],
  });

  const metadata: Metadata = {
    nextCursor: Number(nextCursor),
  };
  if (usingPaging) {
    metadata.currentPage = page;
    metadata.pageSize = limit;
  }
  metadata.nextPage = getNextPage({ req, ...metadata });

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
    metadata,
  });
});

type Metadata = {
  currentPage?: number;
  pageSize?: number;
  nextCursor?: number;
  nextPage?: string;
};

function getNextPage({
  req,
  currentPage,
  nextCursor,
}: {
  req: NextApiRequest;
  nextCursor?: number;
  currentPage?: number;
}) {
  const baseUrl = new URL(
    req.url ?? '/',
    isProd ? `https://${req.headers.host}` : 'http://localhost:3000'
  );

  const hasNextPage = !!nextCursor;
  if (!hasNextPage) return undefined;

  const queryParams: Record<string, any> = { ...req.query };
  if (currentPage) queryParams.page = currentPage + 1;
  else queryParams.cursor = nextCursor;

  return `${baseUrl.origin}${baseUrl.pathname}?${QS.stringify(queryParams)}`;
}
