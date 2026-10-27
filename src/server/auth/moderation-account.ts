import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

/** The shared "Civitai Moderation" account, or null when the feature is not configured. */
export function getModerationAccountId(): number | null {
  const id = env.CIVITAI_MODERATION_USER_ID;
  return typeof id === 'number' ? id : null;
}

export function isModerationAccount(userId: number | string | null | undefined): boolean {
  const id = getModerationAccountId();
  return id !== null && userId != null && Number(userId) === id;
}

/**
 * True, with an error-level log, when a credential resolves to the shared moderation account.
 * Nobody signs in as it: messages are sent as it server-side, on behalf of a named moderator.
 */
export function refuseModerationAccountSession(
  userId: number | string | null | undefined,
  source: string
): boolean {
  if (!isModerationAccount(userId)) return false;
  logToAxiom(
    { name: 'moderation-account-session-refused', type: 'error', source, userId: Number(userId) },
    'auth'
  ).catch(() => undefined);
  return true;
}
