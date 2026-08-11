import { createHash } from 'crypto';
import type { Session } from '~/types/session';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { createSessionClient, createSessionTokenClient, sessionCookieName } from '@civitai/auth';
import { setSessionCookie, clearLegacyCookies, type CookieWritable } from './civ-cookie';
import { isRevoked } from './session-verifier';
import { decodeTokenClaim } from './token-claims';
import { observeSessionLeg, observeLegacyUpgrade } from './session-metrics';
import { logToAxiom } from '~/server/logging/client';

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
  // The hub's THIN cookie (`civ-token`, env-derived name), distinct from next-auth's legacy `civitai-token`.
  const token = req.cookies?.[sessionCookieName()];
  if (!token) return null;
  const user = await sessionClient.getSessionUser(token);
  if (!user) return null;
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
  host?: string
): Promise<void> {
  if (!HUB_ORIGIN || !token || typeof res.setHeader !== 'function') return;
  const iat = decodeTokenClaim(token, 'iat');
  if (!iat || Date.now() - iat * 1000 < UPDATE_AGE_MS) return; // fresh enough — no work

  try {
    // Only the hub can mint — the package helper forwards the bearer token (+ device cookie) and times out.
    const fresh = (await sessionTokenClient.refresh(token, { deviceCookie }))?.token;
    if (!fresh) return;
    // Re-set the civ-token + roll the device cookie in lockstep (both live 30 rolling days from last activity).
    setSessionCookie(res, fresh, { deviceCookie, host });
  } catch {
    // best-effort — the current token is still valid; the user is unaffected
  }
}

// One upgrade per legacy cookie per window, instead of one per REQUEST. Upgrading mints a NEW jti, and the
// only thing that stopped it repeating was the client persisting the cookie we set — so a client that ignores
// Set-Cookie (a scripted integration, a cookie-less HTTP client) re-minted on every request indefinitely, with
// no age gate and no rate limit. Contrast maybeRollHubCookie above, which is both age-gated and jti-preserving.
//
// Skipping is safe: the caller already resolved this request's session from the legacy decode, so a skipped
// upgrade costs the user nothing — the migration just happens on a later request. We key on a HASH of the
// cookie and store no value, so the marker is not a credential.
const LEGACY_UPGRADE_WINDOW_SECONDS = 10 * 60;

async function claimLegacyUpgrade(legacyToken: string): Promise<boolean> {
  try {
    const fingerprint = createHash('sha256').update(legacyToken).digest('base64url');
    const key = `${REDIS_SYS_KEYS.SESSION.LEGACY_UPGRADE_LOCK}:${fingerprint}` as const;
    const claimed = await withSysReadDeadline(
      sysRedis.set(key as never, '1', { NX: true, EX: LEGACY_UPGRADE_WINDOW_SECONDS })
    );
    return claimed !== null;
  } catch {
    // Fail OPEN: a sysRedis blip must not block migration off the legacy cookie. The pre-existing behaviour
    // was to upgrade on every request, so degrading to that is not a regression.
    return true;
  }
}

/**
 * Upgrade-on-read (migration window): when a request authenticated via the LEGACY next-auth cookie, ask the hub
 * to exchange that cookie for a fresh civ-token and set it on this response — so the legacy user migrates to the
 * thin-session model, and the browser gets fully de-crudded of next-auth cookies, just by browsing (no need to
 * wait for a re-login/logout). The main app stays a pure consumer: it hands the hub the legacy cookie and gets a
 * civ-token back (only the hub can sign). Best-effort + fire-safe: any hub blip leaves the legacy cookie in place
 * (the user already has a resolved session THIS request) and the next request retries. `clearLegacyCookies` then
 * expires every legacy next-auth cookie (session + ancillary cruft). Drop alongside the legacy decode once the
 * old cookies age out.
 */
export async function maybeUpgradeLegacySession(
  legacyToken: string | undefined,
  deviceCookie: string | undefined,
  res: CookieWritable,
  host?: string
): Promise<void> {
  if (!HUB_ORIGIN || !legacyToken || typeof res.setHeader !== 'function') return;
  if (!(await claimLegacyUpgrade(legacyToken))) {
    observeLegacyUpgrade('deduped');
    return;
  }
  try {
    // Forward any existing civ-device so the hub reuses this browser's device set; for a pure legacy user (no
    // civ-device yet) the hub mints one and returns it. Without this, the upgraded session had NO civ-device
    // and so never appeared in the account switcher.
    const result = await sessionTokenClient.exchangeLegacy(legacyToken, { deviceCookie });
    const fresh = result?.token;
    if (!fresh) {
      observeLegacyUpgrade('no-token');
      return;
    }
    // Each upgrade mints a NEW jti. A client that doesn't persist the cookie we set below re-enters this path
    // on its very next request, so a sustained rate here is the session-hash growth driver — and nothing in
    // redis can measure it (both the tracked value and its TTL are last-touch, not creation).
    observeLegacyUpgrade('minted');
    logToAxiom(
      { name: 'legacy-session-upgraded', type: 'info', userId: decodeTokenClaim(fresh, 'sub') },
      'auth'
    ).catch(() => undefined);
    // Set the civ-token + the device cookie (the hub's reused-or-minted device id) in lockstep — this also
    // clears the legacy SESSION cookie.
    setSessionCookie(res, fresh, { host, deviceCookie: result?.deviceId });
    // … then de-crud every legacy next-auth cookie on the same response — the SESSION cookie (so the hybrid
    // fallback can't re-resolve the stale legacy identity) AND the ancillary cruft (CSRF / callback-url /
    // state / PKCE). setSessionCookie no longer clears the session cookie itself.
    const existing = res.getHeader?.('Set-Cookie');
    const all = Array.isArray(existing)
      ? existing.map(String)
      : existing != null
      ? [String(existing)]
      : [];
    all.push(...clearLegacyCookies(host));
    res.setHeader('Set-Cookie', all);
  } catch {
    observeLegacyUpgrade('failed');
    // best-effort — the legacy session is still valid; the user is unaffected and the next request retries
  }
}
