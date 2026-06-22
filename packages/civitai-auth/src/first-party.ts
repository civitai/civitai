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

/** Deterministic first-party client id for a spoke origin (https://civitai.red → firstparty-civitai_red). */
export function firstPartyClientId(origin: string): string {
  const host = new URL(origin).hostname.toLowerCase();
  return `${FIRST_PARTY_ID_PREFIX}${host.replace(/[^a-z0-9]/g, '_')}`;
}
