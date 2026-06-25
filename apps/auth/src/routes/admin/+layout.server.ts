import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { isHubAdmin } from '$lib/server/auth/admin';

// Gate for the whole /admin area. Runs for every route under /admin, so the 403 here protects the
// landing page AND every sub-page (e.g. /admin/spoke-domains) — no per-page check needed.
export const load: LayoutServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    redirect(303, `/login?returnUrl=${encodeURIComponent(url.pathname + url.search)}`);
  }
  if (!isHubAdmin(locals.user)) {
    error(403, 'You do not have access to this area.');
  }

  // Surface a little identity for the layout chrome.
  return {
    admin: { id: locals.user.id, username: locals.user.username ?? null },
  };
};
