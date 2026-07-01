import type { SessionClaims } from '@civitai/auth';
import { verifier } from '../lib/server/auth/verifier';
import { sessionCookieName } from '@civitai/auth';

// The tRPC request context. Built per-request from the incoming HTTP headers by the fetch adapter.
//
// Auth model (mirrors the monolith's token-based tRPC context, minus the session-DB read):
//   - session cookie: `__Secure-civ-token` (prod) / `civ-token` (dev) — the primary browser path.
//   - Authorization: Bearer <token> — the per-user orchestrator/REST path.
// Both are verified LOCALLY by @civitai/auth (ES256/JWKS + injected revocation), yielding SessionClaims.
// ctx.userId is the resolved numeric user id (or null when unauthenticated). Richer ctx.user / ctx.features
// / subscription resolution off @civitai/db lands with the moved surface (P1/P2) — P0 only needs the id.

export interface Context {
  claims: SessionClaims | null;
  userId: number | null;
}

/** Pull the userId out of verified claims. The thin civ-token carries identity in `sub`; a decoded legacy
 * cookie populates `user.id`. Narrow both to a number (or null). */
function userIdFromClaims(claims: SessionClaims | null): number | null {
  if (!claims) return null;
  const raw = claims.sub ?? claims.user?.id;
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isInteger(n) ? (n as number) : null;
}

/** Read the bearer token from an Authorization header, if present. */
function bearerFromHeaders(headers: Headers): string | undefined {
  const auth = headers.get('authorization');
  if (!auth) return undefined;
  const [scheme, token] = auth.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/**
 * Build the request context. Verifies (in order) an explicit bearer token, then the session cookie.
 * Verification failures degrade to an unauthenticated context (userId null) — the protected-procedure
 * middleware is what turns that into an UNAUTHORIZED error, so public procedures still work.
 */
export async function createContext({ req }: { req: Request }): Promise<Context> {
  const bearer = bearerFromHeaders(req.headers);
  let claims: SessionClaims | null = null;

  if (bearer) {
    claims = await verifier.verifyToken(bearer);
  }
  if (!claims) {
    const cookieHeader = req.headers.get('cookie') ?? '';
    claims = await verifier.getSession(cookieHeader);
  }

  return { claims, userId: userIdFromClaims(claims) };
}

// Re-export so tests / callers can reference the exact cookie-name contract without duplicating it.
export { sessionCookieName };
