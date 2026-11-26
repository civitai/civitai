import { mintAppToken } from '@civitai/auth';
import { appAssistantClientId } from '@civitai/auth/app-assistant-client';
import { dbWrite } from '~/server/db/client';
import { oauthScopeBitsFor } from '~/server/services/blocks/block-oauth-scope';
import { APP_ASSISTANT_SCOPES } from '~/shared/constants/app-assistant.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * App Assistant's per-user OAuth client, its token mint and its consent read: a LEAF module (no
 * service graph behind it), re-exported by `app-assistant.service`. Kept apart so a caller that only
 * mints, such as the submission trace reading a submitter's chats, does not pull that service and
 * everything it reaches into its import graph (and into the import cycles it sits in).
 */

/**
 * One OAuth client per user rather than one shared row: an `OauthClient` belongs to the user in its
 * `userId`, who may delete it through the OAuth-apps settings (which turns App Assistant off), so a
 * shared row would be one user's to break for everyone. The id rule lives in
 * `@civitai/auth/app-assistant-client`, shared with the hub.
 */
export { APP_ASSISTANT_CLIENT_PREFIX } from '@civitai/auth/app-assistant-client';
export { appAssistantClientId };

/**
 * Who a token is for. The chat spends Buzz; the hosted sandbox service only needs to know who the
 * user is, so it gets `UserRead` alone.
 */
export type AppAssistantTokenPurpose = 'chat' | 'sandbox';

/** The OAuth scope bits a token for `purpose` carries. */
export function appAssistantTokenScope(purpose: AppAssistantTokenPurpose): bigint {
  return purpose === 'chat' ? oauthScopeBitsFor([...APP_ASSISTANT_SCOPES]) : TokenScope.UserRead;
}

export interface AppAssistantToken {
  token: string;
  expiresAt: string;
}

/**
 * Mints an access token for `purpose` against the consent `enableAppAssistant` wrote, or returns
 * `null` when there is none covering the scopes (never turned on, or revoked since).
 */
export async function mintAppAssistantToken(
  userId: number,
  purpose: AppAssistantTokenPurpose,
  impersonatedBy: number | null
): Promise<AppAssistantToken | null> {
  if (!(await hasAppAssistantConsent(userId, purpose))) return null;
  const minted = await mintAppToken({
    userId,
    clientId: appAssistantClientId(userId),
    scope: appAssistantTokenScope(purpose),
    impersonatedBy,
  });
  return { token: minted.accessToken, expiresAt: minted.expiresAt };
}

/**
 * Whether the user's App Assistant consent covers `purpose`'s scopes: written by
 * `enableAppAssistant`, gone once the user revokes it under connected apps.
 */
export async function hasAppAssistantConsent(
  userId: number,
  purpose: AppAssistantTokenPurpose = 'chat'
): Promise<boolean> {
  const scope = appAssistantTokenScope(purpose);
  // primary: a consent the user just revoked must stop the next mint, not one replica lag later.
  const consent = await dbWrite.oauthConsent.findUnique({
    where: { userId_clientId: { userId, clientId: appAssistantClientId(userId) } },
    select: { scope: true },
  });
  return !!consent && (consent.scope & scope) === scope;
}
