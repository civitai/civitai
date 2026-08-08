import { hubLogoutUrl } from '@civitai/auth';
import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';
import { navForUser } from '$lib/server/access';
import { recordPageVisit } from '$lib/server/page-visits';

// Records one page visit per landing, keyed by matched route id (so dynamic pages roll up to one row):
//   - Read `url.pathname`, never `url.searchParams` — SvelteKit re-runs the load on a path change but NOT
//     on a query-only change, so this records landings, not query tweaks.
//   - `route.id` is null for an unmatched path (404) — skip those.
//   - `/page-visits…` is excluded so viewing the report doesn't pollute the data being reviewed.
export const load: LayoutServerLoad = ({ locals, url, route }) => {
  const user = locals.user;

  const path = url.pathname;
  const routeId = route.id;
  if (user && routeId && !path.startsWith('/page-visits')) {
    void recordPageVisit({ userId: user.id, location: routeId });
  }

  return {
    user: user ? { id: user.id, username: user.username ?? null, image: user.image ?? null } : null,
    logoutUrl: env.AUTH_JWT_ISSUER ? hubLogoutUrl(env.AUTH_JWT_ISSUER, url.origin) : null,
    nav: navForUser(user),
    civitaiUrl: env.CIVITAI_APP_URL || 'https://civitai.com',
  };
};
