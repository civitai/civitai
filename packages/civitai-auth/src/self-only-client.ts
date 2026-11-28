import { appAssistantClientId, isAppAssistantClientId } from './app-assistant-client';

// SELF-ONLY OAuth clients: rows the platform creates for ONE user's own use, which no other user
// ever consents to. App Assistant's `appassist-<userId>` and a dev tunnel's `appdev-<userId>-<slug>`.
// Every other client a user owns is a third-party app other people may rely on. A ban disables the
// self-only ones automatically and leaves the rest for a moderator, so this predicate is the line
// between the two.

/** The dev tunnel client prefix: `appdev-<userId>-<slug>`. */
export const DEV_TUNNEL_CLIENT_PREFIX = 'appdev-';

/** Whether `clientId` is one of `userId`'s own self-only clients. */
export function isSelfOnlyClientFor(clientId: string, userId: number): boolean {
  return (
    clientId === appAssistantClientId(userId) ||
    clientId.startsWith(`${DEV_TUNNEL_CLIENT_PREFIX}${userId}-`)
  );
}

/**
 * Whether `clientId` has the shape of ANY user's self-only client (owner not checked). Only these
 * ids can carry a ban's mark, so the auth hub uses this to know which mode changes must clear one.
 */
export function isSelfOnlyClientId(clientId: string): boolean {
  return isAppAssistantClientId(clientId) || clientId.startsWith(DEV_TUNNEL_CLIENT_PREFIX);
}
