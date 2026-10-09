import { constants } from '~/server/common/constants';

/** Accounts no automatic moderation may mute: the system actor and the official brand account. */
export const PROTECTED_USER_IDS = new Set<number>([
  constants.system.user.id,
  constants.system.officialUserId,
]);
