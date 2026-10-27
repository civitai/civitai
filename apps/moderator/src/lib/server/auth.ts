import { env } from '$env/dynamic/private';
import { createRevocationCheck, createSpokeGuard, type SessionRegistryRedis } from '@civitai/auth';
import { logToAxiom, safeError } from './axiom';
import { getSysRedis } from './redis';

// Same event shape as the main app's logSysRedisFailOpen, so its sysredis-fail-open alerts also see this app.
export const isRevoked = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
  onError: (err) => {
    logToAxiom({
      ...safeError(err),
      name: 'sysredis-fail-open',
      type: 'warning',
      subtype: 'read-degraded',
      fn: 'spoke isRevoked',
    }).catch(() => undefined);
  },
});

/**
 * The shared Civitai Moderation account is a moderator that never signs in: the main app sends as it
 * on a named moderator's behalf.
 */
export function admitsModerator(user: { id: number; isModerator?: boolean }): boolean {
  if (user.isModerator !== true) return false;
  const moderationId = Number(env.CIVITAI_MODERATION_USER_ID);
  if (moderationId > 0 && user.id === moderationId) {
    logToAxiom({
      name: 'moderation-account-session-refused',
      type: 'error',
      source: 'moderator-app',
      userId: user.id,
    }).catch(() => undefined);
    return false;
  }
  return true;
}

export const guard = createSpokeGuard({ require: admitsModerator, isRevoked });
