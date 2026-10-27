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

/** The model's locked settings an owner may ask a moderator to review, in display order. */
export const requestableLocks = (lockedProperties?: (string | null)[] | null): RequestableLock[] =>
  REQUESTABLE_LOCKS.filter((key) => lockedProperties?.includes(key));

/** What the moderator queue shows as the report's reason: the sub-reason and the settings named. */
export const lockReviewQueueLabel = (locks: string[]) =>
  `${LOCK_REVIEW_REPORT_REASON}: ${locks
    .map((key) => (isRequestableLock(key) ? requestableLockLabels[key] : key))
    .join(', ')}`;

/** An owner's repeat requests keep the reasons from only their most recent asks. */
export const LOCK_REVIEW_MAX_COMMENTS = 3;

/** Between asks in the comment moderators read, so it is not mistaken for a paragraph break. */
export const LOCK_REVIEW_ASK_SEPARATOR = '\n\n---\n\n';
