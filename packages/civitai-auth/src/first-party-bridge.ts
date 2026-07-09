import { randomBytes, createHash } from 'crypto';
import { TokenScope } from './token-scope';
import { hubBaseUrl, hubFetch } from './hub';
import { firstPartyClientId, SPOKE_CALLBACK_PATH } from './first-party';
import { isSecureCookie } from './cookies';

// FIRST-PARTY LOGIN BRIDGE (spoke side) — the framework-agnostic core of the OAuth authorization-code + PKCE
// login a first-party app runs against the hub. A spoke on a different registrable domain can't read the hub's
// `.civitai.com` cookie, so it runs this flow to mint its OWN session cookie. Two steps, both pure (strings in,
// strings out) so a Next route handler or a SvelteKit `+server.ts` is a thin wrapper:
//   1. buildAuthorizeRedirect — generate PKCE+state, return the hub /authorize URL + the bridge Set-Cookie.
//   2. completeFirstPartyCallback — verify state, exchange the code at the hub /session endpoint, return token.
// The app owns only what's genuinely framework-specific: deriving its own origin, reading the request
// cookie/query, setting the session cookie, and issuing the redirects.

/** Short-lived cookie carrying the PKCE verifier + state + returnUrl between initiate and callback. */
export const OAUTH_BRIDGE_COOKIE = 'oauth_bridge';
const OAUTH_BRIDGE_TTL_S = 600; // 10 min — matches the hub's auth-code TTL

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

/**
 * Only ever continue to a same-origin PATH (no open redirect through returnUrl). Rejects protocol-relative
 * `//host` AND backslash-prefixed `/\host` / `/\/host` — some agents normalize `\`→`/`, turning the latter
 * into a protocol-relative external redirect.
 */
export function safePath(raw: unknown): string {
  return typeof raw === 'string' && raw.startsWith('/') && !/^\/[/\\]/.test(raw) ? raw : '/';
}

function buildBridgeCookie(value: string, secure: boolean, maxAge: number): string {
  return [
    `${OAUTH_BRIDGE_COOKIE}=${value}`,
    `Path=${SPOKE_CALLBACK_PATH}`, // scoped to the callback — never sent elsewhere
    'HttpOnly',
    // SameSite=None so the cookie survives the CROSS-REGISTRABLE-DOMAIN OAuth round-trip
    // (civitai.red → auth.civitai.com → civitai.red). Prod telemetry showed Lax being dropped on that return
    // for .red at ~5x the .com rate (oauth_state=no_cookie). Safe here: the cookie is HttpOnly, Path-scoped,
    // 10-min, and carries only the PKCE verifier + state guarded by the state check — not a session. None
    // REQUIRES Secure, so fall back to Lax when the cookie isn't Secure (dev/http, where the flow is same-site
    // localhost and Lax works).
    secure ? 'SameSite=None' : 'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    `Max-Age=${maxAge}`,
  ].join('; ');
}

/** Set-Cookie string that expires the bridge cookie (single-use cleanup; set it on the callback response). */
export function clearBridgeCookie(secure: boolean = isSecureCookie()): string {
  return buildBridgeCookie('', secure, 0);
}

export interface AuthorizeRedirect {
  /** The hub `/api/auth/oauth/authorize` URL to 302 the browser to (top-level navigation). */
  location: string;
  /** The bridge `Set-Cookie` to attach to that 302 (verifier + state + returnUrl, for the callback). */
  setCookie: string;
}

/**
 * Initiate first-party login: generate PKCE + state, stash them (+ the validated returnUrl) in the bridge
 * cookie, and build the hub authorize URL with this spoke's first-party client_id + exact redirect_uri.
 * Throws only if the hub isn't configured (`AUTH_JWT_ISSUER`).
 */
export function buildAuthorizeRedirect(opts: {
  /** This spoke's own origin (the request host) — its host is validated by the HUB against TrustedSpokeDomain. */
  selfOrigin: string;
  /** Post-login destination (a safe same-origin path; validated here). */
  returnUrl?: string;
  /** Requested scope. First-party defaults to a full session. */
  scope?: number;
  /** Cookie `Secure` flag. Defaults to the app's own protocol (`isSecureCookie()`). */
  secure?: boolean;
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
  return {
    location: url.toString(),
    setCookie: buildBridgeCookie(payload, opts.secure ?? isSecureCookie(), OAUTH_BRIDGE_TTL_S),
  };
}

export type FirstPartyCallbackResult =
  /** Success — set `token` as the session cookie and continue to `returnUrl`. `deviceId` (when the hub returns
   * one) is the SHARED family device id; set it as the spoke's civ-device so its account switcher matches the
   * rest of the family. */
  | { token: string; returnUrl: string; deviceId?: string }
  /** Failure — redirect to `/login?error=<error>` (e.g. `oauth_state`, `oauth_exchange`, or the hub's error).
   * `detail` (diagnostic only, not user-facing) sub-classifies the failure so a spoke can log WHICH cause it
   * hit — the sub-causes of `oauth_state` in particular need different fixes (see below). */
  | { error: string; returnUrl: string; detail?: string };

/**
 * Complete first-party login: verify `state` against the bridge cookie, then exchange the code for a civ-token
 * SESSION at the hub's `/api/auth/oauth/session` endpoint (server-to-server, with the PKCE verifier). Returns
 * the token + validated returnUrl, or an error code. The caller clears the bridge cookie + sets the session
 * cookie.
 */
export async function completeFirstPartyCallback(opts: {
  selfOrigin: string;
  query: { code?: string | null; state?: string | null; error?: string | null };
  /** The decoded `oauth_bridge` cookie value from the request (Next `req.cookies[...]` / SvelteKit `cookies.get`). */
  bridgeCookieValue: string | undefined;
  /**
   * The real END-USER IP, forwarded to the hub as `x-forwarded-for` on the server-to-server session exchange
   * (same convention as the OAuth proxy + dev-token) so the hub's rate limiter keys on the real client, not the
   * spoke's egress IP. CRITICAL under internal routing (`AUTH_HUB_INTERNAL_URL`): those requests bypass Traefik
   * and arrive with NO XFF, which used to 500 the hub (`getClientAddress()` throws when `ADDRESS_HEADER` is
   * configured but the header is absent). Omit it and behavior is unchanged (public routing supplies XFF).
   */
  clientIp?: string;
}): Promise<FirstPartyCallbackResult> {
  let stash: { v?: string; s?: string; r?: string } | undefined;
  if (opts.bridgeCookieValue) {
    try {
      stash = JSON.parse(opts.bridgeCookieValue);
    } catch {
      // malformed cookie — treated as a missing stash below
    }
  }
  const returnUrl = safePath(stash?.r);

  // Deny / error from the hub → surface the reason.
  if (opts.query.error) return { error: opts.query.error, returnUrl };

  const code = opts.query.code ?? undefined;
  const state = opts.query.state ?? undefined;
  // CSRF: the returned state must match the one we stashed (and we must have a verifier). The single
  // 'oauth_state' code hid three DISTINCT failures that each need a different fix, so `detail` splits them:
  //   no_code        — the hub didn't return code+state (a hub-side or redirect problem, not the cookie)
  //   no_cookie      — the bridge cookie didn't come back at all: the cross-site SameSite=Lax delivery failed
  //                    (or it expired) — the likely `.red`-specific cause, since `.com` is same-site
  //   state_mismatch — the cookie came back but its state ≠ the returned state: a CONCURRENT/stale login
  //                    (multi-tab, retry) clobbered the single fixed-name bridge cookie
  if (!code || !state) return { error: 'oauth_state', returnUrl, detail: 'no_code' };
  if (!stash?.v || !stash.s) return { error: 'oauth_state', returnUrl, detail: 'no_cookie' };
  if (state !== stash.s) return { error: 'oauth_state', returnUrl, detail: 'state_mismatch' };

  const origin = opts.selfOrigin.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Forward the real end-user IP so the hub's rate limiter keys on the client, not the spoke egress IP — and,
  // under internal routing (no proxy → no XFF), so the hub's getClientAddress() has a header to resolve.
  if (opts.clientIp) headers['x-forwarded-for'] = opts.clientIp;
  try {
    const res = await hubFetch('/api/auth/oauth/session', {
      method: 'POST',
      headers,
      body: JSON.stringify({ code, code_verifier: stash.v, client_id: firstPartyClientId(origin) }),
    });
    if (res.ok) {
      const data = (await res.json()) as { token?: string; deviceId?: string };
      if (data.token) return { token: data.token, returnUrl, deviceId: data.deviceId };
    }
    return { error: 'oauth_exchange', returnUrl, detail: 'declined' }; // hub reachable but rejected the code
  } catch {
    return { error: 'oauth_exchange', returnUrl, detail: 'network' }; // hub unreachable / fetch threw
  }
}
