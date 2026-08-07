import { z } from 'zod';
import type { LayoutServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';

const querySchema = z.object({ q: z.string().trim().catch('') });

// Only the search term, which the header renders on every tab. Each tab loads its own data — the
// point of splitting them is that a tab does not pay for the others.
export const load: LayoutServerLoad = async ({ url }) => {
  const { q } = parseQuery(url, querySchema);
  return { q };
};
