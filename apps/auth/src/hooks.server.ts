import type { Handle } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/auth/session';
import { verifier } from '$lib/server/auth/verifier';

// Populate locals.user from the session cookie, so server routes/pages (login short-circuit,
// /api/auth/sync, /logout) know who's signed in. One cookie name (shared contract); the verifier
// decodes both RS256 (hub) and legacy NextAuth JWE (main app), so a single read recognizes
// existing civitai.com sessions too. Verification failures are non-fatal.
export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get(SESSION_COOKIE);
  if (token) {
    const claims = await verifier.verifyToken(token).catch(() => null);
    if (claims?.user) {
      event.locals.user = claims.user;
      event.locals.tokenId = claims.id;
    }
  }
  return resolve(event);
};
