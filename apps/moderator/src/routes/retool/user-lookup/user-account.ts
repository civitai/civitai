// The `/api/user-account` payload, declared once. Two panels render slices of it — Subscription takes
// the Buzz balance, UserContent takes the lists — and each previously declared its own copy and issued
// its own fetch, so every lookup ran the whole endpoint twice, including the 744M-row reaction scan.
//
// Declared here rather than imported from `$lib/server/*`: this crosses a JSON boundary, so `Date`
// arrives as `string`, and importing a server module into a component invites it into the client bundle.

export type Review = {
  id: number;
  createdAt: string;
  rating: number | null;
  modelId: number | null;
  tosViolation: boolean | null;
  exclude: boolean | null;
  modelCreator: string | null;
  imageCount: number | null;
};

export type ReceivedReview = {
  id: number;
  createdAt: string;
  rating: number | null;
  exclude: boolean | null;
  details: string | null;
  modelId: number | null;
  modelName: string | null;
  reviewerId: number;
  reviewer: string | null;
};

export type Bounty = {
  id: number;
  name: string;
  createdAt: string;
  expiresAt: string;
  complete: boolean;
  unitAmount: number;
};

export type BountyEntry = {
  id: number;
  bountyId: number;
  bountyName: string;
  createdAt: string;
  description: string | null;
};

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
  name: string;
  type: string;
  equipped: boolean;
  obtainedAt: string | null;
};

export type Reactions = {
  total: number;
  creators: number;
  targets: { userId: number; username: string | null; count: number }[];
};

export type TrainingRun = {
  modelVersionId: number;
  modelId: number;
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
  completedAt: string | null;
};

export type Notification = {
  id: number;
  type: string;
  category: string;
  createdAt: string;
  read: boolean;
};

export type ResourceGeneration = {
  modelVersionId: number;
  modelId: number;
  modelName: string;
  count: number;
};

export type ShopPurchase = {
  /** The purchase PK, and also the claimKey on the granted cosmetic row. */
  buzzTransactionId: string;
  cosmeticId: number;
  title: string;
  unitAmount: number;
  purchasedAt: string;
  refunded: boolean;
};

export type AvailableCosmetic = { id: number; name: string };

export type Account = {
  buzz: {
    balance: number;
    lifetimeBalance: number;
    /** Null when the colour-balance read failed; yellow survives on its own. */
    blue: number | null;
    green: number | null;
  } | null;
  reviews: Review[];
  receivedReviews: ReceivedReview[];
  comments: Comment[];
  commentsV2: CommentV2[];
  cosmetics: Cosmetic[];
  reactions: Reactions;
  trainings: { runs: TrainingRun[]; truncated: boolean };
  bounties: Bounty[];
  bountyEntries: BountyEntry[];
  /** Null when the notifications service is unreachable — distinct from "none sent". */
  notifications: Notification[] | null;
  resourceGenerations: ResourceGeneration[];
  shopPurchases: ShopPurchase[];
  availableBadges: AvailableCosmetic[];
};

export async function fetchAccount(userId: number): Promise<Account> {
  const r = await fetch(`/api/user-account/${userId}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
