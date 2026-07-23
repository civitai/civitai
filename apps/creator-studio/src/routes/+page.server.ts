import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Public landing (reachable logged-out via hooks.server.ts). Signed-in visitors go straight to the dashboard.
export const load: PageServerLoad = ({ locals, url }) => {
  if (locals.user) redirect(302, '/dashboard');
  return { origin: url.origin };
};
