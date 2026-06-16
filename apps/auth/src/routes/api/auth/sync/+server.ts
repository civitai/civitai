import { error, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { getSigner } from '$lib/server/auth/session';

// EXPLICIT allowlist of spoke origins the hub will hand a swap token to. This is the ENTIRE trust boundary for
// where a (bearer) swap token gets delivered, so it's an exact-origin set from AUTH_SPOKE_ORIGINS (comma-
// separated, e.g. "https://civitai.com,https://civitai.red") — never a broad pattern. localhost is allowed only
// in dev. The callback must also be the spoke's /api/auth/sync receiver path.
const ALLOWED_SPOKE_ORIGINS = new Set(
  (env.AUTH_SPOKE_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
);
function allowedCallback(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.pathname !== '/api/auth/sync') return null;
    if (dev && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u;
    return ALLOWED_SPOKE_ORIGINS.has(u.origin) ? u : null;
  } catch {
    return null;
  }
}

// GET /api/auth/sync?callback=<spoke /api/auth/sync>&returnUrl=<final path> — cross-domain login bootstrap.
// A spoke on a DIFFERENT registrable domain (civitai.red / localhost) sends the user here via a TOP-LEVEL
// navigation, so the hub's SameSite=Lax .civitai.com cookie rides along. If signed in at the hub, mint a
// single-use swap token and redirect back to the spoke's callback with it; otherwise send to login (which
// returns here). The spoke then exchanges the swap token at POST /api/auth/exchange. See cutover doc (E).
export const GET: RequestHandler = async ({ url, locals }) => {
  const callback = allowedCallback(url.searchParams.get('callback') ?? '');
  if (!callback) error(400, 'bad callback');
  // Only ever reflect a root-relative path back to the spoke (the spoke re-checks, but don't emit an open
  // redirect for a forgetful/non-Next spoke to inherit).
  const rawReturn = url.searchParams.get('returnUrl') ?? '/';
  const returnUrl = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/';

  if (!locals.user) {
    // Not signed in at the hub either → login, then come straight back here with the same params.
    redirect(302, `/login?returnUrl=${encodeURIComponent(url.pathname + url.search)}`);
  }

  const swapToken = await getSigner().mintSwapToken(locals.user.id);
  callback.searchParams.set('swap', swapToken);
  callback.searchParams.set('returnUrl', returnUrl);
  redirect(302, callback.toString());
};
