import type { Session } from '~/types/session';
import {
  createSessionClient,
  createSessionTokenClient,
  readSessionToken,
  type CookieSlot,
} from '@civitai/auth';
import { setSessionCookie, type CookieWritable } from './civ-cookie';
import { isRevoked } from './session-verifier';
import { decodeTokenClaim } from './token-claims';
import { refuseModerationAccountSession } from './moderation-account';
import { observeSessionLeg, observeSessionRollFailed } from './session-metrics';

// The main app's handle to the centralized auth hub (thin-session model — docs/main-app-auth-cutover.md).
// Validation routes through this client (getHubSession) instead of next-auth's jwt()/session(); refresh +
// invalidate propagate via the shared redis. Zero-config from env; built lazily so import touches nothing.

// Inject the shared revocation check so the read path rejects a logged-out/banned token even on a cache hit
// (otherwise a revoked civ-token resolves until the session:data2 entry is re-warmed). See session-verifier.ts.
// Also inject the leg-instrumentation callbacks so the identity fetch + JWKS verify are timed on the CALLING
// app (the hub can't see this hairpin) — see session-metrics.ts. The package emits the raw timings; we record
// them to prom-client here.
export const sessionClient = createSessionClient({
  isRevoked,
  onIdentityLeg: (outcome, durationSeconds) =>
    observeSessionLeg('identity', outcome, durationSeconds),
  onJwksLeg: (outcome, durationSeconds) => observeSessionLeg('jwks', outcome, durationSeconds),
  // The API-key/OAuth by-id read + the hub write paths hairpin too (bearer-token.ts, App Blocks, ban/logout) —
  // now internally routed + bounded by hubFetch; instrument them under their own leg labels.
  onIdentityByIdLeg: (outcome, durationSeconds) =>
    observeSessionLeg('identity-by-id', outcome, durationSeconds),
  onHubWriteLeg: (outcome, durationSeconds) =>
    observeSessionLeg('hub-write', outcome, durationSeconds),
  // Signature only; isRevoked still runs on every request.
  verifiedTokenCache: { maxEntries: 10_000, maxTtlMs: 60_000 },
});
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
  // The hub's THIN cookie (`civ-token`, either slot), distinct from next-auth's legacy `civitai-token`.
  const token = readSessionToken(req.cookies)?.value;
  if (!token) return null;
  const user = await sessionClient.getSessionUser(token);
  if (!user || refuseModerationAccountSession(user, 'session-token')) return null;
  // Impersonation (F): surface the moderator's id from the (already-verified) token so the client can show the
  // "exit impersonation" control. The claim is identity-only — no credential.
  const impersonatedBy = decodeTokenClaim(token, 'impersonatedBy');
  // The hub's @civitai/auth SessionUser is structurally the ExtendedUser the app expects, but loosely typed
  // (tier/meta/banDetails/subscriptions are widened in the package contract), so cast at this boundary.
  return { user, ...(impersonatedBy ? { impersonatedBy } : {}) } as Session;
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
  res: CookieWritable,
  host?: string,
  slot?: CookieSlot,
  requestCookies?: Partial<Record<string, string | undefined>>
): Promise<void> {
  if (!HUB_ORIGIN || !token || typeof res.setHeader !== 'function') return;
  const iat = decodeTokenClaim(token, 'iat');
  if (!iat || Date.now() - iat * 1000 < UPDATE_AGE_MS) return; // fresh enough — no work

  try {
    // Only the hub can mint — the package helper forwards the bearer token (+ device cookie) and times out.
    const fresh = (
      await sessionTokenClient.refresh(token, { deviceCookie, onFailure: observeSessionRollFailed })
    )?.token;
    if (!fresh) return;
    // Re-set the civ-token + roll the device cookie in lockstep (both live 30 rolling days from last activity).
    setSessionCookie(res, fresh, { deviceCookie, host, slot, requestCookies });
  } catch {
    // best-effort — the current token is still valid; the user is unaffected
  }
}
