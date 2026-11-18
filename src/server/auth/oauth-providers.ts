import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';
import { oauthProviderIds, type OAuthProviderId } from '~/server/utils/server-domain';

// The OAuth providers a user can connect, sourced from the HUB, which is the SINGLE authority for
// provider config + secrets (the spoke holds NO provider secrets). Fetched server-to-server from
// `GET {hub}/api/auth/providers` and cached in-memory. Server-only: `_app` imports this inside a
// `typeof window === 'undefined'` block, so it stays out of the client bundle (it reads the flag
// client). It lives apart from `server-domain`, which client components import.
//
// `_app` awaits this on EVERY full server render, anonymous included:
//   - the hub fetch is bounded by PROVIDERS_FETCH_TIMEOUT_MS (headers and body) through
//     `fetchTimeoutSignal`, so the outbound-fetch off-switch also removes this bound;
//   - concurrent renders share one in-flight fetch;
//   - every failure fails OPEN to the last-good (or empty) list.
// Behind the DEFAULT-OFF `oauth-providers-serve-stale` flag (absent or uninitialised = off):
//   - an expired list is served at once and refreshed in the background;
//   - after a failure, renders skip the hub for PROVIDERS_FAILURE_BACKOFF_MS.
const PROVIDERS_TTL_MS = 10 * 60_000;
const PROVIDERS_FETCH_TIMEOUT_MS = 1_500;
const PROVIDERS_FAILURE_BACKOFF_MS = 30_000;
let providersCache: { ids: OAuthProviderId[]; at: number } | undefined;
let providersInFlight: Promise<OAuthProviderId[] | undefined> | undefined;
let providersFailedAt: number | undefined;

function serveStaleEnabled(): boolean {
  try {
    return isFliptSync(FLIPT_FEATURE_FLAGS.OAUTH_PROVIDERS_SERVE_STALE) === true;
  } catch {
    return false;
  }
}

async function fetchOAuthProviders(hub: string): Promise<OAuthProviderId[] | undefined> {
  try {
    const res = await fetch(`${hub}/api/auth/providers`, {
      signal: fetchTimeoutSignal(PROVIDERS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { providers?: { id?: string }[] };
    const known = new Set<string>(oauthProviderIds);
    const ids = (data.providers ?? [])
      .map((p) => p?.id)
      .filter((id): id is OAuthProviderId => typeof id === 'string' && known.has(id));
    providersCache = { ids, at: Date.now() };
    providersFailedAt = undefined;
    return ids;
  } catch {
    return undefined; // hub unreachable or too slow
  }
}

function refreshOAuthProviders(hub: string) {
  providersInFlight ??= fetchOAuthProviders(hub)
    .then((ids) => {
      if (ids === undefined) providersFailedAt = Date.now();
      return ids;
    })
    .finally(() => {
      providersInFlight = undefined;
    });
  return providersInFlight;
}

export async function getAvailableOAuthProviders(): Promise<OAuthProviderId[]> {
  if (providersCache && Date.now() - providersCache.at < PROVIDERS_TTL_MS)
    return providersCache.ids;

  const hub = (process.env.AUTH_JWT_ISSUER ?? '').replace(/\/+$/, '');
  if (!hub) return providersCache?.ids ?? [];

  if (serveStaleEnabled()) {
    const backingOff =
      providersFailedAt !== undefined &&
      Date.now() - providersFailedAt < PROVIDERS_FAILURE_BACKOFF_MS;
    if (providersCache) {
      if (!backingOff) void refreshOAuthProviders(hub);
      return providersCache.ids;
    }
    if (backingOff) return [];
  }

  return (await refreshOAuthProviders(hub)) ?? providersCache?.ids ?? [];
}
