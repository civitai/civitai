import type {
  UserReview,
  ReceivedReview as ReceivedReviewRow,
  UserBounty,
  UserBountyEntry,
} from '$lib/server/user-account.service';
import type { Jsonified } from '$lib/format';

// The `/api/user-account` payload, declared once. Several panels render slices of it, and each used to
// declare its own copy and issue its own fetch, so every lookup ran the whole endpoint more than once.
//
// The row shapes are DERIVED from the service's, through `Jsonified` for the Date→string boundary.
// Hand-copied duplicates drifted within a day: `nsfw` and `details` were added to the query and stayed
// invisible to the panel. A `import type` is erased at build, so no server code reaches the bundle.

export type Review = Jsonified<UserReview>;

export type ReceivedReview = Jsonified<ReceivedReviewRow>;

export type Bounty = Jsonified<UserBounty>;

export type BountyEntry = Jsonified<UserBountyEntry>;

export type Comment = {
  id: number;
  createdAt: string;
  content: string;
  nsfw: boolean | null;
  tosViolation: boolean | null;
  modelId: number | null;
};

export type CommentV2 = {
  id: number;
  createdAt: string;
  content: string;
  tosViolation: boolean | null;
  threadId: number;
  entityType: string | null;
  entityId: number | null;
};

export type Cosmetic = {
  /** `${cosmeticId}:${claimKey}` — the cosmetic id alone repeats across claims. */
  key: string;
  /** Carried separately rather than re-split from `key`: a shop grant's claimKey is the
   *  buzzTransactionId, which can itself contain a colon. */
  cosmeticId: number;
  claimKey: string;
  name: string;
  type: string;
  equipped: boolean;
  obtainedAt: string | null;
};

export type TrainingRun = {
  modelVersionId: number;
  modelId: number;
  modelName: string | null;
  /** The VERSION's name — "V1" on most runs, which is why the model name is carried beside it. */
  name: string | null;
  baseModel: string | null;
  trainingType: string | null;
  status: string | null;
  numImages: number | null;
  sharedDataset: boolean;
  currentEpoch: number | null;
  maxEpochs: number | null;
  buzzCost: number | null;
  startedAt: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  engine: string | null;
  /** `trainingDetails.params` verbatim. Untyped on purpose — the key set differs per engine, so a
   *  declared shape would be wrong for whichever one ships next. */
  params: Record<string, unknown> | null;
  submitCount: number | null;
  history: { time: string; status: string }[] | null;
};

/** Trainings this account paid for. Larger than the row count whenever a run's model has been reaped. */
export type TrainingCharges = {
  count: number;
  buzz: number;
  first: string | null;
  last: string | null;
  /** Charges no surviving run accounts for — i.e. the runs whose record was deleted. */
  unmatched: { id: string; date: string; buzz: number; workflowId: string | null }[];
  truncated: boolean;
};

export type Notification = {
  id: number;
  type: string;
  category: string;
  createdAt: string;
  read: boolean;
  details: Record<string, unknown>;
};

export type ResourceGeneration = {
  modelVersionId: number;
  modelId: number;
  modelName: string;
  versionName: string | null;
  count: number;
};

export type ShopPurchase = {
  /** The purchase PK, and also the claimKey on the granted cosmetic row. */
  buzzTransactionId: string;
  cosmeticId: number | null;
  title: string;
  unitAmount: number;
  purchasedAt: string;
  refunded: boolean;
};

export type AvailableCosmetic = { id: number; name: string };

export type Capped<T> = { items: T[]; truncated: boolean };

export type Account = {
  reviews: Capped<Review>;
  receivedReviews: Capped<ReceivedReview>;
  comments: Capped<Comment>;
  commentsV2: Capped<CommentV2>;
  cosmetics: Capped<Cosmetic>;
  trainings: { runs: TrainingRun[]; truncated: boolean; charges: TrainingCharges | null };
  bounties: Capped<Bounty>;
  bountyEntries: Capped<BountyEntry>;
  shopPurchases: Capped<ShopPurchase>;
  availableBadges: AvailableCosmetic[];
};

/** `version` is part of the URL so bumping it rebuilds the derived promise — a Buzz send has to move
 *  the balance above the form, and this data does not come from `load`. */
export async function fetchAccount(userId: number, version = 0): Promise<Account> {
  const r = await fetch(`/api/user-account/${userId}?v=${version}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
