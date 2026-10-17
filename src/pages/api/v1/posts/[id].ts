import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';

import { constants } from '~/server/common/constants';
import { runImageSearch } from '~/server/services/image-search.service';
import { getPostDetail } from '~/server/services/post.service';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { checkPublicApiRateLimit } from '~/server/utils/public-api-rate-limit';
import { isStatementTimeout } from '~/server/utils/statement-timeout';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import {
  acquireBulkheadSlot,
  BulkheadFullError,
  HEAVY_REQUEST_CONCURRENCY,
} from '~/server/utils/request-bulkhead';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { Availability } from '~/shared/utils/prisma/enums';
import { TRPCError } from '@trpc/server';

/**
 * GET /api/v1/posts/[id] — public, edge-cacheable post with its images.
 *
 * Always evaluated as anonymous, so the response is a function of id + region only and the
 * `MixedAuthEndpoint` public cache stays leak-free. Maturity follows `/api/v1/model-versions/[id]`:
 * any browsable level is served (never unscanned or Blocked-only), except in a restricted region,
 * where a post with any non-SFW level is a 404. The 404 is answered here, not by
 * `handleEndpointError`, so the edge can absorb it. Images are the `/api/v1/images` items for the
 * post at the same ceiling, the first 100 in the post's own order, so an image the viewer may not
 * see is simply absent.
 *
 * Published + scanned is re-checked here rather than trusted from `getPostDetail`, whose
 * collection-judge branch can return posts that are neither.
 */

export const schema = z.object({ id: z.coerce.number().int().gt(0).lte(2147483647) });

const servedAvailability = new Set<Availability>([Availability.Public, Availability.Unsearchable]);

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  const rateLimit = await checkPublicApiRateLimit({ req, family: 'posts', userId: user?.id });
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
  }

  const parsedParams = schema.safeParse(req.query);
  if (!parsedParams.success)
    return res.status(400).json({ error: z.prettifyError(parsedParams.error) ?? 'Invalid id' });

  const { id } = parsedParams.data;
  const notFound = () => res.status(404).json({ error: 'Post not found' });
  const unavailable = () => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '2');
    return res.status(503).json({ error: 'Server busy, please retry shortly.' });
  };

  let releaseSlot: (() => void) | undefined;
  try {
    const post = await getPostDetail({ id });

    const restricted = isRegionRestricted(getRegion(req));
    const browsingLevel = restricted ? sfwBrowsingLevelsFlag : allBrowsingLevelsFlag;
    const published = !!post.publishedAt && post.publishedAt <= new Date();
    const browsable = restricted
      ? !!post.nsfwLevel && Flags.hasFlag(sfwBrowsingLevelsFlag, post.nsfwLevel)
      : Flags.intersects(post.nsfwLevel, allBrowsingLevelsFlag);
    if (!published || !browsable || !servedAvailability.has(post.availability)) return notFound();

    try {
      releaseSlot = acquireBulkheadSlot('heavy-image', HEAVY_REQUEST_CONCURRENCY);
    } catch (e) {
      if (e instanceof BulkheadFullError) return unavailable();
      throw e;
    }

    const { items: images, nextCursor } = await runImageSearch(
      {
        limit: 100,
        withMeta: false,
        withTags: false,
        postOrder: true,
        throwOnStatementTimeout: true,
        data: {
          postId: post.id,
          period: constants.galleryFilterDefaults.period,
          sort: constants.galleryFilterDefaults.sort,
        },
      },
      { browsingLevel, user: undefined, req }
    );

    return res.status(200).json({
      id: post.id,
      title: post.title,
      detail: post.detail,
      nsfwLevel: post.nsfwLevel,
      publishedAt: post.publishedAt,
      modelVersionId: post.modelVersion?.id ?? null,
      user: { id: post.user.id, username: post.user.username },
      tags: post.tags.map((tag) => ({ id: tag.id, name: tag.name })),
      images,
      hasMoreImages: nextCursor !== undefined,
    });
  } catch (e) {
    if (isStatementTimeout(e)) return unavailable();
    if (e instanceof TRPCError && e.code === 'NOT_FOUND') return notFound();
    return handleEndpointError(res, e);
  } finally {
    releaseSlot?.();
  }
});
