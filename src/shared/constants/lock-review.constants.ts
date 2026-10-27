/** The AdminAttention reason an owner's request to review a locked model setting is filed under. */
export const LOCK_REVIEW_REPORT_REASON = 'Owner requests review of a locked setting';

/** The report modal form an owner's request opens onto. */
export const LOCK_REVIEW_REPORT_KEY = 'lock-review';

export const LOCK_REVIEW_COOLDOWN_DAYS = 30;

export const requestableLockLabels = {
  nsfw: 'Is intended to produce mature themes',
  sfwOnly: 'Cannot be used for NSFW generation',
  category: 'Category',
  tags: 'Tags',
} as const;

export type RequestableLock = keyof typeof requestableLockLabels;

export const REQUESTABLE_LOCKS = Object.keys(requestableLockLabels) as RequestableLock[];

export const isRequestableLock = (value: unknown): value is RequestableLock =>
  typeof value === 'string' && (REQUESTABLE_LOCKS as string[]).includes(value);

/** While either of these is locked, none of the model's locks can be requested. */
const NON_REQUESTABLE_LOCKS = ['poi', 'minor'];

export type LockReviewModelFlags = {
  lockedProperties?: (string | null)[] | null;
  poi?: boolean | null;
  minor?: boolean | null;
};

/**
 * The model's locked settings an owner may ask a moderator to review, in display order. None while
 * the model is marked as a real person or a minor, whether that mark is locked or the owner's own.
 */
export const requestableLocks = (model?: LockReviewModelFlags | null): RequestableLock[] => {
  const locked = model?.lockedProperties ?? [];
  if (model?.poi || model?.minor) return [];
  if (locked.some((key) => !!key && NON_REQUESTABLE_LOCKS.includes(key))) return [];
  return REQUESTABLE_LOCKS.filter((key) => locked.includes(key));
};

/** What the moderator queue shows as the report's reason: the sub-reason and the settings named. */
export const lockReviewQueueLabel = (locks: string[]) =>
  `${LOCK_REVIEW_REPORT_REASON}: ${locks
    .map((key) => (isRequestableLock(key) ? requestableLockLabels[key] : key))
    .join(', ')}`;

/** An owner's repeat requests keep the reasons from only their most recent asks. */
export const LOCK_REVIEW_MAX_COMMENTS = 3;

/** Between asks in the comment moderators read, so it is not mistaken for a paragraph break. */
export const LOCK_REVIEW_ASK_SEPARATOR = '\n\n---\n\n';
