import { PROTECTED_USER_IDS } from '~/server/utils/protected-user-ids';

export const SCAM_AUTO_MUTE_MAX_ACCOUNT_AGE_DAYS = 7;

// `+ 1`: an account stays eligible until it is MAX + 1 whole days old.
export function scamAccountAgeCutoff(now = new Date()) {
  return new Date(now.getTime() - (SCAM_AUTO_MUTE_MAX_ACCOUNT_AGE_DAYS + 1) * 86_400_000);
}

export type ScamMuteCandidate = {
  id: number;
  createdAt: Date;
  isModerator: boolean | null;
  deletedAt: Date | null;
  bannedAt: Date | null;
};

export type ScamMuteIneligibility = 'protected' | 'moderator' | 'deleted' | 'banned' | 'too-old';

/** Why a scam verdict about this account may not act on it, or `null` when it may. */
export function scamMuteIneligibility(
  user: ScamMuteCandidate,
  { ignoreAccountAge = false, now = new Date() }: { ignoreAccountAge?: boolean; now?: Date } = {}
): ScamMuteIneligibility | null {
  if (PROTECTED_USER_IDS.has(user.id)) return 'protected';
  if (user.isModerator) return 'moderator';
  if (user.deletedAt) return 'deleted';
  if (user.bannedAt) return 'banned';
  if (!ignoreAccountAge && user.createdAt <= scamAccountAgeCutoff(now)) return 'too-old';
  return null;
}
