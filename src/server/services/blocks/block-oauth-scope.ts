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

// MOVED to `~/shared/constants/block-scope.constants` and re-exported here so this
// module's existing importers and its own test are untouched. It had to leave a
// `~/server/**` path because `block-manifest-validator.service.ts` — which is imported by
// `ManifestEditForm.tsx`, i.e. bundled for the CLIENT — now reads it to refuse
// `auth: "oauth"` alongside an `apps:storage:*` scope. See the docblock at the definition.
export { manifestWantsOauthToken } from '~/shared/constants/block-scope.constants';

export function isConsentRequiredError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'consent_required';
}
