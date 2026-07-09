import type { NextApiRequest } from 'next';

// The first-party login bridge core (PKCE/state, the hub authorize URL, the code→session exchange, and the
// bridge cookie) now lives in @civitai/auth — framework-agnostic, shared by every spoke and unit-tested there.
// This file keeps only the Next-specific origin derivation, and re-exports the package bridge so the spoke
// endpoints (authorize.ts / callback.ts) import everything from one place.
export {
  buildAuthorizeRedirect,
  completeFirstPartyCallback,
  clearBridgeCookie,
  safePath,
  firstPartyClientId,
  SPOKE_CALLBACK_PATH,
  OAUTH_BRIDGE_COOKIE,
} from '@civitai/auth';

// The hub origin (token issuer), trailing slashes stripped. Endpoints check this up front so a totally
// unconfigured hub returns a clear 500 ("hub not configured") instead of a misleading downstream error.
export const HUB_BASE_URL = (process.env.AUTH_JWT_ISSUER ?? '').replace(/\/+$/, '');

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
