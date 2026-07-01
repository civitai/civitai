import { hubLogoutUrl } from '@civitai/auth';
import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';
import { navGroupsForUser } from '$lib/server/access';
import { recordPageVisit } from '$lib/server/page-visits';

// The spoke guard (hooks.server.ts) guarantees `locals.user` is a moderator here. Surface a thin slice
// for the sidebar chrome, plus a hub logout URL (a spoke can't clear the shared cookie itself — it sends
// the browser to the hub, which finishes logout and returns to `returnUrl`).
//
// This load reads `url`, so it re-runs on every navigation — the natural choke point for recording an
// authorized page visit. The guard redirects login/forbidden requests before any load runs, so an
// unauthorized or redirected request never reaches here. Fire-and-forget so logging never blocks render.
//
// Record one visit per page landing. We store the matched route id (e.g. `/challenges/[id]/edit`), so
// dynamic-segment pages roll up to one row instead of fragmenting per id.
//
//   - Reading `url.pathname` (and never `url.searchParams`) is what scopes this: SvelteKit re-runs the
//     load on a path change — including a different dynamic segment — but NOT on a query-string-only
//     change (`/a?x=1` → `/a?x=2`), so we record landings, not query tweaks.
//   - `route.id` is null for an unmatched path (a 404); we skip those.
//   - The page-usage report pages (`/page-visits…`) are excluded so viewing the report doesn't pollute
//     the data being reviewed.
export const load: LayoutServerLoad = ({ locals, url, route }) => {
  const user = locals.user;

  const path = url.pathname;
  const routeId = route.id;
  if (user && routeId && !path.startsWith('/page-visits')) {
    void recordPageVisit({ userId: user.id, location: routeId });
  }

  return {
    user: user
      ? { id: user.id, username: user.username ?? null, image: user.image ?? null }
      : null,
    logoutUrl: env.AUTH_JWT_ISSUER ? hubLogoutUrl(env.AUTH_JWT_ISSUER, url.origin) : null,
    navGroups: navGroupsForUser(user),
    // Base for links to the main site (report/article/user pages). Env-driven so it can point at
    // civitai.red etc.; exposed via layout data since these links render client-side.
    civitaiUrl: env.CIVITAI_APP_URL || 'https://civitai.com',
  };
};
