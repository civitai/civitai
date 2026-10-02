import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';

import { getPostDetail } from '~/server/services/post.service';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { checkPublicApiRateLimit } from '~/server/utils/public-api-rate-limit';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { Availability } from '~/shared/utils/prisma/enums';
import { TRPCError } from '@trpc/server';

/**
 * GET /api/v1/posts/[id] — public, edge-cacheable post title and description.
 *
 * Always evaluated as anonymous, so the response is a function of id + region only and the
 * `MixedAuthEndpoint` public cache stays leak-free. Maturity follows `/api/v1/model-versions/[id]`:
 * every level is served, except in a restricted region, where a post with any non-SFW level is a
 * 404. The 404 is answered here, not by `handleEndpointError`, so the edge can absorb it.
 */

export const schema = z.object({ id: z.coerce.number().int().gt(0).lte(2147483647) });

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

  try {
    const post = await getPostDetail({ id });

    if (post.availability === Availability.Private) return notFound();
    if (isRegionRestricted(getRegion(req)) && !Flags.hasFlag(sfwBrowsingLevelsFlag, post.nsfwLevel))
      return notFound();

    return res.status(200).json({
      id: post.id,
      title: post.title,
      detail: post.detail,
      nsfwLevel: post.nsfwLevel,
      publishedAt: post.publishedAt,
      modelVersionId: post.modelVersionId,
      user: { id: post.user.id, username: post.user.username },
      tags: post.tags.map((tag) => ({ id: tag.id, name: tag.name })),
    });
  } catch (e) {
    if (e instanceof TRPCError && e.code === 'NOT_FOUND') return notFound();
    return handleEndpointError(res, e);
  }
});
