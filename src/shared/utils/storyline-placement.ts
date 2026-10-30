import { getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';

/**
 * A continuation is a placement on the `storyline` surface: someone offers a post of theirs as the
 * next chapter after a chapter post of someone's storyline, and the storyline's creator accepts or
 * declines it.
 */

/** What may happen to a storyline's continuations. Never `auto`: see the surface table. */
export type StorylineSpaceMode = 'off' | 'review';

export type StorylineSpace = {
  storylineId: number;
  mode: StorylineSpaceMode;
  /** The price this storyline sets for itself; `null` when it inherits. */
  setPrice: number | null;
  /** What a contributor is charged: the resolved price, ceilinged by the creator's cap. */
  price: number;
  /** The most this creator may charge, from creator score and membership. */
  cap: number;
  /** True when neither mode nor price is set on this storyline itself. */
  inherited: boolean;
};

export type StorylineContinuePrice = {
  /** Whether this chapter accepts a continuation from THIS viewer right now. */
  open: boolean;
  /**
   * Why not, when `open` is false: the storyline is closed to everyone (mode
   * `off`, which is also what Complete sets), or it takes continuations from
   * its collaborators only and this viewer is not one.
   */
  closedReason: 'closed' | 'collaboratorsOnly' | null;
  /** In Buzz. 0 is free. Pass it back as `expectedPrice`. */
  price: number;
};

export type StorylineContinuationStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'expired'
  | 'removed';

/**
 * A continuation's parent chapter is defined two ways, on purpose:
 *
 * - **Present**: not removed (`removedAt` null, and a chapter still holds the post). A continuation
 *   whose parent is not present can never be accepted, so it is refunded
 *   (`settleOrphanedContinuations`) and leaves the owner's queue.
 * - **Answerable**: present, and its storyline is not taken down. Only then may the owner accept or
 *   decline it.
 *
 * A takedown can be lifted (a title appeal, a clean rescan), so the orphan sweep does not refund a
 * continuation in a taken-down storyline: it stays in the queue marked as not answerable until the
 * takedown lifts. Its deadline refunds it, and so does the placer-block cascade, which uses the
 * answerable rule.
 */
export function isAnswerableParentChapter(chapter: {
  removedAt: Date | null;
  storyline: { tosViolation: boolean };
}) {
  return chapter.removedAt == null && !chapter.storyline.tosViolation;
}

type PostSummary = {
  id: number;
  title: string | null;
  coverImage: { id: number; url: string; nsfwLevel: number } | null;
  nsfwLevel: number;
};

/** One row of a storyline creator's review queue. */
export type StorylineContinuationQueueItem = {
  id: number;
  placer: { id: number; username: string | null; image: string | null };
  amount: number;
  createdAt: Date;
  expiresAt: Date | null;
  /** The continuation the placer offered. */
  post: PostSummary;
  /** The chapter it continues. */
  parentPost: PostSummary;
  /**
   * `maxNsfwLevel` is the storyline's rating ceiling, so a row can flag a post rated above it since.
   * `takenDown`: the row is held, not answerable, until the takedown lifts
   * (`isAnswerableParentChapter`).
   */
  storyline: { id: number; title: string; maxNsfwLevel: number; takenDown: boolean };
};

export type MyStorylineContinuation = {
  id: number;
  status: StorylineContinuationStatus;
  amount: number;
  createdAt: Date;
  expiresAt: Date | null;
  /** The post is still scanning or unpublished; it reaches the queue when it is ready. */
  awaitingReadiness: boolean;
  postId: number;
  parentPostId: number;
};

export type StorylineContinuationPage<T> = { items: T[]; nextCursor: string | null };

/**
 * Continuations one contributor may submit an hour, through the submit procedure and through
 * publishing a drafted continuation together: a zero-priced one costs nothing, so this is its
 * spam bound. `rateLimitKey` makes the two procedures one quota.
 */
export const STORYLINE_SUBMIT_RATE_LIMIT = {
  limit: 30,
  period: 3600,
  errorMessage: 'storyline: too many continuations, try again later',
  rateLimitKey: 'storyline:submitContinuation',
} as const;

/**
 * The refusals a submission can meet, so the UI can match them and say them up front. All but
 * `notAvailable` are the message of a 400; `notAvailable` is an authorization error.
 *
 * Match with `startsWith`: `priceChanged` is followed by the new price (`… deciding: now 100
 * Buzz`), so the contributor is told what it is, and `aboveRating` by both ratings.
 *
 * `cannotSubmit` never says which image or why: naming the flag would let anyone probe it.
 */
export const STORYLINE_REFUSALS = {
  notAvailable: 'storylines: this is not available yet',
  notOpen: 'storyline: this creator is not accepting continuations here',
  collaboratorsOnly: 'storyline: only collaborators on this storyline can continue it',
  notAChapter: 'storyline: that post is not a chapter of an open storyline',
  ownStoryline: 'storyline: you cannot submit a continuation to your own storyline',
  notYourPost: 'storyline: you can only submit your own posts',
  alreadySubmitted: 'storyline: that post is already a continuation here',
  alreadyAChapter: 'storyline: that post is already in a storyline',
  cannotSubmit: "This post or one of its images can't be used in a storyline",
  inReview: 'storyline: that post is still being reviewed',
  notReady: 'storyline: that post is not ready yet',
  aboveRating: "This post is rated above this storyline's maximum",
  pendingCap: 'storyline: you already have the maximum continuations waiting with this creator',
  priceChanged: 'storyline: the price changed while you were deciding',
} as const;

export const storylineAboveRatingRefusal = ({
  postLevel,
  maxNsfwLevel,
}: {
  postLevel: number;
  maxNsfwLevel: number;
}) =>
  `${STORYLINE_REFUSALS.aboveRating}. This storyline allows up to ${getBrowsingLevelLabel(
    maxNsfwLevel
  )}; this post is ${getBrowsingLevelLabel(postLevel)}`;
