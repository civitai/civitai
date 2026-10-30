/**
 * A yes/no item is a `KnightsQueueItem` whose `audience` is set; its question (`questionKey`) is one per axis, kind `bool`.
 * The ledger row is an ordinary `KnightsVote` under the item's own id, so one vote per player and item holds as for any item.
 */
export const YESNO_KEY_PREFIX = 'knights.yesno.';
export const YESNO_SOURCE = 'atif-yesno';

export const YESNO_AUDIENCE = { players: 'players', moderators: 'moderators' } as const;
export const YESNO_ANSWERS = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
] as const;

/** Answers it takes for a question to have a consensus, and the most it is ever asked before it is given up on. */
export const YESNO_CONSENSUS_VOTES = 5;
export const YESNO_MAX_VOTES = 10;

const AXIS = /^[a-z][a-z0-9_]{0,39}$/;
export const isAxis = (value: string): boolean => AXIS.test(value);

export const axisKey = (axis: string): string => `${YESNO_KEY_PREFIX}${axis}`;

/** The label-store question a question's answers are recorded under; the producer's own id, so it can join back to its data. */
export const labelQuestionOf = (externalId: string): string => `${YESNO_KEY_PREFIX}${externalId}`;
