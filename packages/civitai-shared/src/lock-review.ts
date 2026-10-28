// Shared because the main app files the Appeal row and the moderator app rules on it.

/** `Appeal.context.kind` on a lock review; any other in-app model appeal is against a flag. */
export const LOCK_REVIEW_KIND = 'lock-review';
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

/** Stored on `Appeal.context`: the locked settings the owner asked about. */
export type LockReviewContext = { kind: typeof LOCK_REVIEW_KIND; locks: RequestableLock[] };

export const lockReviewContext = (locks: RequestableLock[]): LockReviewContext => ({
  kind: LOCK_REVIEW_KIND,
  locks: REQUESTABLE_LOCKS.filter((key) => locks.includes(key)),
});

/** The lock review an appeal's `context` describes, or null when it is a flag appeal. */
export function parseLockReviewContext(context: unknown): LockReviewContext | null {
  const value = context as { kind?: unknown; locks?: unknown } | null | undefined;
  if (value?.kind !== LOCK_REVIEW_KIND || !Array.isArray(value.locks)) return null;
  return lockReviewContext(value.locks.filter(isRequestableLock));
}

/** While either of these is locked, none of the model's locks can be requested. */
const NON_REQUESTABLE_LOCKS = ['poi', 'minor'];

export type LockReviewModelFlags = {
  lockedProperties?: (string | null)[] | null;
  poi?: boolean | null;
  minor?: boolean | null;
};

/**
 * The model's locked settings an owner may ask a moderator to review, in display order. None while
 * the model is marked as a real person or a minor, whether that mark is locked or the owner's own:
 * those go through the flag appeal instead.
 */
export const requestableLocks = (model?: LockReviewModelFlags | null): RequestableLock[] => {
  const locked = model?.lockedProperties ?? [];
  if (model?.poi || model?.minor) return [];
  if (locked.some((key) => !!key && NON_REQUESTABLE_LOCKS.includes(key))) return [];
  return REQUESTABLE_LOCKS.filter((key) => locked.includes(key));
};

export const locksToLift = (named: readonly string[], locked: readonly (string | null)[]) =>
  REQUESTABLE_LOCKS.filter((key) => named.includes(key) && locked.includes(key));
