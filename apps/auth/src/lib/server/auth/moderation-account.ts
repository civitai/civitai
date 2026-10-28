import { env } from '$env/dynamic/private';
import { isModerationAccountUser } from '@civitai/auth';
import { logToAxiom } from '../axiom';

/**
 * True, with an error-level log, for the shared Civitai Moderation account, which never holds a session
 * or credential: moderators send as it from the main app, on behalf of a named moderator.
 */
export function isRefusedModerationAccount(
  user: { id: number; username?: string | null },
  source: string
): boolean {
  if (!isModerationAccountUser(user, env.CIVITAI_MODERATION_USER_ID)) return false;
  logToAxiom({
    name: 'moderation-account-session-refused',
    type: 'error',
    source: `auth-hub:${source}`,
    userId: user.id,
  }).catch(() => undefined);
  return true;
}
