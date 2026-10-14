/**
 * The shapes the storyline continuation API returns, shared by the server and
 * the UI so both build against one definition.
 *
 * A continuation is a placement on the `storyline` surface: someone offers a
 * post of theirs as the next chapter after a chapter post of someone's
 * storyline, and the storyline's creator accepts or declines it.
 */

/** What may happen to a storyline's continuations. Never `auto`: see the surface table. */
export type StorylineSpaceMode = 'off' | 'review';

/** A storyline's continuation settings, as its creator edits them. */
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

/** What a contributor sees before submitting. */
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
  /** `maxNsfwLevel` is the storyline's rating ceiling, so a row can flag a post rated above it since. */
  storyline: { id: number; title: string; maxNsfwLevel: number };
};

/** One of the placer's own continuations, for their sent list. */
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
 * The refusals a submission can meet, so the UI can match them and say them up
 * front. Each is the message of a 400; the `storyline:` prefix is how every
 * storyline placement refusal reads.
 */
export const STORYLINE_REFUSALS = {
  notAvailable: 'storylines: this is not available yet',
  notOpen: 'storyline: this creator is not accepting continuations here',
  collaboratorsOnly: 'storyline: only collaborators on this storyline can continue it',
  notAChapter: 'storyline: that post is not a chapter of an open storyline',
  ownStoryline: 'storyline: you cannot submit a continuation to your own storyline',
  notYourPost: 'storyline: you can only submit your own posts',
  alreadySubmitted: 'storyline: that post is already a continuation here',
  aboveRating: 'storyline: that post is rated above what this storyline allows',
  pendingCap: 'storyline: you already have the maximum continuations waiting with this creator',
  priceChanged: 'storyline: the price changed while you were deciding',
} as const;
