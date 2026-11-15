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

/** A lock review of an nsfw lock the listing intent check added when the owner tried to add a
 *  civitai.com version: a job re-judges it before a moderator sees it. */
export const COM_FACE_INTENT_DISPUTE = 'comFaceIntent';

/** Stored on `Appeal.context`: the locked settings the owner asked about. */
export type LockReviewContext = {
  kind: typeof LOCK_REVIEW_KIND;
  locks: RequestableLock[];
  dispute?: typeof COM_FACE_INTENT_DISPUTE;
};

export const lockReviewContext = (
  locks: RequestableLock[],
  dispute?: LockReviewContext['dispute']
): LockReviewContext => ({
  kind: LOCK_REVIEW_KIND,
  locks: REQUESTABLE_LOCKS.filter((key) => locks.includes(key)),
  ...(dispute && { dispute }),
});

/** The lock review an appeal's `context` describes, or null when it is a flag appeal. */
export function parseLockReviewContext(context: unknown): LockReviewContext | null {
  const value = context as
    | { kind?: unknown; locks?: unknown; dispute?: unknown }
    | null
    | undefined;
  if (value?.kind !== LOCK_REVIEW_KIND || !Array.isArray(value.locks)) return null;
  return lockReviewContext(
    value.locks.filter(isRequestableLock),
    value.dispute === COM_FACE_INTENT_DISPUTE ? COM_FACE_INTENT_DISPUTE : undefined
  );
}

export type LockReviewModelFlags = {
  lockedProperties?: (string | null)[] | null;
  poi?: boolean | null;
  minor?: boolean | null;
};

/**
 * The model's locked settings an owner may ask a moderator to review, in display order. None while
 * the model is marked as a real person or a minor, whether that mark is locked or the owner's own:
 * those go through the flag appeal instead. A locked `poi` or `minor` that is off blocks nothing.
 */
export const requestableLocks = (model?: LockReviewModelFlags | null): RequestableLock[] => {
  const locked = model?.lockedProperties ?? [];
  if (model?.poi || model?.minor) return [];
  return REQUESTABLE_LOCKS.filter((key) => locked.includes(key));
};

export const locksToLift = (named: readonly string[], locked: readonly (string | null)[]) =>
  REQUESTABLE_LOCKS.filter((key) => named.includes(key) && locked.includes(key));

/** What the owner is told of a ruling, in app and by email. Neutral, with no reason: a moderator's
 *  reason or note is never shown, and every rejection reads the same. */
export function lockReviewRulingMessage(approved: boolean, unlocked: readonly unknown[] = []) {
  if (!approved)
    return 'Your request to review the locked settings on your model was declined, so those settings stay locked.';
  const labels = REQUESTABLE_LOCKS.filter((key) => unlocked.includes(key)).map(
    (key) => requestableLockLabels[key]
  );
  const base = 'Your request to review the locked settings on your model was approved.';
  return labels.length ? `${base} You can now change: ${labels.join(', ')}.` : base;
}
