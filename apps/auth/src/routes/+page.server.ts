import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The hub root is just the login entry — forward the full query string (returnUrl, callbackUrl,
// sync, reason, error) to /login untouched.
export const load: PageServerLoad = ({ url }) => {
  redirect(302, `/login${url.search}`);
};
