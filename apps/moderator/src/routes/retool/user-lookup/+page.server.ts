import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { DEFAULT_SECTION } from './sections';

// The bare route has no content of its own — the layout owns the search box, so redirecting keeps a
// bookmarked or hand-typed /retool/user-lookup?q=… working and lands it on the first section.
export const load: PageServerLoad = async ({ url }) => {
  const q = url.searchParams.get('q');
  redirect(307, `/retool/user-lookup/${DEFAULT_SECTION}${q ? `?q=${encodeURIComponent(q)}` : ''}`);
};
