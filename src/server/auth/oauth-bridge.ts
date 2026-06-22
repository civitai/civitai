import type { NextApiRequest } from 'next';
import { createHash, randomBytes } from 'crypto';
import { isSecureCookie, firstPartyClientId, SPOKE_CALLBACK_PATH } from '@civitai/auth';

// Re-exported so the spoke endpoints (authorize.ts / callback.ts) keep importing these from here; the
// definitions now live in @civitai/auth — ONE source shared with the hub, so the client-id derivation
// can never drift (a divergence would silently break every cross-domain login).
export { firstPartyClientId, SPOKE_CALLBACK_PATH };

// Shared helpers for the FIRST-PARTY OAuth auth-code login bridge (the SPOKE side that replaces the
// bespoke swap-token bridge). `/api/auth/authorize` initiates; `/api/auth/callback` receives. The hub
// (auth.civitai.com) is the OAuth provider; the result is the SAME civ-token session cookie the swap
// exchange produced, so existing sessions/cookie format are unaffected.

export const HUB_BASE_URL = (process.env.AUTH_JWT_ISSUER ?? '').replace(/\/+$/, '');
// Short-lived cookie carrying the PKCE verifier + state + returnUrl between initiate and callback. Scoped
// to the callback path; httpOnly; SameSite=Lax so it rides the top-level GET redirect back from the hub.
export const OAUTH_BRIDGE_COOKIE = 'oauth_bridge';
export const OAUTH_BRIDGE_TTL_S = 600; // 10 min — matches the hub's auth-code TTL

/**
 * This spoke's own origin for the OAuth round-trip + callback — the ACTUAL request host (multi-host deploys
 * serve many hosts off one build, so a static base URL would be wrong on aliases). We do NOT validate the
 * host here: the spoke only ever feeds this origin into the hub `/authorize` request's `redirect_uri` +
 * `client_id`, and the HUB is the single authority that validates them against its `TrustedSpokeDomain`
 * registry (an unregistered host fails closed at the hub). `selfOrigin` is never itself a redirect target
 * on the spoke, so an unvalidated Host can't cause an open redirect. Enabling a new login host (e.g.
 * `test-auth.civitai.red`) is therefore ONE row in the hub's registry — nothing here. Falls back to
 * NEXT_PUBLIC_BASE_URL only when there's no Host at all.
 */
export function resolveSelfOrigin(req: NextApiRequest): string | undefined {
  const fwd = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
  const host = fwd?.split(',')[0]?.trim().toLowerCase();
  if (!host) return process.env.NEXT_PUBLIC_BASE_URL;
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ??
    (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Only ever continue to a same-origin PATH (no open redirect through returnUrl). */
export function safePath(raw: unknown): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

const b64url = (buf: Buffer) => buf.toString('base64url');

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

/** Set-Cookie string for the bridge cookie (manual build — mirrors civ-cookie.ts, no cookie lib needed). */
export function bridgeCookie(payload: string): string {
  return [
    `${OAUTH_BRIDGE_COOKIE}=${encodeURIComponent(payload)}`,
    `Path=${SPOKE_CALLBACK_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(isSecureCookie() ? ['Secure'] : []),
    `Max-Age=${OAUTH_BRIDGE_TTL_S}`,
  ].join('; ');
}

/** Set-Cookie string that expires the bridge cookie (single-use cleanup). */
export function clearBridgeCookie(): string {
  return [
    `${OAUTH_BRIDGE_COOKIE}=`,
    `Path=${SPOKE_CALLBACK_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(isSecureCookie() ? ['Secure'] : []),
    'Max-Age=0',
  ].join('; ');
}
