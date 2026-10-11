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
