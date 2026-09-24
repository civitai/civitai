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

export function isConsentRequiredError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'consent_required';
}
