import { randomBytes, createHash } from 'crypto';
import { TokenScope } from './token-scope';
import { hubBaseUrl, hubFetch, internalShapeReady } from './hub';
import { loadAuthEnv } from './env';
import { firstPartyClientId, SPOKE_CALLBACK_PATH } from './first-party';
import { isSecureCookie } from './cookies';
import { safeReturnPath } from './return-path';

// FIRST-PARTY LOGIN BRIDGE (spoke side) — the framework-agnostic core of the OAuth authorization-code + PKCE
// login a first-party app runs against the hub. A spoke on a different registrable domain can't read the hub's
// `.civitai.com` cookie, so it runs this flow to mint its OWN session cookie. Two steps, both pure (strings in,
// strings out) so a Next route handler or a SvelteKit `+server.ts` is a thin wrapper:
//   1. buildAuthorizeRedirect — generate PKCE+state, return the hub /authorize URL + the bridge Set-Cookies.
//   2. completeFirstPartyCallback — verify state, exchange the code at the hub /session endpoint, return token.
// The app owns only what's genuinely framework-specific: deriving its own origin, reading the request
// cookie/query, setting the session cookie, and issuing the redirects.

/**
 * Short-lived cookies carrying the PKCE verifier + state + returnUrl between initiate and callback, one per
 * flow: `oauth_bridge_<state>`. A flow per name lets parallel sign-in tabs run without overwriting each
 * other's stash. The bare `oauth_bridge` is the pre-per-flow name, kept for rollout (see
 * `buildAuthorizeRedirect`).
 */
export const OAUTH_BRIDGE_COOKIE = 'oauth_bridge';
// Live bridge cookies are bounded by this TTL plus each callback clearing its own. They are sent only to the
// callback path.
const OAUTH_BRIDGE_TTL_S = 600; // 10 min — matches the hub's auth-code TTL
// `randomState()` shape (24 bytes, base64url). The query state is untrusted, so only this shape names a cookie.
const STATE_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** The bridge cookie for one flow. */
export function bridgeCookieName(state: string): string {
  return `${OAUTH_BRIDGE_COOKIE}_${state}`;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

/** RFC 7636 PKCE (S256): a high-entropy verifier + its SHA-256 challenge. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32)); // 43-char base64url — within RFC 7636's 43–128 range
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Opaque CSRF state value. */
export function randomState(): string {
  return b64url(randomBytes(24));
}

/** Only ever continue to a same-origin PATH; anything else becomes `/`. The rule is `safeReturnPath`'s. */
export function safePath(raw: unknown): string {
  return safeReturnPath(raw) ?? '/';
}

function buildBridgeCookie(
  name: string,
  value: string,
  secure: boolean,
  maxAge: number,
  domain?: string
): string {
  return [
    `${name}=${value}`,
    `Path=${SPOKE_CALLBACK_PATH}`, // scoped to the callback — never sent elsewhere
    'HttpOnly',
    // Survive the CROSS-REGISTRABLE-DOMAIN OAuth round-trip (spoke → hub → spoke):
    //  - SameSite=None so it rides the cross-site return (fall back to Lax on non-secure dev, where
    //    None-without-Secure is browser-rejected and the flow is same-site localhost).
    //  - Domain=<registrable> (when provided) so it survives a host variation between set (/authorize) and read
    //    (/callback) — e.g. www↔apex. Prod telemetry showed .red no_cookie persisting under SameSite=None with
    //    OTHER (Domain-scoped) cookies still arriving, which points at this HOST-ONLY-vs-Domain gap. Host-only
    //    (omit domain) in dev/localhost.
    // Safe: HttpOnly, Path-scoped, 10-min, carries only the PKCE verifier + state guarded by the state check.
    secure ? 'SameSite=None' : 'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    ...(domain ? [`Domain=${domain}`] : []),
    `Max-Age=${maxAge}`,
  ].join('; ');
}

/**
 * Set-Cookie string that expires a bridge cookie (`name` defaults to the pre-per-flow one). Pass the SAME
 * `domain` the cookie was set with — a Domain-scoped cookie can only be cleared by a matching Domain.
 */
export function clearBridgeCookie(
  secure: boolean = isSecureCookie(),
  domain?: string,
  name: string = OAUTH_BRIDGE_COOKIE
): string {
  return buildBridgeCookie(name, '', secure, 0, domain);
}

export interface AuthorizeRedirect {
  /** The hub `/api/auth/oauth/authorize` URL to 302 the browser to (top-level navigation). */
  location: string;
  /** The bridge `Set-Cookie`s to attach to that 302 (verifier + state + returnUrl, for the callback). */
  setCookies: string[];
}

/**
 * Initiate first-party login: generate PKCE + state, stash them (+ the validated returnUrl) in this flow's bridge
 * cookie, and build the hub authorize URL with this spoke's first-party client_id + exact redirect_uri.
 * Throws only if the hub isn't configured (`AUTH_JWT_ISSUER`).
 */
export function buildAuthorizeRedirect(opts: {
  /** This spoke's own origin (the request host) — its host is validated by the HUB against TrustedSpokeDomain. */
  selfOrigin: string;
  /** Post-login destination (a safe same-origin path; validated here). */
  returnUrl?: string;
  /** Requested scope. First-party defaults to a full session. */
  scope?: bigint;
  /** Cookie `Secure` flag. Defaults to the app's own protocol (`isSecureCookie()`). */
  secure?: boolean;
  /** Cookie `Domain` (the registrable domain, e.g. `civitai.red`) so the bridge cookie survives a host
   *  variation (www↔apex) between /authorize and /callback — host-only was being dropped there. Omit for
   *  host-only (dev/localhost). */
  cookieDomain?: string;
}): AuthorizeRedirect {
  const hub = hubBaseUrl();
  if (!hub) throw new Error('[@civitai/auth] hub not configured (AUTH_JWT_ISSUER)');

  const origin = opts.selfOrigin.replace(/\/+$/, '');
  const { verifier, challenge } = generatePkce();
  const state = randomState();
  const returnUrl = safePath(opts.returnUrl);

  const url = new URL(`${hub}/api/auth/oauth/authorize`);
  url.searchParams.set('client_id', firstPartyClientId(origin));
  url.searchParams.set('redirect_uri', `${origin}${SPOKE_CALLBACK_PATH}`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', String(opts.scope ?? TokenScope.Full));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  const payload = encodeURIComponent(JSON.stringify({ v: verifier, s: state, r: returnUrl }));
  const secure = opts.secure ?? isSecureCookie();
  return {
    location: url.toString(),
    setCookies: [
      buildBridgeCookie(
        bridgeCookieName(state),
        payload,
        secure,
        OAUTH_BRIDGE_TTL_S,
        opts.cookieDomain
      ),
      // Rollout only, for a callback served by a build that reads just this name. Remove with the
      // legacy read in completeFirstPartyCallback once a release carrying per-flow cookies is fully promoted.
      buildBridgeCookie(
        OAUTH_BRIDGE_COOKIE,
        payload,
        secure,
        OAUTH_BRIDGE_TTL_S,
        opts.cookieDomain
      ),
    ],
  };
}

export type FirstPartyCallbackResult =
  /** Success — set `token` as the session cookie and continue to `returnUrl`. `deviceId` (when the hub returns
   * one) is the SHARED family device id; set it as the spoke's civ-device so its account switcher matches the
   * rest of the family. */
  | { token: string; returnUrl: string; deviceId?: string; clearCookies: string[] }
  /** Failure — redirect to `/login?error=<error>` (e.g. `oauth_state`, `oauth_exchange`, or the hub's error).
   * `detail` (diagnostic only, not user-facing) sub-classifies the failure so a spoke can log WHICH cause it
   * hit — the sub-causes of `oauth_state` in particular need different fixes (see below). */
  | { error: string; returnUrl: string; detail?: string; clearCookies: string[] };

/**
 * Complete first-party login: verify `state` against this flow's bridge cookie, then exchange the code for a civ-token
 * SESSION at the hub's `/api/auth/oauth/session` endpoint (server-to-server, with the PKCE verifier). Returns
 * the token + validated returnUrl, or an error code. Either way the caller sets `clearCookies` (this flow's
 * stash only, so other tabs' flows stay intact) and, on success, the session cookie.
 */
export async function completeFirstPartyCallback(opts: {
  selfOrigin: string;
  query: { code?: string | null; state?: string | null; error?: string | null };
  /** The request's decoded cookies (Next `req.cookies`, or a parsed `Cookie` header). */
  cookies: Partial<Record<string, string>>;
  /** Cookie `Secure` flag for the clears. Defaults to the app's own protocol (`isSecureCookie()`). */
  secure?: boolean;
  /** The `Domain` the bridge cookies were set with (see `buildAuthorizeRedirect`), so the clears match. */
  cookieDomain?: string;
  /**
   * The real END-USER IP, forwarded to the hub as `x-forwarded-for` on the server-to-server session exchange
   * (same convention as the OAuth proxy + dev-token) so the hub's rate limiter keys on the real client, not the
   * spoke's egress IP. CRITICAL under internal routing (`AUTH_HUB_INTERNAL_URL`): those requests bypass Traefik
   * and arrive with NO XFF, which used to 500 the hub (`getClientAddress()` throws when `ADDRESS_HEADER` is
   * configured but the header is absent). Omit it and behavior is unchanged (public routing supplies XFF).
   */
  clientIp?: string;
}): Promise<FirstPartyCallbackResult> {
  const code = opts.query.code ?? undefined;
  const state = opts.query.state ?? undefined;
  const secure = opts.secure ?? isSecureCookie();
  const clearCookies: string[] = [];

  // CSRF: the returned state must name a stash this browser holds, and that stash must carry the same state
  // and a verifier. Only the cookie for THIS state is read and cleared; another tab's flow is left intact.
  let stash: Stash | undefined;
  let stashCookieSeen = false;
  const name = state && STATE_PATTERN.test(state) ? bridgeCookieName(state) : undefined;
  if (name) {
    if (opts.cookies[name] !== undefined) {
      stash = parseStash(opts.cookies[name]);
      stashCookieSeen = !!stash;
      clearCookies.push(clearBridgeCookie(secure, opts.cookieDomain, name));
    }
  }
  // Rollout only (see buildAuthorizeRedirect): a stash written under the pre-per-flow name counts only
  // when it carries this exact state.
  // Every authorize writes it, so one that holds another state is no sign of another flow.
  const legacy = parseStash(opts.cookies[OAUTH_BRIDGE_COOKIE]);
  if (legacy && state && legacy.s === state) {
    stashCookieSeen = true;
    stash ??= legacy;
    clearCookies.push(clearBridgeCookie(secure, opts.cookieDomain));
  }
  if (!stashCookieSeen) {
    // Another flow's stash: this browser has sign-in in flight, just not for this state.
    stashCookieSeen = Object.keys(opts.cookies).some(
      (k) => k !== name && k.startsWith(`${OAUTH_BRIDGE_COOKIE}_`)
    );
  }
  // A stash under this state's name but holding another state is no stash for this flow.
  if (stash && stash.s !== state) stash = undefined;
  const returnUrl = safePath(stash?.r);

  // Deny / error from the hub → surface the reason.
  if (opts.query.error) return { error: opts.query.error, returnUrl, clearCookies };

  // The single 'oauth_state' code hid three DISTINCT failures that each need a different fix, so `detail`
  // splits them:
  //   no_code        — the hub didn't return code+state (a hub-side or redirect problem, not the cookie)
  //   no_cookie      — no bridge cookie came back at all: not delivered, expired, or already consumed by an
  //                    earlier callback for this flow (a duplicate or back-button callback)
  //   state_mismatch — another flow's bridge cookie came back, but none holds this state
  if (!code || !state) return { error: 'oauth_state', returnUrl, detail: 'no_code', clearCookies };
  if (!stash?.v) {
    const detail = stashCookieSeen ? 'state_mismatch' : 'no_cookie';
    return { error: 'oauth_state', returnUrl, detail, clearCookies };
  }

  const origin = opts.selfOrigin.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Forward the real end-user IP so the hub's rate limiter keys on the client, not the spoke egress IP — and,
  // under internal routing (no proxy → no XFF), so the hub's getClientAddress() has a header to resolve.
  if (opts.clientIp) headers['x-forwarded-for'] = opts.clientIp;
  try {
    const internal = internalShapeReady() && loadAuthEnv().AUTH_INTERNAL_TOKEN;
    if (internal) headers.authorization = `Bearer ${internal}`;
    const res = await hubFetch('/api/auth/oauth/session', {
      method: 'POST',
      headers,
      body: JSON.stringify({ code, code_verifier: stash.v, client_id: firstPartyClientId(origin) }),
    });
    if (res.ok) {
      const data = (await res.json()) as { token?: string; deviceId?: string };
      if (data.token)
        return { token: data.token, returnUrl, deviceId: data.deviceId, clearCookies };
    }
    // hub reachable but rejected the code
    return { error: 'oauth_exchange', returnUrl, detail: 'declined', clearCookies };
  } catch {
    // hub unreachable / fetch threw
    return { error: 'oauth_exchange', returnUrl, detail: 'network', clearCookies };
  }
}

type Stash = { v?: string; s?: string; r?: string };

function parseStash(raw: string | undefined): Stash | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Stash) : undefined;
  } catch {
    return undefined; // malformed cookie — treated as a missing stash
  }
}
