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
 * they're per-block-instance and short-lived (15min / 5min for settings).
 * The OAuth bit on the publisher's app is the policy ceiling. A scope
 * with `SKIP_OAUTH_CHECK` (e.g. block:settings:*) gates elsewhere — see
 * the issuance-time caller-is-installer check.
 *
 * Forward-extensibility contract:
 *   - New block scopes MUST be added here with their OAuth-bit relationship.
 *   - A scope that intentionally has no bitmask requirement (e.g.
 *     block:settings:*) uses the `SKIP_OAUTH_CHECK` sentinel — NOT a 0
 *     value. The sentinel is explicit so a future maintainer doesn't
 *     accidentally type 0 and get OAuth-allowlist bypass by surprise.
 */

import { TokenScope } from './token-scope.constants';

/**
 * Sentinel value for scopes that intentionally do not require an OAuth-bitmask
 * bit. The validator treats this as "approval gate elsewhere" (e.g. the
 * issuance-time caller-is-installer check for block:settings:*).
 */
export const SKIP_OAUTH_CHECK = Symbol('SKIP_OAUTH_CHECK');
export type ScopeBitmaskRequirement = number | typeof SKIP_OAUTH_CHECK;

export const BLOCK_SCOPE_TO_OAUTH_BIT: Record<string, ScopeBitmaskRequirement> = {
  'models:read:self': TokenScope.ModelsRead,
  'media:read:owned': TokenScope.MediaRead,
  'user:read:self': TokenScope.UserRead,
  'ai:write:budgeted': TokenScope.AIServicesWrite,
  'buzz:read:self': TokenScope.BuzzRead,
  // block:settings:* relies on the issuance-time caller-is-installer gate
  // (audit C8) instead of an OAuth bit. SKIP_OAUTH_CHECK makes that explicit.
  'block:settings:read': SKIP_OAUTH_CHECK,
  'block:settings:write': SKIP_OAUTH_CHECK,
  'social:tip:self': TokenScope.SocialTip,
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
