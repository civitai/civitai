// Ported from the main app's src/shared/constants/block-scope.constants.ts (only the A1 security gate is
// needed hub-side; the block-scope bitmask mapping stays in the main app with the block-token minting).
//
// App-Blocks-provisioned OauthClients carry a deterministic `appblk-<slug>` id; genuine developer
// OAuth-apps clients use a uuidv4 id. The prefix is a migration-free discriminator between the two
// populations.
//
// SECURITY (audit A1): app-block clients exist ONLY as the policy ceiling for block-token minting — they
// must NEVER drive the interactive authorization_code / device flows, which mint a real account Bearer
// token (an app-block owner could otherwise phish a user through the consent screen → account takeover).
// /authorize and /device gate on this predicate before the client is even loaded. Scoped to `appblk-`
// ids only; uuid-id OAuth-apps clients are unaffected.
export const APP_BLOCK_OAUTH_CLIENT_ID_PREFIX = 'appblk-';

export function isAppBlockOauthClientId(clientId: string | null | undefined): boolean {
  return typeof clientId === 'string' && clientId.startsWith(APP_BLOCK_OAUTH_CLIENT_ID_PREFIX);
}
