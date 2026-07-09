import { z } from 'zod';
import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { getImageReviewQueue } from '$lib/server/image-review.service';
import { allBrowsingLevelsFlag } from '@civitai/shared';

const querySchema = z.object({
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
  limit: z.coerce.number().int().min(10).max(200).catch(100),
  level: z.coerce.number().int().min(0).catch(allBrowsingLevelsFlag),
});

// Senior-only — gated in access.ts (the CSAM nav item raises the role to senior; hooks enforce it).
export const load: PageServerLoad = async ({ url }) => {
  const { cursor, limit, level } = parseQuery(url, querySchema);
  const data = await getImageReviewQueue({
    needsReview: 'csam',
    browsingLevel: level,
    cursor,
    limit,
  });
  return { ...data, level, civitaiUrl: env.CIVITAI_APP_URL ?? 'https://civitai.com', wide: true };
};
