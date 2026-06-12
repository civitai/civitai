import type { Session } from 'next-auth';
import { createSessionClient, sessionCookieName } from '@civitai/auth';

// The main app's handle to the centralized auth hub (thin-session model — docs/thin-session-token-design.md
// and docs/main-app-auth-cutover.md). Going forward, user validation routes through this client instead of
// next-auth's jwt()/session() callbacks:
//   - validation  → getHubSession(req)         (verify cookie → shared redis cache → hub on miss)
//   - refresh/invalidate already propagate to the hub: the main app SHARES the hub's redis, so the existing
//     clearSessionCache / clearCacheByPattern busts of session:data2 are read by the hub on its next produce.
//
// Zero-config: the verifier, cache, hub URL all come from env / the verified token's `iss` (AUTH_JWKS_URI or
// AUTH_JWT_PUBLIC_KEY, AUTH_JWT_ISSUER). Built lazily, so importing this module touches nothing until use.

/**
 * Feature flag for the hub-backed session path (default OFF). When false, getServerAuthSession behaves
 * EXACTLY as before (next-auth). Flip per-environment ONLY once the hub is the producer + login authority
 * for that env (deployed, minting, `/api/auth/identity` live, AUTH_JWT_ISSUER set). See the cutover doc.
 */
export const USE_HUB_SESSION = process.env.USE_HUB_SESSION === 'true';

export const sessionClient = createSessionClient();

/**
 * Resolve the session from the hub, next-auth-free: read the session cookie → verify → resolve the user
 * (shared cache, hub fetch on miss). Returns the existing `Session` shape so every getServerAuthSession
 * consumer (tRPC context, API routes, getServerSideProps) is unaffected. Null when there's no valid session.
 */
export async function getHubSession(req: {
  cookies?: Partial<Record<string, string>>;
}): Promise<Session | null> {
  // The hub's THIN cookie (`civ-token`), distinct from next-auth's legacy `civitai-token`. Read both the
  // secure-prefixed (prod/https) and unprefixed (dev) names so it works in either environment.
  const token = req.cookies?.[sessionCookieName(true)] ?? req.cookies?.[sessionCookieName(false)];
  if (!token) return null;
  const user = await sessionClient.getSessionUser(token);
  if (!user) return null;
  // The hub's @civitai/auth SessionUser is structurally the ExtendedUser the app expects, but loosely typed
  // (tier/meta/banDetails/subscriptions are widened in the package contract), so cast at this boundary.
  return { user } as unknown as Session;
}
