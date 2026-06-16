import type { Handle } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/auth/session';
import { verifier } from '$lib/server/auth/verifier';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';

// Populate locals.user from the session cookie. The cookie is THIN (identity only), so resolve the rich user
// by userId from the shared cache (produce on miss) rather than trusting an embedded user. The verifier handles
// both ES256 and legacy NextAuth JWE; verification / resolve failures are non-fatal.
export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get(SESSION_COOKIE);
  if (token) {
    const claims = await verifier.verifyToken(token).catch(() => null);
    const userId = Number(claims?.sub);
    if (claims && Number.isFinite(userId)) {
      event.locals.user = (await getOrProduceSessionUser(userId).catch(() => null)) ?? undefined;
      event.locals.tokenId = claims.jti;
      // Impersonation (F): the moderator's id, if this is an impersonation session — read by the exit route.
      event.locals.impersonatedBy = claims.impersonatedBy;
    }
  }
  return resolve(event);
};
