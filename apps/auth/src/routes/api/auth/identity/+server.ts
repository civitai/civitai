import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifier } from '$lib/server/auth/verifier';
import {
  getOrProduceSessionUser,
  invalidateSessionUser,
  produceSessionUser,
} from '$lib/server/auth/session-producer';
import { SESSION_COOKIE } from '$lib/server/auth/session';
import { isInternalRequest } from '$lib/server/auth/internal';

// The hub is the SOLE PRODUCER of session-user data (docs/thin-session-token-design.md, "LOCKED
// ARCHITECTURE"). Consumers (main app, spokes) call this on a cache miss: present the user's session token
// as a Bearer (or the session cookie, same-origin) and get the rich SessionUser back. This is a
// server-to-server call (the @civitai/auth resolver's `fetchIdentity`), so no CORS is involved.
//
// Read-through: returns the shared-cache entry when warm, produces fresh (DB → cache) only on a miss — so
// HTTP-only consumers get the same caching as shared-redis ones. A forced refresh is a cache bust, not a
// call here.
//
// verifier.verifyToken also enforces REVOCATION (the hub owns the registry), so a logged-out / banned
// token returns 401 — matching the resolver, which treats 401/404 as "no session".
export const GET: RequestHandler = async ({ request, url, cookies }) => {
  // INTERNAL by-userId read-through (createSessionClient.getSessionUserById) — for consumer paths that start
  // from a userId with no session token to present (API-key/bearer auth, the legacy-cookie fallback). Returns
  // ANY user's session to a holder of AUTH_INTERNAL_TOKEN, the SAME trust as the POST refresh below — no new
  // privilege. This is a READ (getOrProduce), not a bust. Branches before the token path on `?userId=`.
  const byId = url.searchParams.get('userId');
  if (byId != null) {
    if (!isInternalRequest(request)) return json({ error: 'unauthorized' }, { status: 401 });
    const uid = Number(byId);
    if (!Number.isFinite(uid)) return json({ error: 'bad_request' }, { status: 400 });
    const user = await getOrProduceSessionUser(uid);
    return user ? json(user) : json({ error: 'not_found' }, { status: 404 });
  }

  const authHeader = request.headers.get('authorization') ?? '';
  const token = /^bearer /i.test(authHeader)
    ? authHeader.slice(7).trim()
    : cookies.get(SESSION_COOKIE);
  if (!token) return json({ error: 'unauthorized' }, { status: 401 });

  const claims = await verifier.verifyToken(token).catch(() => null);
  const userId = Number(claims?.sub);
  if (!claims || !Number.isFinite(userId)) return json({ error: 'unauthorized' }, { status: 401 });

  const user = await getOrProduceSessionUser(userId);
  if (!user) return json({ error: 'not_found' }, { status: 404 });

  return json(user);
};

// WRITE side — service-authed cache invalidation (createSessionInvalidator). Targets an ARBITRARY userId
// (a mod banning user X, a subscription webhook), so it's authed by the shared `AUTH_INTERNAL_TOKEN`, NOT a
// user session token. Body: { userId, refresh? }. Default busts the cache (lazy — next read re-produces);
// `refresh: true` also re-produces now and returns the fresh user.
export const POST: RequestHandler = async ({ request }) => {
  if (!isInternalRequest(request)) return json({ error: 'unauthorized' }, { status: 401 });

  let body: { userId?: unknown; refresh?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const userId = Number(body.userId);
  if (!Number.isFinite(userId)) return json({ error: 'bad_request' }, { status: 400 });

  await invalidateSessionUser(userId); // bust
  if (body.refresh === true) {
    const user = await produceSessionUser(userId); // eager re-produce
    return json(user); // SessionUser, or null when there's no such user
  }
  return new Response(null, { status: 204 });
};
