import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSigner } from '$lib/server/auth/session';

// Allowed cross-domain spoke origins for the swap redirect (open-redirect guard): the civitai family + localhost.
const SPOKE_ORIGIN = /^https?:\/\/([a-z0-9-]+\.)*civitai\.(com|red|green|blue|work|dev|ai)(:\d+)?$/i;
function allowedCallback(raw: string): URL | null {
  try {
    const u = new URL(raw);
    const ok =
      u.hostname === 'localhost' || u.hostname === '127.0.0.1' || SPOKE_ORIGIN.test(u.origin);
    return ok && u.pathname === '/api/auth/sync' ? u : null;
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
  const returnUrl = url.searchParams.get('returnUrl') ?? '/';

  if (!locals.user) {
    // Not signed in at the hub either → login, then come straight back here with the same params.
    redirect(302, `/login?returnUrl=${encodeURIComponent(url.pathname + url.search)}`);
  }

  const swapToken = await getSigner().mintSwapToken(locals.user.id);
  callback.searchParams.set('swap', swapToken);
  callback.searchParams.set('returnUrl', returnUrl);
  redirect(302, callback.toString());
};
