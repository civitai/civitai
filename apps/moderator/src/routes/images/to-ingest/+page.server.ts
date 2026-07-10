import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import {
  getImagesPendingIngestion,
  countImagesPendingIngestion,
} from '$lib/server/ingestion.service';

const querySchema = z.object({
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
  limit: z.coerce.number().int().min(10).max(200).catch(100),
});

export const load: PageServerLoad = async ({ url }) => {
  const { cursor, limit } = parseQuery(url, querySchema);
  const [{ items, nextCursor }, total] = await Promise.all([
    getImagesPendingIngestion({ cursor, limit }),
    countImagesPendingIngestion(),
  ]);
  return { wide: true, images: items, nextCursor, total };
};
