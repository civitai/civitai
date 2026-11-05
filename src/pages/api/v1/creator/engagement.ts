import type { NextApiRequest, NextApiResponse } from 'next';
import { prefixCacheKey } from '@civitai/redis';
import * as z from 'zod';
import {
  ENGAGEMENT_LIMIT_DEFAULT,
  ENGAGEMENT_LIMIT_MAX,
  InvalidCursorError,
  engagementItemTypes,
  engagementSorts,
  getCreatorEngagement,
} from '~/server/services/creator-engagement.service';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';
import { getBaseUrl } from '~/server/utils/url-helpers';
import type { SessionUser } from '~/types/session';

const RATE_LIMIT_PER_MINUTE = 30;

const querySchema = z.object({
  type: z.enum(engagementItemTypes).optional(),
  sort: z.enum(engagementSorts).default('engagement'),
  limit: z.coerce.number().int().min(1).max(ENGAGEMENT_LIMIT_MAX).default(ENGAGEMENT_LIMIT_DEFAULT),
  cursor: z.string().max(512).optional(),
});

export default AuthedEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) {
  // No read scope maps to engagement and tipped Buzz yet, so only a session or a full-access key.
  if (!requireFullScopeSession(req, res)) return;

  // A 404 rather than a 403, so a caller outside the cohort cannot tell the route exists.
  if (!(await getFeatureFlagsAsync({ user, req })).creatorEngagementApi)
    return res.status(404).json({ error: 'Not Found' });

  const rateLimit = await checkFixedWindow(
    prefixCacheKey(`creator-engagement:rate-limit:user:${user.id}`),
    RATE_LIMIT_PER_MINUTE,
    60
  );
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });

  try {
    const page = await getCreatorEngagement({
      ...parsed.data,
      userId: user.id,
      baseUrl: getBaseUrl(),
    });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(page);
  } catch (error) {
    if (error instanceof InvalidCursorError)
      return res.status(400).json({ error: 'Invalid cursor' });
    return handleEndpointError(res, error);
  }
});
