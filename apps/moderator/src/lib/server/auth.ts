import { env } from '$env/dynamic/private';
import {
  createRevocationCheck,
  createSpokeGuard,
  isModerationAccountUser,
  type SessionRegistryRedis,
} from '@civitai/auth';
import { logToAxiom, safeError } from './axiom';
import { getSysRedis } from './redis';
import { isEnvSwitchOn } from '@civitai/shared/env-switch';

// Same event shape as the main app's logSysRedisFailOpen, so its sysredis-fail-open alerts also see this app.
// `verdict` is what the shared check answered from the markers it had already read (deny_cached|allow_unknown).
export const isRevoked = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
  // SESSION_REVOCATION_CACHE=off|0|false turns off the record of seen revocations (plain fail-open).
  markerCache: isEnvSwitchOn(process.env.SESSION_REVOCATION_CACHE),
  onError: (err, _reason, _claims, verdict) => {
    logToAxiom({
      ...safeError(err),
      name: 'sysredis-fail-open',
      type: 'warning',
      subtype: 'read-degraded',
      fn: 'spoke isRevoked',
      verdict,
    }).catch(() => undefined);
  },
});

/** The shared Civitai Moderation account is a moderator that never signs in. */
export function admitsModerator(user: {
  id: number;
  username?: string | null;
  isModerator?: boolean;
}): boolean {
  if (user.isModerator !== true) return false;
  if (isModerationAccountUser(user, env.CIVITAI_MODERATION_USER_ID)) {
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
