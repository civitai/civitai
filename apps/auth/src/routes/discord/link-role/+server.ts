import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

// Discord Linked-Roles verification entry point — the URL configured as the app's "Linked Roles Verification
// URL" in the Discord developer portal. Discord opens it when a user clicks "Verify" on a linked role, so it
// must live on the hub (where all Discord OAuth surface — redirect_uri, provider config, callback — already
// lives). Thin wrapper: gate on a hub session, then hand off to the existing /login/discord LINK flow with the
// incremental role_connections.write scope. The account link happens in /login/discord/callback; we return to
// the MAIN APP's /discord/link-role, which owns the Civitai-data metadata push + success UI (the hub has
// neither the ClickHouse/Postgres data nor the Discord bot token). The daily push-discord-metadata cron
// backstops the metadata regardless, so a missed inline push is only slower feedback, not lost state.
const RETURN_PATH = '/discord/link-role';

export const GET: RequestHandler = ({ url, locals }) => {
  // Not signed in on the hub → send to hub login, returning HERE so the flow resumes once authed. (A bare
  // /login/discord would 401 on a missing session — this handles the "clicked Verify while logged out" case.)
  if (!locals.user) {
    redirect(302, `/login?returnUrl=${encodeURIComponent(RETURN_PATH)}`);
  }

  // After linking, land on the MAIN APP's link-role page (absolute, built from the hub's main-app origin) so it
  // can push metadata + show the success state. Discord only stores ONE verification URL and can't tell us the
  // user's color, so this always returns to the canonical main app; the color-preserving path stays the
  // in-app "Connect Discord" button (/api/auth/connect). Falls back to the hub root when the origin is unset.
  const base = env.AUTH_DEFAULT_RETURN_URL;
  const landing = base ? new URL(RETURN_PATH, base).toString() : '/';

  const start = new URL('/login/discord', url.origin);
  start.searchParams.set('link', 'true');
  start.searchParams.set('roles', 'true');
  start.searchParams.set('returnUrl', landing);
  redirect(302, start.toString());
};
