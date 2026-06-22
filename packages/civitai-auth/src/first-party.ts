// Shared, browser-safe contract for FIRST-PARTY (trusted) OAuth clients — used by BOTH the hub
// (apps/auth: resolves these clients, skips consent, allows the session exchange) and the spoke
// (main app: builds the /authorize request + the callback). Keeping the client-id derivation as ONE
// definition here means the two sides can never drift; divergence would silently break every
// cross-domain login (the hub wouldn't recognize the spoke's computed client_id). Pure string math —
// no env, no node-only APIs — so it's safe in any bundle.

/** Namespace prefix — disjoint from third-party (uuid) and app-block (`appblk-`) client ids. */
export const FIRST_PARTY_ID_PREFIX = 'firstparty-';

/** The spoke receiver path for the auth-code callback (replaces the swap bridge's /api/auth/sync receiver). */
export const SPOKE_CALLBACK_PATH = '/api/auth/callback';

/**
 * Deterministic first-party client id for a spoke origin (https://civitai.red → firstparty-civitai_red).
 * Includes a NON-DEFAULT port so two ports of one hostname (dev: localhost:3000 vs :5173) don't collapse to
 * the same id with different redirect_uris. Default ports (prod https → 443) normalize to '' via the URL
 * parser, so prod ids are unchanged — `https://civitai.red` and `https://civitai.red:443` both →
 * `firstparty-civitai_red`.
 */
export function firstPartyClientId(origin: string): string {
  const url = new URL(origin);
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  return `${FIRST_PARTY_ID_PREFIX}${host.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}
