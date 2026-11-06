/**
 * A yes/no item is a `KnightsQueueItem` whose `audience` is set; its question (`questionKey`) is one per axis, kind `bool`.
 * The ledger row is an ordinary `KnightsVote` under the item's own id, so one vote per player and item holds as for any item.
 */
export const YESNO_KEY_PREFIX = 'knights.yesno.';
export const YESNO_SOURCE = 'yesno-import';

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

/** Seeds an axis question's prompt on import; items and pairs with no question text of their own fall back to it. */
const AXIS_PROMPTS: Record<string, string> = {
  language: 'Does text in this image contain strong profanity?',
  language_level: 'Does text in this image contain strong profanity?',
  profanity: 'Does text in this image contain strong profanity?',
  sexual: 'Does this image contain sexual content?',
  sexual_visual: 'Does this image contain sexual content?',
  sexual_text: 'Does text in this image describe or propose sexual activity?',
  subject_state: 'Does this image show a dead, decaying or reanimated body?',
  violence: 'Does this image show graphic injury, blood or gore?',
};
export const axisPrompt = (axis: string): string =>
  AXIS_PROMPTS[axis] ?? 'Answer the question about this image.';

export const axisKey = (axis: string): string => `${YESNO_KEY_PREFIX}${axis}`;

/** The label-store question a question's answers are recorded under; the producer's own id, so it can join back to its data. */
export const labelQuestionOf = (externalId: string): string => `${YESNO_KEY_PREFIX}${externalId}`;
