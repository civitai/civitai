import { isModerationAccountUser, MODERATION_ACCOUNT_USERNAME } from '@civitai/auth';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { isUsernameBlocked } from '~/server/utils/username-blocklist';

/** The shared "Civitai Moderation" account, or null when the feature is not configured. */
export function getModerationAccountId(): number | null {
  const id = env.CIVITAI_MODERATION_USER_ID;
  return typeof id === 'number' ? id : null;
}

/** Whether a username is the shared account's reserved one, in any casing. */
export function isReservedModerationUsername(username: string): boolean {
  return username.toLowerCase() === MODERATION_ACCOUNT_USERNAME.toLowerCase();
}

/**
 * Whether a username is the reserved one or a lookalike of it (homoglyphs, invisible characters, the
 * ASCII stand-ins for `i`, underscores), by the same fold the username blocklist uses.
 */
export function resemblesReservedModerationUsername(username: string): boolean {
  return isUsernameBlocked(username, { exact: [MODERATION_ACCOUNT_USERNAME], partial: [] });
}

/**
 * Whether a user row is the shared account, for writes that protect it. By the configured id when there
 * is one, so another row that happens to hold the name can still be renamed or deleted.
 */
export function isModerationAccountRow(row: { id: number; username?: string | null }): boolean {
  const id = getModerationAccountId();
  return id !== null ? row.id === id : isModerationAccountUser(row, null);
}

type Who = number | string | { id: number; username?: string | null } | null | undefined;

/**
 * True, with an error-level log, when a credential resolves to the shared moderation account, by its
 * configured id or its username. Nobody signs in as it: messages are sent as it server-side, on behalf of
 * a named moderator.
 */
export function refuseModerationAccountSession(who: Who, source: string): boolean {
  if (who == null) return false;
  const user = typeof who === 'object' ? who : { id: Number(who) };
  if (!isModerationAccountUser(user, env.CIVITAI_MODERATION_USER_ID)) return false;
  logToAxiom(
    { name: 'moderation-account-session-refused', type: 'error', source, userId: user.id },
    'auth'
  ).catch(() => undefined);
  return true;
}
