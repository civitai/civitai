/**
 * Block Scope — string scopes carried in block JWT claims, mapped to the
 * existing OAuth bitmask scopes for forward-compatibility.
 *
 * Single source of truth for block-scope → OauthClient.allowedScopes bit mapping.
 *
 * Block manifests declare which scopes their iframe needs. Two gates:
 *   1. Registration: the manifest's scope set must be a strict subset of
 *      the OauthClient's allowedScopes bitmask (per-bit).
 *   2. Token issuance: at /api/v1/block-tokens, the same check runs again
 *      to defend against post-approval manifest swaps (audit H-1 + C2).
 *
 * Block JWT scopes are a different concept from the underlying OAuth bits:
 * they're per-block-instance and short-lived (15min). The OAuth bit on the
 * publisher's app is the policy ceiling. A scope with `SKIP_OAUTH_CHECK`
 * (e.g. apps:storage:*) gates elsewhere — see the per-op server-side checks
 * (resolveStorageContext / resolveSharedContext).
 *
 * Forward-extensibility contract:
 *   - New block scopes MUST be added here with their OAuth-bit relationship.
 *   - A scope that intentionally has no bitmask requirement (e.g.
 *     apps:storage:*) uses the `SKIP_OAUTH_CHECK` sentinel — NOT a 0
 *     value. The sentinel is explicit so a future maintainer doesn't
 *     accidentally type 0 and get OAuth-allowlist bypass by surprise.
 */

import { TokenScope } from './token-scope.constants';

/**
 * Sentinel value for scopes that intentionally do not require an OAuth-bitmask
 * bit. The validator treats this as "approval gate elsewhere" (e.g. the
 * per-op server-side checks for apps:storage:*).
 */
export const SKIP_OAUTH_CHECK = Symbol('SKIP_OAUTH_CHECK');
export type ScopeBitmaskRequirement = number | typeof SKIP_OAUTH_CHECK;

export const BLOCK_SCOPE_TO_OAUTH_BIT: Record<string, ScopeBitmaskRequirement> = {
  'models:read:self': TokenScope.ModelsRead,
  // NOTE: there is intentionally NO `catalog:read` scope. The block catalog
  // endpoints (/api/v1/blocks/models, /api/v1/blocks/images) serve PUBLIC,
  // maturity-clamped data and accept ANY valid block token (withBlockScope with
  // no requiredScope) — they need the token only for its signed
  // `maxBrowsingLevel` claim, not for authorization. A `catalog:read` scope was
  // briefly added (#2671) and retired the next day: requiring a
  // declarable+grantable scope added friction (Go CLI manifest validator + each
  // app's OauthClient.allowedScopes bit) with no security value, since the
  // catalog is strictly MORE restricted than the public /api/v1/models.
  // NOTE: there is intentionally NO `media:read:owned` block scope. It was
  // declared/validated/mintable but had NO runtime consumer that ever checked
  // it (no block-token endpoint gated on it), so it was purely decorative and
  // was removed as part of the "every declared block scope is actually
  // enforced" hygiene pass. The underlying OAuth `TokenScope.MediaRead` bit is
  // UNCHANGED — it still backs ~80 tRPC media routes (image/post/comment/…) via
  // `requiredScope`; it simply no longer maps to a block scope.
  'user:read:self': TokenScope.UserRead,
  'ai:write:budgeted': TokenScope.AIServicesWrite,
  'buzz:read:self': TokenScope.BuzzRead,
  // NOTE: there is intentionally NO `block:settings:read` / `block:settings:write`
  // block scope. Both were declared/validated/mintable but NO runtime capability
  // ever verified them (the per-install settings read/write paths authorize on
  // valid-token + app-developer + installer-resolution, not on a token scope), so
  // they were purely decorative and were removed in the same hygiene pass. There is
  // no OAuth bit to orphan — they used SKIP_OAUTH_CHECK, not a TokenScope bit.
  'social:tip:self': TokenScope.SocialTip,
  // apps:storage:* — the W4 KV datastore. There is no OAuth bitmask bit for
  // per-app storage (it never touches the user's civitai resources via the
  // OAuth surface), so it uses SKIP_OAUTH_CHECK like block:settings:*. The
  // real gate is two-fold: (1) the scope must be in the block's
  // `approvedScopes` snapshot to be minted into the token, and (2)
  // `resolveStorageContext` asserts the scope is present on `claims.scopes`
  // per op (read vs write). Without this entry the scope was an *ambient*
  // capability — every approved block could read/write the KV store with no
  // declared/approved scope (audit A5 / design-gaps H4). Adding it here also
  // makes it a declarable manifest scope (the manifest validator rejects
  // unknown scopes, so previously a manifest *couldn't* even list it).
  'apps:storage:read': SKIP_OAUTH_CHECK,
  'apps:storage:write': SKIP_OAUTH_CHECK,
  // apps:storage:shared:* — the SHARED (app-global / cross-user) datastore. Same
  // no-OAuth-bit posture as apps:storage:* (never touches the user's civitai
  // resources via the OAuth surface). SKIP_OAUTH_CHECK; the real gate is
  // `resolveSharedContext` (apps-shared.router) which asserts the scope is present
  // per op AND runs the min-trust gate + the dedicated fail-closed Flipt flag.
  // DELIBERATELY kept OUT of BOTH dev-mint allowlists (DEV_TOKEN_SCOPE_ALLOWLIST,
  // TUNNEL_HOST_MINT_SCOPE_ALLOWLIST) — granted only to approved, mod-reviewed
  // apps that declare it, never to a pre-approval dev-tunnel/dev-token session.
  'apps:storage:shared:read': SKIP_OAUTH_CHECK,
  'apps:storage:shared:write': SKIP_OAUTH_CHECK,
  // collections:read:self / collections:write:self — the App Blocks Collections
  // surface (discover + read public collections and the viewer's OWN collections;
  // follow/bookmark a collection on the viewer's behalf). Same no-OAuth-bit
  // posture as apps:storage:* — these never touch the user's civitai resources
  // through the OAuth surface, so there is no bitmask bit; SKIP_OAUTH_CHECK makes
  // that explicit. The REAL gate is SERVER-SIDE and per-op:
  //   - read: collection VISIBILITY/OWNERSHIP — a private collection is 404 to a
  //     non-owner/contributor (existence-leak-safe), and item reads are clamped to
  //     the token's `maxBrowsingLevel` maturity ceiling;
  //   - write (follow): the token SUBJECT is the actor (self-bound), the block
  //     endpoint follows/unfollows on the caller's own behalf.
  // Both are additionally bound to a NON-ANON subject in the block-scope
  // middleware (self-scopes), and both are consent-exempt (server
  // visibility/ownership is the gate, not a per-scope consent prompt) — see
  // scope-grant.service.ts CONSENT_EXEMPT_SCOPES. Adding them here also makes them
  // declarable manifest scopes (the manifest validator rejects unknown scopes).
  'collections:read:self': SKIP_OAUTH_CHECK,
  'collections:write:self': SKIP_OAUTH_CHECK,
  // collections:read:private — the subject's OWN PRIVATE collections. Split out
  // from collections:read:self (which covers own-PUBLIC + any PUBLIC collection)
  // so that reading a user's PRIVATE collections requires an EXPLICIT per-user
  // consent grant. Same no-OAuth-bit posture (SKIP_OAUTH_CHECK; server enforces
  // ownership), and self-scope (non-anon subject) in the middleware. CRITICAL:
  // this scope is CONSENT-GATED — it is deliberately NOT in CONSENT_EXEMPT_SCOPES,
  // so it flows through partitionByConsent's gated set and the user must grant it
  // via the host consent gate before a token carries it (contrast read:self,
  // which is exempt and always mints). See scope-grant.service.ts.
  'collections:read:private': SKIP_OAUTH_CHECK,
} as const;

export type BlockScopeString = keyof typeof BLOCK_SCOPE_TO_OAUTH_BIT;

export function isKnownBlockScope(scope: string): scope is BlockScopeString {
  return scope in BLOCK_SCOPE_TO_OAUTH_BIT;
}

/**
 * Validates that every requested block scope either declares no OAuth-bit
 * requirement (SKIP_OAUTH_CHECK) or has its OAuth bit set in the
 * OauthClient.allowedScopes bitmask.
 *
 * Returns `{ valid: true }` when all scopes pass, otherwise the list of
 * rejected scopes (unknown scopes plus scopes whose required bit is missing).
 */
export function validateBlockScopesAgainstOauthClient(
  blockScopes: string[],
  oauthClientAllowedScopes: number
): { valid: boolean; rejectedScopes: string[] } {
  const rejected: string[] = [];
  for (const scope of blockScopes) {
    if (!isKnownBlockScope(scope)) {
      rejected.push(scope);
      continue;
    }
    const requirement = BLOCK_SCOPE_TO_OAUTH_BIT[scope];
    if (requirement === SKIP_OAUTH_CHECK) continue;
    if ((oauthClientAllowedScopes & requirement) !== requirement) {
      rejected.push(scope);
    }
  }
  return { valid: rejected.length === 0, rejectedScopes: rejected };
}

/**
 * Deterministic id prefix every App-Blocks-provisioned OauthClient carries
 * (`appblk-<slug>`, set in publish-request.service.ts approveRequest). Genuine
 * developer-registered OAuth-apps clients use a uuidv4 id (oauth-client.router
 * create), so the prefix is a mutually-exclusive, migration-free discriminator
 * between the two client populations.
 *
 * SECURITY (audit A1/A2): App-block clients exist ONLY to be the policy ceiling
 * for block-token minting — they must never participate in the interactive
 * authorization_code / device OAuth flows (that path mints a real account
 * Bearer token). Every OAuth-provider surface that could turn one of these rows
 * into an account-takeover primitive gates on this predicate. The gate is
 * scoped to `appblk-` rows ONLY — the legitimate OAuth-apps feature
 * (uuid-id `oauth_app` clients) is left byte-for-byte unaffected.
 */
export const APP_BLOCK_OAUTH_CLIENT_ID_PREFIX = 'appblk-';

export function isAppBlockOauthClientId(clientId: string | null | undefined): boolean {
  return typeof clientId === 'string' && clientId.startsWith(APP_BLOCK_OAUTH_CLIENT_ID_PREFIX);
}

/**
 * Derive the OAuth-bitmask ceiling an app-block OauthClient should carry from
 * its manifest's declared block scopes. App-block clients must NOT default to
 * `TokenScope.Full` (audit A1/A3/A4) — that made the auto-provisioned client a
 * Full-scope authorization_code client and rendered the manifest scope gate
 * inert (any manifest scope was always within the all-bits ceiling).
 *
 * The bitmask is the OR of the OAuth bits each known scope maps to. Scopes
 * with `SKIP_OAUTH_CHECK` (apps:storage:*) and unknown
 * scopes contribute nothing — they are gated by other mechanisms, not the
 * OAuth bitmask. Result is therefore the *intersection* of the manifest with
 * the OAuth-eligible scope set, exactly what the validator / token-mint path
 * expects as the per-client ceiling.
 */
export function deriveOauthBitmaskFromBlockScopes(blockScopes: string[]): number {
  let bitmask = 0;
  for (const scope of blockScopes) {
    if (!isKnownBlockScope(scope)) continue;
    const requirement = BLOCK_SCOPE_TO_OAUTH_BIT[scope];
    if (requirement === SKIP_OAUTH_CHECK) continue;
    bitmask |= requirement;
  }
  return bitmask;
}
