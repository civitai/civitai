import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { isHubAdmin } from '$lib/server/auth/admin';

// Second layer only. The gate for /admin is in hooks.server.ts, which is what covers form actions and any
// other non-GET request; a layout `load` does not run early enough to be relied on for that.
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
