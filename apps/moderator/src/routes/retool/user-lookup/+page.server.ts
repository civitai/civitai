import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { getUserLookup, resolveUserId } from '$lib/server/user-lookup.service';

const querySchema = z.object({ q: z.string().trim().catch('') });

export const load: PageServerLoad = async ({ url }) => {
  const { q } = parseQuery(url, querySchema);
  if (!q) return { q, result: null, notFound: false };

  const userId = await resolveUserId(q);
  if (!userId) return { q, result: null, notFound: true };

  return { q, result: await getUserLookup(userId), notFound: false };
};
