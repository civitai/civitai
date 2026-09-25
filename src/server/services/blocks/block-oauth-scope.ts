import {
  BLOCK_SCOPE_TO_OAUTH_BIT,
  isKnownBlockScope,
} from '~/shared/constants/block-scope.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export type BlockTokenKind = 'block' | 'oauth';

/** Block-only scopes (apps:storage:*, …) have no OAuth bit and are left to the host. */
export function oauthScopeBitsFor(scopes: string[]): number {
  let bits: number = TokenScope.UserRead;
  for (const scope of scopes) {
    if (!isKnownBlockScope(scope)) continue;
    const requirement = BLOCK_SCOPE_TO_OAUTH_BIT[scope];
    if (typeof requirement === 'number') bits |= requirement;
  }
  return bits;
}

export function manifestWantsOauthToken(manifest: unknown): boolean {
  return (manifest as { auth?: unknown } | null | undefined)?.auth === 'oauth';
}

/**
 * The block scope that maps to `TokenScope.UserRead`, which EVERY OAuth app token
 * carries: `oauthScopeBitsFor` above forces the bit, and so does the hub's
 * `app-token` route. #5127 — because the bit cannot be dropped, the viewer must
 * have consented to this scope before a token exists, and the app must have
 * DECLARED it before a viewer can be asked.
 *
 * Named here, once, because two different checks need the same fact in two
 * spellings: the consent mirror tests the BIT (what the hub compares), this module
 * tests the SCOPE NAME (what a manifest declares). `block-oauth-scope.test.ts`
 * pins `BLOCK_SCOPE_TO_OAUTH_BIT[OAUTH_BASELINE_BLOCK_SCOPE] === TokenScope.UserRead`
 * so the two spellings cannot drift into disagreement.
 */
export const OAUTH_BASELINE_BLOCK_SCOPE = 'user:read:self';

/**
 * Whether an `auth: "oauth"` manifest can mint an OAuth token AT ALL.
 *
 * 🔴 #5127 (F1). A manifest that declares `auth: "oauth"` but NOT
 * `user:read:self` is misdeclared: the token it asks for unavoidably carries
 * `UserRead`, the consent mirror will not claim a bit the viewer never granted,
 * and the hub then refuses — forever, because there is no declared scope for the
 * host to prompt for. Left to run, the refusal is not a quiet degradation but a
 * NON-TERMINATING loop: the fallback reports the viewer's ALREADY-GRANTED
 * consent-gated scopes as `withheld`, the block loses them, the host renders its
 * persistent "missing permissions" banner, and re-consent re-offers the same set.
 *
 * So the caller must not enter the OAuth branch for such a manifest — it gets a
 * clean block JWT with an honest (empty) consent signal instead. A manifest
 * validator rule cannot substitute: it gates SUBMISSION, and the stuck population
 * is manifests that are ALREADY APPROVED.
 *
 * `declaredScopes` must be the manifest's declared set (post approved-snapshot
 * intersection), NOT the viewer's granted subset — the question is what the app
 * asked for, not what this viewer has agreed to.
 */
export function manifestCanMintOauthToken(
  manifest: unknown,
  declaredScopes: Iterable<string>
): boolean {
  if (!manifestWantsOauthToken(manifest)) return false;
  for (const scope of declaredScopes) if (scope === OAUTH_BASELINE_BLOCK_SCOPE) return true;
  return false;
}

export function isConsentRequiredError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'consent_required';
}
