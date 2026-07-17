import type { LayoutServerLoad } from './$types';
import { parseRange } from '$lib/date-range';

// Range is shared across every analytics tab (from/to in the URL); each tab's own load reads it for its fetch.
export const load: LayoutServerLoad = ({ url }) => {
  const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), 30);
  return { range };
};
