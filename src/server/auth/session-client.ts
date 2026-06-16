import type { Session } from 'next-auth';
import { createSessionClient, createSessionTokenClient, sessionCookieName } from '@civitai/auth';
import { setSessionCookie, type CookieWritable } from './civ-cookie';
import { isRevoked } from './session-verifier';
import { decodeTokenClaim } from './token-claims';

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

// Inject the shared revocation check so the read path rejects a logged-out/banned token even on a cache hit
// (otherwise a revoked civ-token resolves until the session:data2 entry is re-warmed). See session-verifier.ts.
export const sessionClient = createSessionClient({ isRevoked });
// Session-token lifecycle (rolling refresh / revoke) — the hub contract lives in the package, not inline here.
const sessionTokenClient = createSessionTokenClient();

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
  const token = req.cookies?.[sessionCookieName()];
  if (!token) return null;
  const user = await sessionClient.getSessionUser(token);
  if (!user) return null;
  // Impersonation (F): surface the moderator's id from the (already-verified) token so the client can show the
  // "exit impersonation" control. The claim is identity-only — no credential.
  const impersonatedBy = decodeTokenClaim(token, 'impersonatedBy');
  // The hub's @civitai/auth SessionUser is structurally the ExtendedUser the app expects, but loosely typed
  // (tier/meta/banDetails/subscriptions are widened in the package contract), so cast at this boundary.
  return { user, ...(impersonatedBy ? { impersonatedBy } : {}) } as unknown as Session;
}

// --- Rolling session (cutover doc section C) ---------------------------------------------------------------
// next-auth rolled the JWT on activity (its `updateAge`, ~24h) so active users never expired. The thin
// civ-token is a fixed window from login, so we reproduce rolling: when a token ages past
// AUTH_SESSION_UPDATE_AGE, ask the hub to mint a fresh one (only the hub can mint) and re-set the cookie.
const UPDATE_AGE_MS = (Number(process.env.AUTH_SESSION_UPDATE_AGE) || 24 * 60 * 60) * 1000; // default 24h
const HUB_ORIGIN = process.env.AUTH_JWT_ISSUER;

/**
 * Rolling session: when the civ-token's age exceeds AUTH_SESSION_UPDATE_AGE, ask the hub to mint a fresh
 * token (same session/jti, new window) and re-set the cookie on the same `.civitai.com` domain the hub used.
 * Best-effort + fire-safe: any failure leaves the current (still-valid) token in place, so the user stays
 * logged in and the next request retries. Fires at most once per updateAge crossing (re-setting the cookie
 * resets the clock). The hub call is the only path that can mint — the main app is verify-only.
 */
export async function maybeRollHubCookie(
  token: string,
  deviceCookie: string | undefined,
  res: CookieWritable
): Promise<void> {
  if (!HUB_ORIGIN || !token || typeof res.setHeader !== 'function') return;
  const iat = decodeTokenClaim(token, 'iat');
  if (!iat || Date.now() - iat * 1000 < UPDATE_AGE_MS) return; // fresh enough — no work

  try {
    // Only the hub can mint — the package helper forwards the bearer token (+ device cookie) and times out.
    const fresh = (await sessionTokenClient.refresh(token, { deviceCookie }))?.token;
    if (!fresh) return;
    // Re-set the civ-token + roll the device cookie in lockstep (both live 30 rolling days from last activity).
    setSessionCookie(res, fresh, { deviceCookie });
  } catch {
    // best-effort — the current token is still valid; the user is unaffected
  }
}
