import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import dayjs from '~/shared/utils/dayjs';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { isProd } from '~/env/other';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { getAllImages, getAllImagesIndex } from '~/server/services/image.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { getPagination } from '~/server/utils/pagination-helpers';
import { baseModels } from '~/shared/constants/base-model.constants';
import {
  getNsfwLevelDeprecatedReverseMapping,
  nsfwBrowsingLevelsFlag,
  NsfwLevelDeprecated,
  nsfwLevelMapDeprecated,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { QS } from '~/utils/qs';
import {
  booleanString,
  commaDelimitedEnumArray,
  commaDelimitedNumberArray,
  numericString,
} from '~/utils/zod-helpers';
import { usernameSchema } from '~/shared/zod/username.schema';

export const config = {
  api: {
    responseLimit: false,
  },
};

// TODO merge with getInfiniteImagesSchema
const imagesEndpointSchema = z.object({
  limit: numericString(z.number().min(0).max(200)).default(constants.galleryFilterDefaults.limit),
  page: numericString().optional(),
  postId: numericString().optional(),
  modelId: numericString().optional(),
  modelVersionId: numericString().optional(),
  imageId: numericString().optional(),
  username: usernameSchema.optional(),
  userId: numericString().optional(),
  period: z.enum(MetricTimeframe).default(constants.galleryFilterDefaults.period),
  sort: z.enum(ImageSort).default(constants.galleryFilterDefaults.sort),
  nsfw: z
    .union([z.enum(NsfwLevelDeprecated), booleanString()])
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      if (typeof value === 'boolean')
        return value ? nsfwBrowsingLevelsFlag : publicBrowsingLevelsFlag;
      return nsfwLevelMapDeprecated[value] as number;
    }),
  browsingLevel: z.coerce.number().optional(),
  tags: commaDelimitedNumberArray().optional(),
  cursor: z
    .union([z.bigint(), z.number(), z.string(), z.date()])
    .transform((val) =>
      typeof val === 'string' && dayjs(val, 'YYYY-MM-DDTHH:mm:ss.SSS[Z]', true).isValid()
        ? new Date(val)
        : val
    )
    .optional(),
  type: z.enum(MediaType).optional(),
  baseModels: commaDelimitedEnumArray([...baseModels]).optional(),
  withMeta: booleanString().default(false),
  requiringMeta: booleanString().optional(),
});

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const reqParams = imagesEndpointSchema.safeParse(req.query);
    if (!reqParams.success) return res.status(400).json({ error: reqParams.error });

    const session = await getServerAuthSession({ req, res });

    // Handle pagination
    const { limit, page, cursor, nsfw, browsingLevel, type, withMeta, ...data } = reqParams.data;
    let skip: number | undefined;
    const usingPaging = page && !cursor;
    if (usingPaging) {
      if (page && page * limit > 1000) {
        // Enforce new paging limit
        return res
          .status(429)
          .json({ error: "You've requested too many pages, please use cursors instead" });
      }

      ({ skip } = getPagination(limit, page));
    }

    const _browsingLevel = browsingLevel ?? nsfw ?? publicBrowsingLevelsFlag;
    const fn = data.modelId || data.imageId ? getAllImages : getAllImagesIndex;

    const features = getFeatureFlags({ user: session?.user, req });

    const { items, nextCursor } = await fn({
      ...data,
      types: type ? [type] : undefined,
      limit,
      skip,
      cursor,
      include: ['metaSelect', 'tagIds', 'profilePictures'],
      periodMode: 'published',
      headers: { src: '/api/v1/images' },
      browsingLevel: _browsingLevel,
      withMeta,
      user: session?.user,
      disableMinor: true,
      disablePoi: true,
      useLogicalReplica: features.logicalReplica,
    });

    const metadata: Metadata = {
      nextCursor,
    };

    if (usingPaging) {
      metadata.currentPage = page;
      metadata.pageSize = limit;
    }
    metadata.nextPage = getNextPage({ req, ...metadata });

    res.status(200).json({
      items: items.map((image) => {
        const nsfw = getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel);

        return {
          id: image.id,
          url: getEdgeUrl(image.url, { width: image.width ?? 450, type: image.type }),
          hash: image.hash,
          width: image.width,
          height: image.height,
          nsfwLevel: nsfw,
          type: image.type,
          nsfw: nsfw !== NsfwLevelDeprecated.None,
          browsingLevel: image.nsfwLevel,
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
          baseModel: image.baseModel,
          modelVersionIds: image.modelVersionIds,
        };
      }),
      metadata,
    });
  } catch (error) {
    const trpcError = error as TRPCError;
    const statusCode = getHTTPStatusCodeFromError(trpcError);

    return res.status(statusCode).json({
      error: trpcError.message,
      code: trpcError.code,
    });
  }
});

type Metadata = {
  currentPage?: number;
  pageSize?: number;
  nextCursor?: string;
  nextPage?: string;
};

function getNextPage({
  req,
  currentPage,
  nextCursor,
}: {
  req: NextApiRequest;
  nextCursor?: string;
  currentPage?: number;
}) {
  const baseUrl = new URL(
    req.url ?? '/',
    isProd && req.headers.host ? `https://${req.headers.host}` : 'http://localhost:3000'
  );

  const hasNextPage = !!nextCursor;
  if (!hasNextPage) return undefined;

  const queryParams: Record<string, any> = { ...req.query };
  if (currentPage) queryParams.page = currentPage + 1;
  else queryParams.cursor = nextCursor;

  return `${baseUrl.origin}${baseUrl.pathname}?${QS.stringify(queryParams)}`;
}
