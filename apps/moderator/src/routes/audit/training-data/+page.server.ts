import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { getPausedTrainingVersions } from '$lib/server/training-moderation.service';

const PAGE_SIZE = 20;

const querySchema = z.object({
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  const { cursor } = parseQuery(url, querySchema);
  return await getPausedTrainingVersions({ limit: PAGE_SIZE, cursor });
};
