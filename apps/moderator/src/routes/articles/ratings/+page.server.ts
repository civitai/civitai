import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Bookmarks of the Article-only queue land on the generic one, pre-filtered.
export const load: PageServerLoad = ({ url }) => {
  const next = new URLSearchParams(url.searchParams);
  next.set('type', 'Article');
  redirect(307, `/ratings?${next}`);
};
