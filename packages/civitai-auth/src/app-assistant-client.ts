// App Assistant's per-user OAuth client: one row per user, id `appassist-<userId>`, created and kept
// in shape only by the main app's `enableAppAssistant`. Every place that treats this id specially uses
// these functions, never re-spells the prefix.
//
// Not `firstparty-`: the hub reserves that prefix for its own trusted clients.
export const APP_ASSISTANT_CLIENT_PREFIX = 'appassist-';

export function appAssistantClientId(userId: number): string {
  return `${APP_ASSISTANT_CLIENT_PREFIX}${userId}`;
}

/** Whether `clientId` names an App Assistant client (anyone's). */
export function isAppAssistantClientId(clientId: string): boolean {
  return clientId.startsWith(APP_ASSISTANT_CLIENT_PREFIX);
}

/**
 * Whether `clientId` may act for `userId` as far as the App Assistant rule goes: any client that is
 * not an App Assistant client passes (other rules decide it), and an App Assistant client passes
 * only for the user its id names.
 */
export function isAppAssistantClientAllowedFor(clientId: string, userId: number): boolean {
  return !isAppAssistantClientId(clientId) || clientId === appAssistantClientId(userId);
}
