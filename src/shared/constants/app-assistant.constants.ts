/** The daily Buzz limit App Assistant's consent starts with; the user can change it under connected apps. */
export const APP_ASSISTANT_DAILY_BUZZ_CAP = 5000;

/** `<civitai-chat>` refuses to start without `ai:write:budgeted`; every OAuth token also carries `UserRead`. */
export const APP_ASSISTANT_SCOPES = ['ai:write:budgeted'] as const;

/** What the chat token holds: `APP_ASSISTANT_SCOPES` plus the `UserRead` every OAuth token carries. */
const CHAT_TOKEN_SCOPES: ReadonlySet<string> = new Set([...APP_ASSISTANT_SCOPES, 'user:read:self']);

/**
 * The chat's grant check. Nothing can widen this page's token mid-session, so a scope it does not
 * already hold is refused and the chat shows its own "needs permission" message.
 */
export function appAssistantHoldsScopes(scopes: readonly string[]): boolean {
  return scopes.every((scope) => CHAT_TOKEN_SCOPES.has(scope));
}

/**
 * Who a STAFF PLATFORM UPDATE is from, wherever its app's owner (or collaborator) reads it: the
 * `app-platform-update*` notifications and their emails, the update's owner-facing record (CLI,
 * App Assistant), the owner's submission lists, the submit refusal while a staff submission is
 * pending, and the update commit's `Platform-Update-By` trailer. Never the staff member's own
 * username (operator decision): that stays on the server record (`app_platform_updates.staffUserId`,
 * `fileSummary.onBehalf`) and in moderator views only.
 */
export const APP_PLATFORM_UPDATE_SENDER = 'CivitaiOfficial (App Assistant)';
