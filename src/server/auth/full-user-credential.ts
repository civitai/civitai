import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

export type BearerCredential = {
  apiKeyType?: ApiKeyType | null;
  subject?: { type: 'apiKey' | 'oauth'; id: number | string } | null;
  tokenScope?: number | null;
};

/**
 * The one bearer credential accepted where a full user credential is required: a full-scope
 * personal (`User`) key not issued to an OAuth client.
 *
 * Callers decide first whether a bearer credential was presented at all; a browser session has
 * none and is allowed without calling this.
 */
export function isFullScopeUserKey(credential: BearerCredential | null | undefined): boolean {
  return (
    credential?.apiKeyType === ApiKeyType.User &&
    credential.subject?.type === 'apiKey' &&
    credential.tokenScope === TokenScope.Full
  );
}

/**
 * A personal (`User`) API key not issued to an OAuth client that carries `scope`. For the procedures
 * that take a narrow opt-in key in place of a full one; the caller decides who may hold it.
 */
export function isUserKeyWithScope(
  credential: BearerCredential | null | undefined,
  scope: number
): boolean {
  return (
    scope !== 0 &&
    credential?.apiKeyType === ApiKeyType.User &&
    credential.subject?.type === 'apiKey' &&
    credential.tokenScope != null &&
    (credential.tokenScope & scope) === scope
  );
}
