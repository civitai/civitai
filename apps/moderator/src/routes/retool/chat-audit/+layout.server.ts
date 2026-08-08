import type { LayoutServerLoad } from './$types';
import { lookupQuerySchema, parseQuery } from '$lib/server/query';


// Only the search term, which the header renders on every tab. Each tab loads its own data — the
// point of splitting them is that a tab does not pay for the others.
export const load: LayoutServerLoad = async ({ url }) => {
  const { q } = parseQuery(url, lookupQuerySchema);
  return { q };
};
