import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Bookmarks of the Article-only queue land on the generic one, on its Articles tab.
export const load: PageServerLoad = ({ url }) => {
  const next = new URLSearchParams(url.searchParams);
  next.set('tab', 'articles');
  redirect(307, `/ratings?${next}`);
};
