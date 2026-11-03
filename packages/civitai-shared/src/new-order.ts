/** The `nsfwLevelReason` the main app records on an image locked by a Knights consensus; any other reason on a lock is a moderator's. */
export const KNIGHTS_VOTE_NSFW_LEVEL_REASON = 'Knights Vote';

export const KNIGHTS_NSFW_LEVEL_QUESTION = 'knights.image.nsfwLevel';

/** Ranks a queue item can wait at. Acolytes cannot judge and Inquisitors are the end of the path. */
export const KNIGHTS_STAGE_RANKS = ['Knight', 'Templar', 'Paladin'] as const;

export const KNIGHTS_STAGE_TTL_HOURS = 72;

/** Why a Knight blocks an image: the original game's `NewOrderDamnedReason` names and labels, in its order. */
export const KNIGHTS_BLOCK_REASONS = [
  { value: 'InappropriateMinors', label: 'Inappropriate Minors' },
  { value: 'RealisticMinors', label: 'Realistic Minors' },
  { value: 'DepictsRealPerson', label: 'Depicts Real Person' },
  { value: 'Bestiality', label: 'Bestiality' },
  { value: 'Other', label: 'Other' },
] as const;
