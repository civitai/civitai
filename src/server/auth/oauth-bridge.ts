import type { NextApiRequest } from 'next';
import { SPOKE_CALLBACK_PATH as CALLBACK_PATH } from '@civitai/auth';

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

// ── Bridge-cookie delivery PROBE (temporary diagnostic) ─────────────────────────────────────────────────────
// A Domain-scoped, 1-hour companion to the 10-min host-only bridge cookie — set alongside it at /authorize,
// read at /callback. When the bridge cookie is MISSING (oauth_state=no_cookie) it separates the causes that
// the Domain fix's own before/after can't:
//   probe present, authHost ≠ callback host → a host variation (www↔apex) the new Domain scope now covers;
//   probe present, ageMs > bridge TTL (10m)  → the login outran the bridge cookie's lifetime (expiry);
//   probe ABSENT                             → a full cross-site cookie block or a bot (no cookies at all).
// It carries NO secret — only the origin host + a timestamp. Remove once the .red no_cookie cause is settled.
export const BRIDGE_PROBE_COOKIE = 'oauth_bridge_probe';
const BRIDGE_PROBE_TTL_S = 3600;

export function buildBridgeProbeCookie(opts: { host: string; domain?: string; secure: boolean }): string {
  const payload = encodeURIComponent(JSON.stringify({ h: opts.host, t: Date.now() }));
  return [
    `${BRIDGE_PROBE_COOKIE}=${payload}`,
    `Path=${CALLBACK_PATH}`,
    'HttpOnly',
    opts.secure ? 'SameSite=None' : 'SameSite=Lax',
    ...(opts.secure ? ['Secure'] : []),
    ...(opts.domain ? [`Domain=${opts.domain}`] : []),
    `Max-Age=${BRIDGE_PROBE_TTL_S}`,
  ].join('; ');
}

/** Decode the probe cookie → the origin host it was set on + how long ago (ms), or undefined if absent/bad. */
export function readBridgeProbe(
  value: string | undefined
): { authHost?: string; ageMs?: number } | undefined {
  if (!value) return undefined;
  try {
    const p = JSON.parse(decodeURIComponent(value)) as { h?: unknown; t?: unknown };
    return {
      authHost: typeof p.h === 'string' ? p.h : undefined,
      ageMs: typeof p.t === 'number' ? Date.now() - p.t : undefined,
    };
  } catch {
    return undefined;
  }
}
