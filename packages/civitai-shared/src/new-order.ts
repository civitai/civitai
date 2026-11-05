/** The `nsfwLevelReason` the main app records on an image locked by a Knights consensus; any other reason on a lock is a moderator's. */
export const KNIGHTS_VOTE_NSFW_LEVEL_REASON = 'Knights Vote';

export const KNIGHTS_NSFW_LEVEL_QUESTION = 'knights.image.nsfwLevel';

/** Why an item went to the Inquisitors. Write-back handovers have none; they use `reason`. */
export const KNIGHTS_ESCALATION_REASONS = ['blocked', 'pushed-down', 'no-consensus'] as const;
export type KnightsEscalationReason = (typeof KNIGHTS_ESCALATION_REASONS)[number];

/** Why a settled rating could not be written to the image and went to the Inquisitors instead (`reason`). */
export const KNIGHTS_WRITEBACK_REASONS = [
  'blocked',
  'level-moved',
  'moderator-locked',
  'attempts-exhausted',
] as const;
export type KnightsWritebackReason = (typeof KNIGHTS_WRITEBACK_REASONS)[number];

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
