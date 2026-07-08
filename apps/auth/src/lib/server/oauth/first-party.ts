import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { TokenScope } from '@civitai/auth/token-scope';
import {
  firstPartyClientId,
  FIRST_PARTY_ID_PREFIX,
  SPOKE_CALLBACK_PATH,
  createTrustedDomainRegistry,
} from '@civitai/auth';
import { db } from '$lib/server/db/db';

// Re-exported so existing hub imports keep working; the definitions live in @civitai/auth (one source,
// shared with the spoke).
export { firstPartyClientId, FIRST_PARTY_ID_PREFIX, SPOKE_CALLBACK_PATH };

// First-party (trusted) OAuth clients — the spoke color domains. These clients skip the consent screen and
// are the ONLY clients whose authorization code can be exchanged for a civ-token SESSION (the BFF flow at
// /api/auth/oauth/session); third-party codes can't reach it.
//
// The set of trusted login hosts lives in the `TrustedSpokeDomain` table (managed in-app — no per-host
// devops env). A host is authorized if it EXACTLY matches a row's `domain`, or — for a row with
// `includeSubdomains` — is a subdomain of it (covers ephemeral PR-preview hosts like pr-2468.civitaic.com).
// Resolution is ORIGIN-based: the hub never trusts a bare client_id slug; it validates the request's
// redirect_uri origin (whose host it checks against the registry) and synthesizes a per-origin client with an
// EXACT callback. So the wildcard only governs whether a host is authorized, never the redirect_uri match.

export interface FirstPartyClient {
  clientId: string;
  origin: string; // e.g. https://civitai.red
  redirectUri: string; // e.g. https://civitai.red/api/auth/callback (exact)
  allowedScopes: number; // first-party mints a full session → Full
  grants: string[];
  isConfidential: boolean;
}

/** Synthesize the first-party client for a specific spoke origin — everything derived from the origin. */
function clientForOrigin(origin: string): FirstPartyClient {
  return {
    clientId: firstPartyClientId(origin),
    origin,
    redirectUri: `${origin}${SPOKE_CALLBACK_PATH}`,
    allowedScopes: TokenScope.Full,
    grants: ['authorization_code'],
    isConfidential: false,
  };
}

// ── Trusted-spoke-domain registry ─────────────────────────────────────────────────────────────────────
// ONE in-memory-cached (~60s) instance over the `TrustedSpokeDomain` table, shared by first-party OAuth
// client resolution AND the post-login redirect guard (buildPostLoginOriginCheck below). The cache/match
// logic lives in @civitai/auth (createTrustedDomainRegistry — reusable by any spoke); we inject only the
// Kysely query + the dev-loopback hosts (so local login needs no seeding when the hub runs in dev).
//
// DEV RGB proxy: the main app can serve local dev off the rgb-proxy color domains
// (civitai-dev.{red,green,blue}), which are distinct registrable domains, not loopback — so first-party
// login from them would fail the trust check. `AUTH_DEV_TRUST_HOSTS` (dev-only, comma-separated) adds those
// hosts to the always-trust set without seeding DB rows. Ignored entirely in prod (`dev` is false).
const devAlwaysTrust = dev
  ? [
      'localhost',
      '127.0.0.1',
      ...(env.AUTH_DEV_TRUST_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ]
  : [];

export const spokeDomains = createTrustedDomainRegistry({
  load: async () => {
    const rows = await db
      .selectFrom('TrustedSpokeDomain')
      .select(['domain', 'includeSubdomains'])
      .where('enabled', '=', true)
      .execute();
    return rows.map((r) => ({ domain: r.domain, includeSubdomains: r.includeSubdomains }));
  },
  alwaysTrustHosts: devAlwaysTrust,
});

/** Parse the origin (scheme+host[+port]) of a URL, or undefined if unparseable. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the first-party client for a spoke ORIGIN, if its host is authorized (exact / subdomain-wildcard /
 * dev-loopback). Returns a per-origin client with an exact callback, or undefined.
 */
export async function firstPartyClientForOrigin(
  origin: string
): Promise<FirstPartyClient | undefined> {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return (await spokeDomains.matchesHost(hostname)) ? clientForOrigin(origin) : undefined;
}

/** Is this origin an authorized first-party login host? (Gates consent-skip + the session exchange.) */
export async function isFirstPartyOrigin(origin: string | undefined): Promise<boolean> {
  return !!origin && (await firstPartyClientForOrigin(origin)) !== undefined;
}

/**
 * The post-login redirect origin check: resolve the registry once → a sync predicate that allows registered
 * spoke hosts (+ dev loopback) UNION the owned-eTLD+1 backstop (so a cold/erroring registry can't reject all
 * cross-origin post-login redirects). Injected into the hub's buildPostLoginRedirect. This is what makes the
 * registry the single source — a new owned host is a registry row, not an edit to CIVITAI_OWNED_DOMAINS.
 */
export const buildPostLoginOriginCheck = (): Promise<(origin: string) => boolean> =>
  spokeDomains.ownedOriginCheck();

/**
 * Force the next registry read to re-query — call after a TrustedSpokeDomain write (e.g. the admin UI) so
 * edits take effect immediately on this instance instead of waiting out the ~60s cache window. (Other
 * instances still refresh on their own TTL; the registry is small and changes are rare.)
 */
export function invalidateDomainCache(): void {
  spokeDomains.invalidate();
}
