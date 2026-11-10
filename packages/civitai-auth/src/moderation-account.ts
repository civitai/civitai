// The shared "Civitai Moderation" account. Moderators message users as it server-side, on behalf of a named
// moderator; nobody signs in as it. Every app that mints or accepts a session asks this one question.

export const MODERATION_ACCOUNT_USERNAME = 'CivitaiModeration';

/** The configured account id; null when unset or not a positive integer. */
export function parseModerationAccountId(raw: string | number | null | undefined): number | null {
  const id = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * True for the shared account, by its configured id or by its username. The username holds when an app's
 * copy of the id is missing or malformed, so a configuration slip still refuses it.
 */
export function isModerationAccountUser(
  user: { id: number | string; username?: string | null },
  configuredId: string | number | null | undefined
): boolean {
  const id = parseModerationAccountId(configuredId);
  if (id !== null && Number(user.id) === id) return true;
  return user.username?.toLowerCase() === MODERATION_ACCOUNT_USERNAME.toLowerCase();
}
