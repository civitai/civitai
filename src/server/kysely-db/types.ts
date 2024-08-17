import type { ColumnType } from 'kysely';
export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

import type {
  StripeConnectStatus,
  BuzzWithdrawalRequestStatus,
  RewardsEligibility,
  UserEngagementType,
  LinkType,
  ModelType,
  ImportStatus,
  ModelStatus,
  TrainingStatus,
  CommercialUse,
  CheckpointType,
  ModelUploadType,
  ModelModifier,
  ContentType,
  ModelEngagementType,
  ModelVersionSponsorshipSettingsType,
  ModelVersionMonetizationType,
  ModelVersionEngagementType,
  ModelHashType,
  ScanResultCode,
  ModelFileVisibility,
  MetricTimeframe,
  AssociationType,
  ReportReason,
  ReportStatus,
  ReviewReactions,
  ImageGenerationProcess,
  NsfwLevel,
  ImageIngestionStatus,
  MediaType,
  BlockImageReason,
  ImageEngagementType,
  ImageOnModelType,
  TagTarget,
  TagType,
  TagsOnTagsType,
  TagSource,
  PartnerPricingModel,
  ApiKeyType,
  KeyScope,
  TagEngagementType,
  CosmeticType,
  CosmeticSource,
  CosmeticEntity,
  ArticleEngagementType,
  GenerationSchedulers,
  CollectionWriteConfiguration,
  CollectionReadConfiguration,
  CollectionType,
  CollectionMode,
  CollectionItemStatus,
  CollectionContributorPermission,
  HomeBlockType,
  Currency,
  BountyType,
  BountyMode,
  BountyEntryMode,
  BountyEngagementType,
  CsamReportType,
  Availability,
  EntityCollaboratorStatus,
  ClubAdminPermission,
  ChatMemberStatus,
  ChatMessageType,
  PurchasableRewardUsage,
  EntityType,
  JobQueueType,
  VaultItemStatus,
  RedeemableCodeType,
  ToolType,
  TechniqueType,
  EntityMetric_EntityType_Type,
  EntityMetric_MetricType_Type,
} from './enums';

export type Account = {
  id: Generated<number>;
  userId: number;
  type: string;
  provider: string;
  providerAccountId: string;
  refresh_token: string | null;
  access_token: string | null;
  expires_at: number | null;
  token_type: string | null;
  scope: string | null;
  id_token: string | null;
  session_state: string | null;
  metadata: Generated<unknown>;
};
export type Announcement = {
  id: Generated<number>;
  title: string;
  content: string;
  emoji: string | null;
  color: Generated<string>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  startsAt: Timestamp | null;
  endsAt: Timestamp | null;
  metadata: unknown | null;
};
export type Answer = {
  id: Generated<number>;
  questionId: number;
  userId: number;
  content: string;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type AnswerMetric = {
  answerId: number;
  timeframe: MetricTimeframe;
  checkCount: number;
  crossCount: number;
  heartCount: number;
  commentCount: number;
};
export type AnswerRank = {
  answerId: number;
  checkCountDay: number;
  checkCountWeek: number;
  checkCountMonth: number;
  checkCountYear: number;
  checkCountAllTime: number;
  crossCountDay: number;
  crossCountWeek: number;
  crossCountMonth: number;
  crossCountYear: number;
  crossCountAllTime: number;
  heartCountDay: number;
  heartCountWeek: number;
  heartCountMonth: number;
  heartCountYear: number;
  heartCountAllTime: number;
  commentCountDay: number;
  commentCountWeek: number;
  commentCountMonth: number;
  commentCountYear: number;
  commentCountAllTime: number;
  checkCountDayRank: number;
  checkCountWeekRank: number;
  checkCountMonthRank: number;
  checkCountYearRank: number;
  checkCountAllTimeRank: number;
  crossCountDayRank: number;
  crossCountWeekRank: number;
  crossCountMonthRank: number;
  crossCountYearRank: number;
  crossCountAllTimeRank: number;
  heartCountDayRank: number;
  heartCountWeekRank: number;
  heartCountMonthRank: number;
  heartCountYearRank: number;
  heartCountAllTimeRank: number;
  commentCountDayRank: number;
  commentCountWeekRank: number;
  commentCountMonthRank: number;
  commentCountYearRank: number;
  commentCountAllTimeRank: number;
};
export type AnswerReaction = {
  id: Generated<number>;
  answerId: number;
  userId: number;
  reaction: ReviewReactions;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type AnswerVote = {
  answerId: number;
  userId: number;
  vote: boolean | null;
  createdAt: Generated<Timestamp>;
};
export type ApiKey = {
  id: Generated<number>;
  key: string;
  name: string;
  scope: KeyScope[];
  userId: number;
  createdAt: Generated<Timestamp>;
  type: Generated<ApiKeyType>;
  expiresAt: Timestamp | null;
};
export type Article = {
  id: Generated<number>;
  createdAt: Generated<Timestamp | null>;
  updatedAt: Timestamp | null;
  nsfw: Generated<boolean>;
  tosViolation: Generated<boolean>;
  metadata: unknown | null;
  title: string;
  content: string;
  cover: string | null;
  coverId: number | null;
  publishedAt: Timestamp | null;
  userId: number;
  availability: Generated<Availability>;
  unlisted: Generated<boolean>;
  nsfwLevel: Generated<number>;
  userNsfwLevel: Generated<number>;
  lockedProperties: Generated<string[]>;
};
export type ArticleEngagement = {
  userId: number;
  articleId: number;
  type: ArticleEngagementType;
  createdAt: Generated<Timestamp>;
};
export type ArticleMetric = {
  articleId: number;
  timeframe: MetricTimeframe;
  likeCount: Generated<number>;
  dislikeCount: Generated<number>;
  laughCount: Generated<number>;
  cryCount: Generated<number>;
  heartCount: Generated<number>;
  commentCount: Generated<number>;
  viewCount: Generated<number>;
  favoriteCount: Generated<number>;
  hideCount: Generated<number>;
  collectedCount: Generated<number>;
  tippedCount: Generated<number>;
  tippedAmountCount: Generated<number>;
  updatedAt: Generated<Timestamp>;
};
export type ArticleRank = {
  articleId: number;
  cryCountDayRank: Generated<number>;
  cryCountWeekRank: Generated<number>;
  cryCountMonthRank: Generated<number>;
  cryCountYearRank: Generated<number>;
  cryCountAllTimeRank: Generated<number>;
  dislikeCountDayRank: Generated<number>;
  dislikeCountWeekRank: Generated<number>;
  dislikeCountMonthRank: Generated<number>;
  dislikeCountYearRank: Generated<number>;
  dislikeCountAllTimeRank: Generated<number>;
  heartCountDayRank: Generated<number>;
  heartCountWeekRank: Generated<number>;
  heartCountMonthRank: Generated<number>;
  heartCountYearRank: Generated<number>;
  heartCountAllTimeRank: Generated<number>;
  laughCountDayRank: Generated<number>;
  laughCountWeekRank: Generated<number>;
  laughCountMonthRank: Generated<number>;
  laughCountYearRank: Generated<number>;
  laughCountAllTimeRank: Generated<number>;
  likeCountDayRank: Generated<number>;
  likeCountWeekRank: Generated<number>;
  likeCountMonthRank: Generated<number>;
  likeCountYearRank: Generated<number>;
  likeCountAllTimeRank: Generated<number>;
  commentCountDayRank: Generated<number>;
  commentCountWeekRank: Generated<number>;
  commentCountMonthRank: Generated<number>;
  commentCountYearRank: Generated<number>;
  commentCountAllTimeRank: Generated<number>;
  reactionCountDayRank: Generated<number>;
  reactionCountWeekRank: Generated<number>;
  reactionCountMonthRank: Generated<number>;
  reactionCountYearRank: Generated<number>;
  reactionCountAllTimeRank: Generated<number>;
  viewCountDayRank: Generated<number>;
  viewCountWeekRank: Generated<number>;
  viewCountMonthRank: Generated<number>;
  viewCountYearRank: Generated<number>;
  viewCountAllTimeRank: Generated<number>;
  favoriteCountDayRank: Generated<number>;
  favoriteCountWeekRank: Generated<number>;
  favoriteCountMonthRank: Generated<number>;
  favoriteCountYearRank: Generated<number>;
  favoriteCountAllTimeRank: Generated<number>;
  hideCountDayRank: Generated<number>;
  hideCountWeekRank: Generated<number>;
  hideCountMonthRank: Generated<number>;
  hideCountYearRank: Generated<number>;
  hideCountAllTimeRank: Generated<number>;
  collectedCountDayRank: Generated<number>;
  collectedCountWeekRank: Generated<number>;
  collectedCountMonthRank: Generated<number>;
  collectedCountYearRank: Generated<number>;
  collectedCountAllTimeRank: Generated<number>;
  tippedCountDayRank: Generated<number>;
  tippedCountWeekRank: Generated<number>;
  tippedCountMonthRank: Generated<number>;
  tippedCountYearRank: Generated<number>;
  tippedCountAllTimeRank: Generated<number>;
  tippedAmountCountDayRank: Generated<number>;
  tippedAmountCountWeekRank: Generated<number>;
  tippedAmountCountMonthRank: Generated<number>;
  tippedAmountCountYearRank: Generated<number>;
  tippedAmountCountAllTimeRank: Generated<number>;
};
export type ArticleReaction = {
  id: Generated<number>;
  articleId: number;
  userId: number;
  reaction: ReviewReactions;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type ArticleReport = {
  articleId: number;
  reportId: number;
};
export type ArticleStat = {
  articleId: number;
  cryCountDay: Generated<number>;
  cryCountWeek: Generated<number>;
  cryCountMonth: Generated<number>;
  cryCountYear: Generated<number>;
  cryCountAllTime: Generated<number>;
  dislikeCountDay: Generated<number>;
  dislikeCountWeek: Generated<number>;
  dislikeCountMonth: Generated<number>;
  dislikeCountYear: Generated<number>;
  dislikeCountAllTime: Generated<number>;
  heartCountDay: Generated<number>;
  heartCountWeek: Generated<number>;
  heartCountMonth: Generated<number>;
  heartCountYear: Generated<number>;
  heartCountAllTime: Generated<number>;
  laughCountDay: Generated<number>;
  laughCountWeek: Generated<number>;
  laughCountMonth: Generated<number>;
  laughCountYear: Generated<number>;
  laughCountAllTime: Generated<number>;
  likeCountDay: Generated<number>;
  likeCountWeek: Generated<number>;
  likeCountMonth: Generated<number>;
  likeCountYear: Generated<number>;
  likeCountAllTime: Generated<number>;
  commentCountDay: Generated<number>;
  commentCountWeek: Generated<number>;
  commentCountMonth: Generated<number>;
  commentCountYear: Generated<number>;
  commentCountAllTime: Generated<number>;
  reactionCountDay: Generated<number>;
  reactionCountWeek: Generated<number>;
  reactionCountMonth: Generated<number>;
  reactionCountYear: Generated<number>;
  reactionCountAllTime: Generated<number>;
  viewCountDay: Generated<number>;
  viewCountWeek: Generated<number>;
  viewCountMonth: Generated<number>;
  viewCountYear: Generated<number>;
  viewCountAllTime: Generated<number>;
  favoriteCountDay: Generated<number>;
  favoriteCountWeek: Generated<number>;
  favoriteCountMonth: Generated<number>;
  favoriteCountYear: Generated<number>;
  favoriteCountAllTime: Generated<number>;
  collectedCountDay: Generated<number>;
  collectedCountWeek: Generated<number>;
  collectedCountMonth: Generated<number>;
  collectedCountYear: Generated<number>;
  collectedCountAllTime: Generated<number>;
  hideCountDay: Generated<number>;
  hideCountWeek: Generated<number>;
  hideCountMonth: Generated<number>;
  hideCountYear: Generated<number>;
  hideCountAllTime: Generated<number>;
  tippedCountDay: Generated<number>;
  tippedCountWeek: Generated<number>;
  tippedCountMonth: Generated<number>;
  tippedCountYear: Generated<number>;
  tippedCountAllTime: Generated<number>;
  tippedAmountCountDay: Generated<number>;
  tippedAmountCountWeek: Generated<number>;
  tippedAmountCountMonth: Generated<number>;
  tippedAmountCountYear: Generated<number>;
  tippedAmountCountAllTime: Generated<number>;
};
export type BlockedImage = {
  hash: string;
  reason: Generated<BlockImageReason>;
  createdAt: Generated<Timestamp>;
};
export type Bounty = {
  id: Generated<number>;
  userId: number | null;
  name: string;
  description: string;
  startsAt: Timestamp;
  expiresAt: Timestamp;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  details: unknown | null;
  mode: Generated<BountyMode>;
  entryMode: Generated<BountyEntryMode>;
  type: BountyType;
  minBenefactorUnitAmount: number;
  maxBenefactorUnitAmount: number | null;
  entryLimit: Generated<number>;
  nsfw: Generated<boolean>;
  poi: Generated<boolean>;
  complete: Generated<boolean>;
  refunded: Generated<boolean>;
  availability: Generated<Availability>;
  nsfwLevel: Generated<number>;
  lockedProperties: Generated<string[]>;
};
export type BountyBenefactor = {
  userId: number;
  bountyId: number;
  unitAmount: number;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  awardedAt: Timestamp | null;
  awardedToId: number | null;
  currency: Generated<Currency>;
};
export type BountyEngagement = {
  userId: number;
  bountyId: number;
  type: BountyEngagementType;
  createdAt: Generated<Timestamp>;
};
export type BountyEntry = {
  id: Generated<number>;
  userId: number | null;
  bountyId: number;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  locked: Generated<boolean>;
  description: string | null;
  nsfwLevel: Generated<number>;
};
export type BountyEntryMetric = {
  bountyEntryId: number;
  timeframe: MetricTimeframe;
  likeCount: Generated<number>;
  dislikeCount: Generated<number>;
  laughCount: Generated<number>;
  cryCount: Generated<number>;
  heartCount: Generated<number>;
  unitAmountCount: Generated<number>;
  tippedCount: Generated<number>;
  tippedAmountCount: Generated<number>;
  updatedAt: Generated<Timestamp>;
};
export type BountyEntryRank = {
  bountyEntryId: number;
  cryCountDayRank: Generated<number>;
  cryCountWeekRank: Generated<number>;
  cryCountMonthRank: Generated<number>;
  cryCountYearRank: Generated<number>;
  cryCountAllTimeRank: Generated<number>;
  dislikeCountDayRank: Generated<number>;
  dislikeCountWeekRank: Generated<number>;
  dislikeCountMonthRank: Generated<number>;
  dislikeCountYearRank: Generated<number>;
  dislikeCountAllTimeRank: Generated<number>;
  heartCountDayRank: Generated<number>;
  heartCountWeekRank: Generated<number>;
  heartCountMonthRank: Generated<number>;
  heartCountYearRank: Generated<number>;
  heartCountAllTimeRank: Generated<number>;
  laughCountDayRank: Generated<number>;
  laughCountWeekRank: Generated<number>;
  laughCountMonthRank: Generated<number>;
  laughCountYearRank: Generated<number>;
  laughCountAllTimeRank: Generated<number>;
  likeCountDayRank: Generated<number>;
  likeCountWeekRank: Generated<number>;
  likeCountMonthRank: Generated<number>;
  likeCountYearRank: Generated<number>;
  likeCountAllTimeRank: Generated<number>;
  reactionCountDayRank: Generated<number>;
  reactionCountWeekRank: Generated<number>;
  reactionCountMonthRank: Generated<number>;
  reactionCountYearRank: Generated<number>;
  reactionCountAllTimeRank: Generated<number>;
  unitAmountCountDayRank: Generated<number>;
  unitAmountCountWeekRank: Generated<number>;
  unitAmountCountMonthRank: Generated<number>;
  unitAmountCountYearRank: Generated<number>;
  unitAmountCountAllTimeRank: Generated<number>;
  tippedCountDayRank: Generated<number>;
  tippedCountWeekRank: Generated<number>;
  tippedCountMonthRank: Generated<number>;
  tippedCountYearRank: Generated<number>;
  tippedCountAllTimeRank: Generated<number>;
  tippedAmountCountDayRank: Generated<number>;
  tippedAmountCountWeekRank: Generated<number>;
  tippedAmountCountMonthRank: Generated<number>;
  tippedAmountCountYearRank: Generated<number>;
  tippedAmountCountAllTimeRank: Generated<number>;
};
export type BountyEntryReaction = {
  bountyEntryId: number;
  userId: number;
  reaction: ReviewReactions;
  createdAt: Generated<Timestamp>;
};
export type BountyEntryReport = {
  bountyEntryId: number;
  reportId: number;
};
export type BountyEntryStat = {
  bountyEntryId: number;
  cryCountDay: number;
  cryCountWeek: number;
  cryCountMonth: number;
  cryCountYear: number;
  cryCountAllTime: number;
  dislikeCountDay: number;
  dislikeCountWeek: number;
  dislikeCountMonth: number;
  dislikeCountYear: number;
  dislikeCountAllTime: number;
  heartCountDay: number;
  heartCountWeek: number;
  heartCountMonth: number;
  heartCountYear: number;
  heartCountAllTime: number;
  laughCountDay: number;
  laughCountWeek: number;
  laughCountMonth: number;
  laughCountYear: number;
  laughCountAllTime: number;
  likeCountDay: number;
  likeCountWeek: number;
  likeCountMonth: number;
  likeCountYear: number;
  likeCountAllTime: number;
  reactionCountDay: number;
  reactionCountWeek: number;
  reactionCountMonth: number;
  reactionCountYear: number;
  reactionCountAllTime: number;
  unitAmountCountDay: number;
  unitAmountCountWeek: number;
  unitAmountCountMonth: number;
  unitAmountCountYear: number;
  unitAmountCountAllTime: number;
  tippedCountDay: Generated<number>;
  tippedCountWeek: Generated<number>;
  tippedCountMonth: Generated<number>;
  tippedCountYear: Generated<number>;
  tippedCountAllTime: Generated<number>;
  tippedAmountCountDay: Generated<number>;
  tippedAmountCountWeek: Generated<number>;
  tippedAmountCountMonth: Generated<number>;
  tippedAmountCountYear: Generated<number>;
  tippedAmountCountAllTime: Generated<number>;
};
export type BountyMetric = {
  bountyId: number;
  timeframe: MetricTimeframe;
  favoriteCount: Generated<number>;
  trackCount: Generated<number>;
  entryCount: Generated<number>;
  benefactorCount: Generated<number>;
  unitAmountCount: Generated<number>;
  commentCount: Generated<number>;
  updatedAt: Generated<Timestamp>;
};
export type BountyRank = {
  bountyId: number;
  favoriteCountDayRank: Generated<number>;
  favoriteCountWeekRank: Generated<number>;
  favoriteCountMonthRank: Generated<number>;
  favoriteCountYearRank: Generated<number>;
  favoriteCountAllTimeRank: Generated<number>;
  trackCountDayRank: Generated<number>;
  trackCountWeekRank: Generated<number>;
  trackCountMonthRank: Generated<number>;
  trackCountYearRank: Generated<number>;
  trackCountAllTimeRank: Generated<number>;
  entryCountDayRank: Generated<number>;
  entryCountWeekRank: Generated<number>;
  entryCountMonthRank: Generated<number>;
  entryCountYearRank: Generated<number>;
  entryCountAllTimeRank: Generated<number>;
  benefactorCountDayRank: Generated<number>;
  benefactorCountWeekRank: Generated<number>;
  benefactorCountMonthRank: Generated<number>;
  benefactorCountYearRank: Generated<number>;
  benefactorCountAllTimeRank: Generated<number>;
  unitAmountCountDayRank: Generated<number>;
  unitAmountCountWeekRank: Generated<number>;
  unitAmountCountMonthRank: Generated<number>;
  unitAmountCountYearRank: Generated<number>;
  unitAmountCountAllTimeRank: Generated<number>;
  commentCountDayRank: Generated<number>;
  commentCountWeekRank: Generated<number>;
  commentCountMonthRank: Generated<number>;
  commentCountYearRank: Generated<number>;
  commentCountAllTimeRank: Generated<number>;
};
export type BountyReport = {
  bountyId: number;
  reportId: number;
};
export type BountyStat = {
  bountyId: number;
  favoriteCountDay: number;
  favoriteCountWeek: number;
  favoriteCountMonth: number;
  favoriteCountYear: number;
  favoriteCountAllTime: number;
  trackCountDay: number;
  trackCountWeek: number;
  trackCountMonth: number;
  trackCountYear: number;
  trackCountAllTime: number;
  entryCountDay: number;
  entryCountWeek: number;
  entryCountMonth: number;
  entryCountYear: number;
  entryCountAllTime: number;
  benefactorCountDay: number;
  benefactorCountWeek: number;
  benefactorCountMonth: number;
  benefactorCountYear: number;
  benefactorCountAllTime: number;
  unitAmountCountDay: number;
  unitAmountCountWeek: number;
  unitAmountCountMonth: number;
  unitAmountCountYear: number;
  unitAmountCountAllTime: number;
  commentCountDay: number;
  commentCountWeek: number;
  commentCountMonth: number;
  commentCountYear: number;
  commentCountAllTime: number;
};
export type BuildGuide = {
  id: Generated<number>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  name: string;
  message: string;
  userId: number;
  components: unknown;
  capabilities: unknown;
};
export type BuzzClaim = {
  key: string;
  title: string;
  description: string;
  transactionIdQuery: string;
  amount: number;
  availableStart: Timestamp | null;
  availableEnd: Timestamp | null;
};
export type BuzzTip = {
  entityType: string;
  entityId: number;
  toUserId: number;
  fromUserId: number;
  amount: number;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type BuzzWithdrawalRequest = {
  id: string;
  userId: number | null;
  connectedAccountId: string;
  buzzWithdrawalTransactionId: string;
  requestedBuzzAmount: number;
  platformFeeRate: number;
  transferredAmount: number | null;
  transferId: string | null;
  currency: Currency | null;
  metadata: Generated<unknown>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  status: Generated<BuzzWithdrawalRequestStatus>;
};
export type BuzzWithdrawalRequestHistory = {
  id: string;
  requestId: string;
  updatedById: number;
  status: Generated<BuzzWithdrawalRequestStatus>;
  note: string | null;
  createdAt: Generated<Timestamp>;
  metadata: Generated<unknown>;
};
export type Chat = {
  id: Generated<number>;
  createdAt: Generated<Timestamp>;
  hash: string;
  ownerId: number;
};
export type ChatMember = {
  id: Generated<number>;
  createdAt: Generated<Timestamp>;
  userId: number;
  chatId: number;
  isOwner: Generated<boolean>;
  isMuted: Generated<boolean>;
  status: ChatMemberStatus;
  lastViewedMessageId: number | null;
  joinedAt: Timestamp | null;
  ignoredAt: Timestamp | null;
  leftAt: Timestamp | null;
  kickedAt: Timestamp | null;
  unkickedAt: Timestamp | null;
};
export type ChatMessage = {
  id: Generated<number>;
  createdAt: Generated<Timestamp>;
  userId: number;
  chatId: number;
  content: string;
  contentType: Generated<ChatMessageType>;
  referenceMessageId: number | null;
  editedAt: Timestamp | null;
};
export type ChatReport = {
  chatId: number;
  reportId: number;
};
export type Club = {
  id: Generated<number>;
  userId: number;
  coverImageId: number | null;
  headerImageId: number | null;
  avatarId: number | null;
  name: string;
  description: string;
  nsfw: Generated<boolean>;
  billing: Generated<boolean>;
  unlisted: Generated<boolean>;
};
export type ClubAdmin = {
  userId: number;
  clubId: number;
  createdAt: Generated<Timestamp>;
  permissions: ClubAdminPermission[];
};
export type ClubAdminInvite = {
  id: string;
  expiresAt: Timestamp | null;
  clubId: number;
  createdAt: Generated<Timestamp>;
  permissions: ClubAdminPermission[];
};
export type ClubMembership = {
  id: Generated<number>;
  userId: number;
  clubId: number;
  clubTierId: number;
  startedAt: Timestamp;
  expiresAt: Timestamp | null;
  cancelledAt: Timestamp | null;
  nextBillingAt: Timestamp;
  unitAmount: number;
  currency: Generated<Currency>;
  downgradeClubTierId: number | null;
  billingPausedAt: Timestamp | null;
};
export type ClubMembershipCharge = {
  id: Generated<number>;
  userId: number;
  clubId: number;
  clubTierId: number;
  chargedAt: Timestamp;
  status: string | null;
  invoiceId: string | null;
  unitAmount: number;
  unitAmountPurchased: number;
  currency: Generated<Currency>;
};
export type ClubMetric = {
  clubId: number;
  timeframe: MetricTimeframe;
  memberCount: Generated<number>;
  clubPostCount: Generated<number>;
  resourceCount: Generated<number>;
};
export type ClubPost = {
  id: Generated<number>;
  clubId: number;
  createdById: number;
  createdAt: Generated<Timestamp>;
  membersOnly: boolean;
  title: string | null;
  description: string | null;
  coverImageId: number | null;
  entityId: number | null;
  entityType: string | null;
};
export type ClubPostMetric = {
  clubPostId: number;
  timeframe: MetricTimeframe;
  likeCount: Generated<number>;
  dislikeCount: Generated<number>;
  laughCount: Generated<number>;
  cryCount: Generated<number>;
  heartCount: Generated<number>;
};
export type ClubPostReaction = {
  id: Generated<number>;
  clubPostId: number;
  userId: number;
  reaction: ReviewReactions;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type ClubRank = {
  clubId: number;
  memberCountDayRank: Generated<number>;
  memberCountWeekRank: Generated<number>;
  memberCountMonthRank: Generated<number>;
  memberCountYearRank: Generated<number>;
  memberCountAllTimeRank: Generated<number>;
  resourceCountDayRank: Generated<number>;
  resourceCountWeekRank: Generated<number>;
  resourceCountMonthRank: Generated<number>;
  resourceCountYearRank: Generated<number>;
  resourceCountAllTimeRank: Generated<number>;
  clubPostCountDayRank: Generated<number>;
  clubPostCountWeekRank: Generated<number>;
  clubPostCountMonthRank: Generated<number>;
  clubPostCountYearRank: Generated<number>;
  clubPostCountAllTimeRank: Generated<number>;
};
export type ClubStat = {
  clubId: number;
  memberCountDay: number;
  memberCountWeek: number;
  memberCountMonth: number;
  memberCountYear: number;
  memberCountAllTime: number;
  resourceCountDay: number;
  resourceCountWeek: number;
  resourceCountMonth: number;
  resourceCountYear: number;
  resourceCountAllTime: number;
  clubPostCountDay: number;
  clubPostCountWeek: number;
  clubPostCountMonth: number;
  clubPostCountYear: number;
  clubPostCountAllTime: number;
};
export type ClubTier = {
  id: Generated<number>;
  clubId: number;
  unitAmount: number;
  currency: Generated<Currency>;
  name: string;
  description: string;
  coverImageId: number | null;
  unlisted: Generated<boolean>;
  joinable: boolean;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp | null;
  memberLimit: number | null;
  oneTimeFee: Generated<boolean>;
};
export type Collection = {
  id: Generated<number>;
  createdAt: Generated<Timestamp | null>;
  updatedAt: Timestamp | null;
  name: string;
  description: string | null;
  nsfw: Generated<boolean | null>;
  userId: number;
  imageId: number | null;
  write: Generated<CollectionWriteConfiguration>;
  read: Generated<CollectionReadConfiguration>;
  type: CollectionType | null;
  mode: CollectionMode | null;
  metadata: Generated<unknown>;
  availability: Generated<Availability>;
  nsfwLevel: Generated<number>;
};
export type CollectionContributor = {
  createdAt: Generated<Timestamp | null>;
  updatedAt: Timestamp | null;
  userId: number;
  collectionId: number;
  permissions: CollectionContributorPermission[];
};
export type CollectionItem = {
  id: Generated<number>;
  createdAt: Generated<Timestamp | null>;
  updatedAt: Timestamp | null;
  collectionId: number;
  articleId: number | null;
  postId: number | null;
  imageId: number | null;
  modelId: number | null;
  addedById: number | null;
  reviewedById: number | null;
  reviewedAt: Timestamp | null;
  note: string | null;
  status: Generated<CollectionItemStatus>;
  randomId: number | null;
  tagId: number | null;
};
export type CollectionMetric = {
  collectionId: number;
  timeframe: MetricTimeframe;
  followerCount: Generated<number>;
  itemCount: Generated<number>;
  contributorCount: Generated<number>;
  updatedAt: Generated<Timestamp>;
};
export type CollectionRank = {
  collectionId: number;
  followerCountDayRank: Generated<number>;
  followerCountWeekRank: Generated<number>;
  followerCountMonthRank: Generated<number>;
  followerCountYearRank: Generated<number>;
  followerCountAllTimeRank: Generated<number>;
  itemCountDayRank: Generated<number>;
  itemCountWeekRank: Generated<number>;
  itemCountMonthRank: Generated<number>;
  itemCountYearRank: Generated<number>;
  itemCountAllTimeRank: Generated<number>;
  contributorCountDayRank: Generated<number>;
  contributorCountWeekRank: Generated<number>;
  contributorCountMonthRank: Generated<number>;
  contributorCountYearRank: Generated<number>;
  contributorCountAllTimeRank: Generated<number>;
};
export type CollectionReport = {
  collectionId: number;
  reportId: number;
};
export type CollectionStat = {
  collectionId: number;
  followerCountDay: number;
  followerCountWeek: number;
  followerCountMonth: number;
  followerCountYear: number;
  followerCountAllTime: number;
  itemCountDay: number;
  itemCountWeek: number;
  itemCountMonth: number;
  itemCountYear: number;
  itemCountAllTime: number;
  contributorCountDay: number;
  contributorCountWeek: number;
  contributorCountMonth: number;
  contributorCountYear: number;
  contributorCountAllTime: number;
};
export type Comment = {
  id: Generated<number>;
  content: string;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  nsfw: Generated<boolean>;
  tosViolation: Generated<boolean>;
  parentId: number | null;
  userId: number;
  modelId: number;
  locked: Generated<boolean | null>;
  hidden: Generated<boolean | null>;
};
export type CommentReaction = {
  id: Generated<number>;
  commentId: number;
  userId: number;
  reaction: ReviewReactions;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type CommentReport = {
  commentId: number;
  reportId: number;
};
export type CommentV2 = {
  id: Generated<number>;
  content: string;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  nsfw: Generated<boolean>;
  tosViolation: Generated<boolean>;
  userId: number;
  threadId: number;
  metadata: unknown | null;
  hidden: Generated<boolean | null>;
};
export type CommentV2Reaction = {
  id: Generated<number>;
  commentId: number;
  userId: number;
  reaction: ReviewReactions;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type CommentV2Report = {
  commentV2Id: number;
  reportId: number;
};
export type Cosmetic = {
  id: Generated<number>;
  name: string;
  description: string | null;
  videoUrl: string | null;
  type: CosmeticType;
  source: CosmeticSource;
  permanentUnlock: boolean;
  data: unknown;
  createdAt: Generated<Timestamp | null>;
  updatedAt: Timestamp | null;
  availableStart: Timestamp | null;
  availableEnd: Timestamp | null;
  availableQuery: string | null;
  productId: string | null;
  leaderboardId: string | null;
  leaderboardPosition: number | null;
};
export type CosmeticShopItem = {
  id: Generated<number>;
  cosmeticId: number;
  unitAmount: number;
  addedById: number | null;
  createdAt: Generated<Timestamp>;
  availableFrom: Timestamp | null;
  availableTo: Timestamp | null;
  availableQuantity: number | null;
  meta: Generated<unknown>;
  title: string;
  description: string | null;
  archivedAt: Timestamp | null;
};
export type CosmeticShopSection = {
  id: Generated<number>;
  addedById: number | null;
  title: string;
  description: string | null;
  placement: Generated<number>;
  meta: Generated<unknown>;
  imageId: number | null;
  published: Generated<boolean>;
};
export type CosmeticShopSectionItem = {
  shopItemId: number;
  shopSectionId: number;
  index: Generated<number>;
  createdAt: Generated<Timestamp>;
};
export type CsamReport = {
  id: Generated<number>;
  userId: number | null;
  createdAt: Generated<Timestamp>;
  reportedById: number;
  reportSentAt: Timestamp | null;
  archivedAt: Timestamp | null;
  contentRemovedAt: Timestamp | null;
  reportId: number | null;
  details: Generated<unknown>;
  images: Generated<unknown>;
  type: Generated<CsamReportType>;
};
export type CustomerSubscription = {
  id: string;
  userId: number;
  metadata: unknown;
  status: string;
  priceId: string;
  productId: string;
  cancelAtPeriodEnd: boolean;
  cancelAt: Timestamp | null;
  canceledAt: Timestamp | null;
  currentPeriodStart: Timestamp;
  currentPeriodEnd: Timestamp;
  createdAt: Timestamp;
  endedAt: Timestamp | null;
  updatedAt: Timestamp | null;
};
export type Donation = {
  id: Generated<number>;
  userId: number;
  donationGoalId: number;
  amount: number;
  buzzTransactionId: string;
  notes: string | null;
  createdAt: Generated<Timestamp>;
};
export type DonationGoal = {
  id: Generated<number>;
  userId: number;
  title: string;
  description: string | null;
  goalAmount: number;
  paidAmount: Generated<number>;
  modelVersionId: number | null;
  createdAt: Generated<Timestamp>;
  isEarlyAccess: Generated<boolean>;
  active: Generated<boolean>;
};
export type DownloadHistory = {
  userId: number;
  modelVersionId: number;
  downloadAt: Timestamp;
  hidden: Generated<boolean>;
};
export type EntityAccess = {
  accessToId: number;
  accessToType: string;
  accessorId: number;
  accessorType: string;
  addedById: number;
  addedAt: Generated<Timestamp>;
  permissions: Generated<number>;
  meta: Generated<unknown | null>;
};
export type EntityCollaborator = {
  entityType: EntityType;
  entityId: number;
  userId: number;
  status: Generated<EntityCollaboratorStatus>;
  createdAt: Generated<Timestamp>;
  createdBy: number;
  lastMessageSentAt: Timestamp | null;
};
export type EntityMetric = {
  entityType: EntityMetric_EntityType_Type;
  entityId: number;
  metricType: EntityMetric_MetricType_Type;
  metricValue: Generated<number>;
};
export type EntityMetricImage = {
  imageId: number;
  reactionLike: number | null;
  reactionHeart: number | null;
  reactionLaugh: number | null;
  reactionCry: number | null;
  reactionTotal: number | null;
  comment: number | null;
  collection: number | null;
  buzz: number | null;
};
export type File = {
  id: Generated<number>;
  name: string;
  url: string;
  sizeKB: number;
  createdAt: Generated<Timestamp>;
  entityId: number;
  entityType: string;
  metadata: unknown | null;
};
export type GenerationCoverage = {
  modelId: number;
  modelVersionId: number;
  covered: boolean;
};
export type GenerationServiceProvider = {
  name: string;
  schedulers: GenerationSchedulers[];
};
export type HomeBlock = {
  id: Generated<number>;
  createdAt: Generated<Timestamp | null>;
  updatedAt: Timestamp | null;
  userId: number;
  metadata: Generated<unknown>;
  index: number | null;
  type: HomeBlockType;
  permanent: Generated<boolean>;
  sourceId: number | null;
};
export type Image = {
  id: Generated<number>;
  pHash: string | null;
  name: string | null;
  url: string;
  userId: number;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  meta: unknown | null;
  hash: string | null;
  height: number | null;
  width: number | null;
  type: Generated<MediaType>;
  metadata: Generated<unknown>;
  nsfw: Generated<NsfwLevel>;
  nsfwLevel: Generated<number>;
  nsfwLevelLocked: Generated<boolean>;
  tosViolation: Generated<boolean>;
  analysis: unknown | null;
  generationProcess: ImageGenerationProcess | null;
  featuredAt: Timestamp | null;
  postId: number | null;
  needsReview: string | null;
  hideMeta: Generated<boolean>;
  index: number | null;
  scannedAt: Timestamp | null;
  scanRequestedAt: Timestamp | null;
  mimeType: string | null;
  sizeKB: number | null;
  ingestion: Generated<ImageIngestionStatus>;
  blockedFor: string | null;
  scanJobs: unknown | null;
  sortAt: Generated<Timestamp>;
};
export type ImageConnection = {
  imageId: number;
  entityId: number;
  entityType: string;
};
export type ImageEngagement = {
  userId: number;
  imageId: number;
  type: ImageEngagementType;
  createdAt: Generated<Timestamp>;
};
export type ImageMetric = {
  imageId: number;
  timeframe: MetricTimeframe;
  likeCount: Generated<number>;
  dislikeCount: Generated<number>;
  laughCount: Generated<number>;
  cryCount: Generated<number>;
  heartCount: Generated<number>;
  commentCount: Generated<number>;
  collectedCount: Generated<number>;
  tippedCount: Generated<number>;
  tippedAmountCount: Generated<number>;
  viewCount: Generated<number>;
  reactionCount: number;
  updatedAt: Generated<Timestamp>;
};
export type ImageModHelper = {
  imageId: number;
  assessedNSFW: Generated<boolean | null>;
  nsfwReportCount: Generated<number>;
};
export type ImageRatingRequest = {
  userId: number;
  imageId: number;
  createdAt: Generated<Timestamp>;
  nsfwLevel: number;
  status: Generated<ReportStatus>;
};
export type ImageReaction = {
  id: Generated<number>;
  imageId: number;
  userId: number;
  reaction: ReviewReactions;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type ImageReport = {
  imageId: number;
  reportId: number;
};
export type ImageResource = {
  id: Generated<number>;
  modelVersionId: number | null;
  name: string | null;
  hash: string | null;
  imageId: number;
  strength: number | null;
  detected: Generated<boolean>;
};
export type ImageResourceHelper = {
  id: number;
  imageId: number;
  reviewId: number | null;
  reviewRating: number | null;
  reviewDetails: string | null;
  reviewCreatedAt: Timestamp | null;
  name: string | null;
  hash: string | null;
  modelVersionId: number | null;
  modelVersionName: string | null;
  modelVersionCreatedAt: Timestamp | null;
  modelId: number | null;
  modelName: string | null;
  modelDownloadCount: number | null;
  modelCommentCount: number | null;
  modelThumbsUpCount: number | null;
  modelThumbsDownCount: number | null;
  modelType: ModelType | null;
};
export type ImageStat = {
  imageId: number;
  cryCountDay: Generated<number>;
  cryCountWeek: Generated<number>;
  cryCountMonth: Generated<number>;
  cryCountYear: Generated<number>;
  cryCountAllTime: Generated<number>;
  dislikeCountDay: Generated<number>;
  dislikeCountWeek: Generated<number>;
  dislikeCountMonth: Generated<number>;
  dislikeCountYear: Generated<number>;
  dislikeCountAllTime: Generated<number>;
  heartCountDay: Generated<number>;
  heartCountWeek: Generated<number>;
  heartCountMonth: Generated<number>;
  heartCountYear: Generated<number>;
  heartCountAllTime: Generated<number>;
  laughCountDay: Generated<number>;
  laughCountWeek: Generated<number>;
  laughCountMonth: Generated<number>;
  laughCountYear: Generated<number>;
  laughCountAllTime: Generated<number>;
  likeCountDay: Generated<number>;
  likeCountWeek: Generated<number>;
  likeCountMonth: Generated<number>;
  likeCountYear: Generated<number>;
  likeCountAllTime: Generated<number>;
  commentCountDay: Generated<number>;
  commentCountWeek: Generated<number>;
  commentCountMonth: Generated<number>;
  commentCountYear: Generated<number>;
  commentCountAllTime: Generated<number>;
  reactionCountDay: Generated<number>;
  reactionCountWeek: Generated<number>;
  reactionCountMonth: Generated<number>;
  reactionCountYear: Generated<number>;
  reactionCountAllTime: Generated<number>;
  collectedCountDay: Generated<number>;
  collectedCountWeek: Generated<number>;
  collectedCountMonth: Generated<number>;
  collectedCountYear: Generated<number>;
  collectedCountAllTime: Generated<number>;
  tippedCountDay: Generated<number>;
  tippedCountWeek: Generated<number>;
  tippedCountMonth: Generated<number>;
  tippedCountYear: Generated<number>;
  tippedCountAllTime: Generated<number>;
  tippedAmountCountDay: Generated<number>;
  tippedAmountCountWeek: Generated<number>;
  tippedAmountCountMonth: Generated<number>;
  tippedAmountCountYear: Generated<number>;
  tippedAmountCountAllTime: Generated<number>;
  viewCountDay: Generated<number>;
  viewCountWeek: Generated<number>;
  viewCountMonth: Generated<number>;
  viewCountYear: Generated<number>;
  viewCountAllTime: Generated<number>;
};
export type ImageTag = {
  imageId: number;
  tagId: number;
  tagName: string;
  tagType: TagType;
  tagNsfw: NsfwLevel;
  tagNsfwLevel: number;
  automated: boolean;
  confidence: number | null;
  score: number;
  upVotes: number;
  downVotes: number;
  needsReview: boolean;
  concrete: boolean;
  lastUpvote: Timestamp | null;
  source: TagSource;
};
export type ImageTechnique = {
  imageId: number;
  techniqueId: number;
  notes: string | null;
  createdAt: Generated<Timestamp>;
};
export type ImageTool = {
  imageId: number;
  toolId: number;
  notes: string | null;
  createdAt: Generated<Timestamp>;
};
export type Import = {
  id: Generated<number>;
  userId: number | null;
  createdAt: Generated<Timestamp>;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  source: string;
  status: Generated<ImportStatus>;
  data: unknown | null;
  parentId: number | null;
  importId: number | null;
};
export type JobQueue = {
  type: JobQueueType;
  entityType: EntityType;
  entityId: number;
  createdAt: Generated<Timestamp>;
};
export type KeyValue = {
  key: string;
  value: unknown;
};
export type Leaderboard = {
  id: string;
  index: number;
  title: string;
  description: string;
  scoringDescription: string;
  query: string;
  active: boolean;
  public: boolean;
};
export type LeaderboardResult = {
  leaderboardId: string;
  date: Timestamp;
  position: number;
  userId: number;
  score: Generated<number>;
  metrics: Generated<unknown>;
  createdAt: Generated<Timestamp>;
};
export type License = {
  id: Generated<number>;
  name: string;
  url: string;
};
export type LicenseToModel = {
  A: number;
  B: number;
};
export type Link = {
  id: Generated<number>;
  url: string;
  type: LinkType;
  entityId: number;
  entityType: string;
};
export type Log = {
  id: string;
  event: string;
  details: unknown | null;
  createdAt: Generated<Timestamp>;
};
export type ModActivity = {
  id: Generated<number>;
  userId: number | null;
  activity: string;
  entityType: string | null;
  entityId: number | null;
  createdAt: Generated<Timestamp>;
};
export type Model = {
  id: Generated<number>;
  name: string;
  description: string | null;
  type: ModelType;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  lastVersionAt: Timestamp | null;
  nsfw: Generated<boolean>;
  tosViolation: Generated<boolean>;
  poi: Generated<boolean>;
  minor: Generated<boolean>;
  userId: number;
  status: Generated<ModelStatus>;
  publishedAt: Timestamp | null;
  fromImportId: number | null;
  meta: Generated<unknown>;
  deletedAt: Timestamp | null;
  deletedBy: number | null;
  checkpointType: CheckpointType | null;
  uploadType: Generated<ModelUploadType>;
  locked: Generated<boolean>;
  underAttack: Generated<boolean>;
  earlyAccessDeadline: Timestamp | null;
  mode: ModelModifier | null;
  unlisted: Generated<boolean>;
  gallerySettings: Generated<unknown>;
  availability: Generated<Availability>;
  nsfwLevel: Generated<number>;
  lockedProperties: Generated<string[]>;
  allowNoCredit: Generated<boolean>;
  allowCommercialUse: Generated<CommercialUse[]>;
  allowDerivatives: Generated<boolean>;
  allowDifferentLicense: Generated<boolean>;
};
export type ModelAssociations = {
  id: Generated<number>;
  fromModelId: number;
  toModelId: number | null;
  toArticleId: number | null;
  associatedById: number | null;
  createdAt: Generated<Timestamp>;
  type: AssociationType;
  index: number | null;
};
export type ModelEngagement = {
  userId: number;
  modelId: number;
  type: ModelEngagementType;
  createdAt: Generated<Timestamp>;
};
export type ModelFile = {
  id: Generated<number>;
  name: string;
  overrideName: string | null;
  url: string;
  sizeKB: number;
  createdAt: Generated<Timestamp>;
  type: Generated<string>;
  modelVersionId: number;
  pickleScanResult: Generated<ScanResultCode>;
  exists: boolean | null;
  pickleScanMessage: string | null;
  virusScanResult: Generated<ScanResultCode>;
  virusScanMessage: string | null;
  scannedAt: Timestamp | null;
  scanRequestedAt: Timestamp | null;
  rawScanResult: unknown | null;
  metadata: unknown | null;
  headerData: unknown | null;
  visibility: Generated<ModelFileVisibility>;
  dataPurged: Generated<boolean>;
};
export type ModelFileHash = {
  fileId: number;
  type: ModelHashType;
  hash: string;
  createdAt: Generated<Timestamp>;
};
export type ModelHash = {
  modelId: number;
  modelVersionId: number;
  hashType: ModelHashType;
  fileType: string;
  hash: string;
};
export type ModelInterest = {
  userId: number;
  modelId: number;
  createdAt: Generated<Timestamp>;
};
export type ModelMetric = {
  modelId: number;
  timeframe: MetricTimeframe;
  rating: Generated<number>;
  ratingCount: Generated<number>;
  downloadCount: Generated<number>;
  favoriteCount: Generated<number>;
  commentCount: Generated<number>;
  collectedCount: Generated<number>;
  imageCount: Generated<number>;
  tippedCount: Generated<number>;
  tippedAmountCount: Generated<number>;
  generationCount: Generated<number>;
  thumbsUpCount: Generated<number>;
  thumbsDownCount: Generated<number>;
  updatedAt: Generated<Timestamp>;
};
export type ModelMetricDaily = {
  modelId: number;
  modelVersionId: number;
  type: string;
  date: Timestamp;
  count: number;
};
export type ModelReport = {
  modelId: number;
  reportId: number;
};
export type ModelReportStat = {
  modelId: number;
  tosViolationPending: number;
  tosViolationUnactioned: number;
  tosViolationActioned: number;
  nsfwPending: number;
  nsfwUnactioned: number;
  nsfwActioned: number;
  ownershipPending: number;
  ownershipProcessing: number;
  ownershipActioned: number;
  ownershipUnactioned: number;
  adminAttentionPending: number;
  adminAttentionActioned: number;
  adminAttentionUnactioned: number;
  claimPending: number;
  claimActioned: number;
  claimUnactioned: number;
};
export type ModelTag = {
  modelId: number;
  tagId: number;
  tagName: string;
  tagType: TagType;
  score: number;
  upVotes: number;
  downVotes: number;
  needsReview: boolean;
};
export type ModelVersion = {
  id: Generated<number>;
  index: number | null;
  name: string;
  description: string | null;
  modelId: number;
  trainedWords: string[];
  steps: number | null;
  epochs: number | null;
  clipSkip: number | null;
  vaeId: number | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  publishedAt: Timestamp | null;
  status: Generated<ModelStatus>;
  trainingStatus: TrainingStatus | null;
  trainingDetails: unknown | null;
  fromImportId: number | null;
  inaccurate: Generated<boolean>;
  baseModel: string;
  baseModelType: string | null;
  meta: Generated<unknown>;
  requireAuth: Generated<boolean>;
  settings: unknown | null;
  availability: Generated<Availability>;
  nsfwLevel: Generated<number>;
  earlyAccessEndsAt: Timestamp | null;
  earlyAccessConfig: unknown | null;
};
export type ModelVersionEngagement = {
  userId: number;
  modelVersionId: number;
  type: ModelVersionEngagementType;
  createdAt: Generated<Timestamp>;
};
export type ModelVersionExploration = {
  index: number;
  name: string;
  prompt: string;
  modelVersionId: number;
};
export type ModelVersionMetric = {
  modelVersionId: number;
  timeframe: MetricTimeframe;
  rating: Generated<number>;
  ratingCount: Generated<number>;
  downloadCount: Generated<number>;
  favoriteCount: Generated<number>;
  commentCount: Generated<number>;
  collectedCount: Generated<number>;
  imageCount: Generated<number>;
  tippedCount: Generated<number>;
  tippedAmountCount: Generated<number>;
  generationCount: Generated<number>;
  thumbsUpCount: Generated<number>;
  thumbsDownCount: Generated<number>;
  updatedAt: Generated<Timestamp>;
};
export type ModelVersionMonetization = {
  id: Generated<number>;
  modelVersionId: number;
  type: Generated<ModelVersionMonetizationType>;
  currency: Generated<Currency>;
  unitAmount: number | null;
};
export type ModelVersionSponsorshipSettings = {
  id: Generated<number>;
  modelVersionMonetizationId: number;
  type: Generated<ModelVersionSponsorshipSettingsType>;
  currency: Generated<Currency>;
  unitAmount: number;
};
export type Partner = {
  id: Generated<number>;
  name: string;
  homepage: string | null;
  tos: string | null;
  privacy: string | null;
  startupTime: number | null;
  onDemand: boolean;
  onDemandStrategy: string | null;
  onDemandTypes: Generated<ModelType[]>;
  onDemandBaseModels: Generated<string[]>;
  stepsPerSecond: number;
  pricingModel: PartnerPricingModel;
  price: string;
  about: string | null;
  createdAt: Generated<Timestamp>;
  nsfw: Generated<boolean>;
  poi: Generated<boolean>;
  personal: Generated<boolean>;
  token: string | null;
  tier: Generated<number>;
  logo: string | null;
};
export type Post = {
  id: Generated<number>;
  nsfw: Generated<boolean>;
  title: string | null;
  detail: string | null;
  userId: number;
  modelVersionId: number | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  publishedAt: Timestamp | null;
  metadata: unknown | null;
  tosViolation: Generated<boolean>;
  collectionId: number | null;
  unlisted: Generated<boolean>;
  availability: Generated<Availability>;
  nsfwLevel: Generated<number>;
};
export type PostHelper = {
  postId: number;
  scanned: boolean;
};
export type PostImageTag = {
  postId: number;
  tagId: number;
};
export type PostMetric = {
  postId: number;
  timeframe: MetricTimeframe;
  likeCount: Generated<number>;
  dislikeCount: Generated<number>;
  laughCount: Generated<number>;
  cryCount: Generated<number>;
  heartCount: Generated<number>;
  commentCount: Generated<number>;
  collectedCount: Generated<number>;
  updatedAt: Generated<Timestamp>;
};
export type PostRank = {
  postId: number;
  cryCountDayRank: Generated<number>;
  cryCountWeekRank: Generated<number>;
  cryCountMonthRank: Generated<number>;
  cryCountYearRank: Generated<number>;
  cryCountAllTimeRank: Generated<number>;
  dislikeCountDayRank: Generated<number>;
  dislikeCountWeekRank: Generated<number>;
  dislikeCountMonthRank: Generated<number>;
  dislikeCountYearRank: Generated<number>;
  dislikeCountAllTimeRank: Generated<number>;
  heartCountDayRank: Generated<number>;
  heartCountWeekRank: Generated<number>;
  heartCountMonthRank: Generated<number>;
  heartCountYearRank: Generated<number>;
  heartCountAllTimeRank: Generated<number>;
  laughCountDayRank: Generated<number>;
  laughCountWeekRank: Generated<number>;
  laughCountMonthRank: Generated<number>;
  laughCountYearRank: Generated<number>;
  laughCountAllTimeRank: Generated<number>;
  likeCountDayRank: Generated<number>;
  likeCountWeekRank: Generated<number>;
  likeCountMonthRank: Generated<number>;
  likeCountYearRank: Generated<number>;
  likeCountAllTimeRank: Generated<number>;
  commentCountDayRank: Generated<number>;
  commentCountWeekRank: Generated<number>;
  commentCountMonthRank: Generated<number>;
  commentCountYearRank: Generated<number>;
  commentCountAllTimeRank: Generated<number>;
  reactionCountDayRank: Generated<number>;
  reactionCountWeekRank: Generated<number>;
  reactionCountMonthRank: Generated<number>;
  reactionCountYearRank: Generated<number>;
  reactionCountAllTimeRank: Generated<number>;
  collectedCountDayRank: Generated<number>;
  collectedCountWeekRank: Generated<number>;
  collectedCountMonthRank: Generated<number>;
  collectedCountYearRank: Generated<number>;
  collectedCountAllTimeRank: Generated<number>;
};
export type PostReaction = {
  id: Generated<number>;
  postId: number;
  userId: number;
  reaction: ReviewReactions;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type PostReport = {
  postId: number;
  reportId: number;
};
export type PostResourceHelper = {
  id: number;
  postId: number;
  reviewId: number | null;
  reviewRating: number | null;
  reviewRecommended: boolean | null;
  reviewDetails: string | null;
  reviewCreatedAt: Timestamp | null;
  name: string | null;
  modelVersionId: number | null;
  modelVersionName: string | null;
  modelVersionCreatedAt: Timestamp | null;
  modelId: number | null;
  modelName: string | null;
  modelDownloadCount: number | null;
  modelCommentCount: number | null;
  modelThumbsUpCount: number | null;
  modelThumbsDownCount: number | null;
  modelType: ModelType | null;
};
export type PostStat = {
  postId: number;
  cryCountDay: Generated<number>;
  cryCountWeek: Generated<number>;
  cryCountMonth: Generated<number>;
  cryCountYear: Generated<number>;
  cryCountAllTime: Generated<number>;
  dislikeCountDay: Generated<number>;
  dislikeCountWeek: Generated<number>;
  dislikeCountMonth: Generated<number>;
  dislikeCountYear: Generated<number>;
  dislikeCountAllTime: Generated<number>;
  heartCountDay: Generated<number>;
  heartCountWeek: Generated<number>;
  heartCountMonth: Generated<number>;
  heartCountYear: Generated<number>;
  heartCountAllTime: Generated<number>;
  laughCountDay: Generated<number>;
  laughCountWeek: Generated<number>;
  laughCountMonth: Generated<number>;
  laughCountYear: Generated<number>;
  laughCountAllTime: Generated<number>;
  likeCountDay: Generated<number>;
  likeCountWeek: Generated<number>;
  likeCountMonth: Generated<number>;
  likeCountYear: Generated<number>;
  likeCountAllTime: Generated<number>;
  commentCountDay: Generated<number>;
  commentCountWeek: Generated<number>;
  commentCountMonth: Generated<number>;
  commentCountYear: Generated<number>;
  commentCountAllTime: Generated<number>;
  reactionCountDay: Generated<number>;
  reactionCountWeek: Generated<number>;
  reactionCountMonth: Generated<number>;
  reactionCountYear: Generated<number>;
  reactionCountAllTime: Generated<number>;
};
export type PostTag = {
  postId: number;
  tagId: number;
  tagName: string;
  tagType: TagType;
  score: number;
  upVotes: number;
  downVotes: number;
};
export type PressMention = {
  id: Generated<number>;
  title: string;
  url: string;
  source: string;
  publishedAt: Generated<Timestamp>;
  createdAt: Generated<Timestamp>;
};
export type Price = {
  id: string;
  productId: string;
  active: boolean;
  currency: string;
  description: string | null;
  type: string;
  unitAmount: number | null;
  interval: string | null;
  intervalCount: number | null;
  metadata: unknown;
};
export type Product = {
  id: string;
  active: boolean;
  name: string;
  description: string | null;
  metadata: unknown;
  defaultPriceId: string | null;
};
export type PurchasableReward = {
  id: Generated<number>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  title: string;
  unitPrice: number;
  about: string;
  redeemDetails: string;
  termsOfUse: string;
  usage: PurchasableRewardUsage;
  codes: string[];
  archived: Generated<boolean>;
  availableFrom: Timestamp | null;
  availableTo: Timestamp | null;
  availableCount: number | null;
  addedById: number | null;
  coverImageId: number | null;
};
export type Purchase = {
  id: Generated<number>;
  customerId: string;
  productId: string | null;
  priceId: string | null;
  status: string | null;
  createdAt: Generated<Timestamp>;
};
export type QueryDurationLog = {
  id: Generated<number>;
  duration: number;
  sqlId: number;
  paramsId: number;
};
export type QueryParamsLog = {
  id: Generated<number>;
  hash: string;
  params: unknown;
  sqlId: number;
};
export type QuerySqlLog = {
  id: Generated<number>;
  hash: string;
  sql: string;
};
export type Question = {
  id: Generated<number>;
  userId: number;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  title: string;
  content: string;
  selectedAnswerId: number | null;
};
export type QuestionMetric = {
  questionId: number;
  timeframe: MetricTimeframe;
  heartCount: Generated<number>;
  commentCount: Generated<number>;
  answerCount: Generated<number>;
};
export type QuestionRank = {
  questionId: number;
  answerCountDay: number;
  answerCountWeek: number;
  answerCountMonth: number;
  answerCountYear: number;
  answerCountAllTime: number;
  heartCountDay: number;
  heartCountWeek: number;
  heartCountMonth: number;
  heartCountYear: number;
  heartCountAllTime: number;
  commentCountDay: number;
  commentCountWeek: number;
  commentCountMonth: number;
  commentCountYear: number;
  commentCountAllTime: number;
  answerCountDayRank: number;
  answerCountWeekRank: number;
  answerCountMonthRank: number;
  answerCountYearRank: number;
  answerCountAllTimeRank: number;
  heartCountDayRank: number;
  heartCountWeekRank: number;
  heartCountMonthRank: number;
  heartCountYearRank: number;
  heartCountAllTimeRank: number;
  commentCountDayRank: number;
  commentCountWeekRank: number;
  commentCountMonthRank: number;
  commentCountYearRank: number;
  commentCountAllTimeRank: number;
};
export type QuestionReaction = {
  id: Generated<number>;
  questionId: number;
  userId: number;
  reaction: ReviewReactions;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type RecommendedResource = {
  id: Generated<number>;
  resourceId: number;
  sourceId: number | null;
  settings: unknown | null;
};
export type RedeemableCode = {
  code: string;
  unitValue: number;
  userId: number | null;
  createdAt: Generated<Timestamp>;
  type: RedeemableCodeType;
  expiresAt: Timestamp | null;
  redeemedAt: Timestamp | null;
  transactionId: string | null;
};
export type Report = {
  id: Generated<number>;
  userId: number;
  reason: ReportReason;
  createdAt: Generated<Timestamp>;
  details: unknown | null;
  internalNotes: string | null;
  previouslyReviewedCount: Generated<number>;
  alsoReportedBy: Generated<number[]>;
  status: ReportStatus;
  statusSetAt: Timestamp | null;
  statusSetBy: number | null;
};
export type ResourceReview = {
  id: Generated<number>;
  modelId: number;
  modelVersionId: number;
  rating: number;
  recommended: boolean;
  details: string | null;
  userId: number;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  exclude: Generated<boolean>;
  nsfw: Generated<boolean>;
  tosViolation: Generated<boolean>;
  metadata: unknown | null;
};
export type ResourceReviewHelper = {
  resourceReviewId: number;
  imageCount: number;
};
export type ResourceReviewReaction = {
  id: Generated<number>;
  reviewId: number;
  userId: number;
  reaction: ReviewReactions;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type ResourceReviewReport = {
  resourceReviewId: number;
  reportId: number;
};
export type RunStrategy = {
  modelVersionId: number;
  partnerId: number;
  url: string;
  createdAt: Generated<Timestamp>;
};
export type SavedModel = {
  modelId: number;
  userId: number;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type Session = {
  id: Generated<number>;
  sessionToken: string;
  userId: number;
  expires: Timestamp;
};
export type SessionInvalidation = {
  userId: number;
  invalidatedAt: Generated<Timestamp>;
};
export type Tag = {
  id: Generated<number>;
  name: string;
  color: string | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  target: TagTarget[];
  type: Generated<TagType>;
  nsfw: Generated<NsfwLevel>;
  nsfwLevel: Generated<number>;
  unlisted: Generated<boolean>;
  unfeatured: Generated<boolean>;
  isCategory: Generated<boolean>;
  adminOnly: Generated<boolean>;
};
export type TagEngagement = {
  userId: number;
  tagId: number;
  type: TagEngagementType;
  createdAt: Generated<Timestamp>;
};
export type TagMetric = {
  tagId: number;
  timeframe: MetricTimeframe;
  modelCount: Generated<number>;
  imageCount: Generated<number>;
  postCount: Generated<number>;
  articleCount: Generated<number>;
  hiddenCount: Generated<number>;
  followerCount: Generated<number>;
  updatedAt: Generated<Timestamp>;
};
export type TagRank = {
  tagId: number;
  followerCountDayRank: Generated<number>;
  followerCountWeekRank: Generated<number>;
  followerCountMonthRank: Generated<number>;
  followerCountYearRank: Generated<number>;
  followerCountAllTimeRank: Generated<number>;
  hiddenCountDayRank: Generated<number>;
  hiddenCountWeekRank: Generated<number>;
  hiddenCountMonthRank: Generated<number>;
  hiddenCountYearRank: Generated<number>;
  hiddenCountAllTimeRank: Generated<number>;
  modelCountDayRank: Generated<number>;
  modelCountWeekRank: Generated<number>;
  modelCountMonthRank: Generated<number>;
  modelCountYearRank: Generated<number>;
  modelCountAllTimeRank: Generated<number>;
  imageCountDayRank: Generated<number>;
  imageCountWeekRank: Generated<number>;
  imageCountMonthRank: Generated<number>;
  imageCountYearRank: Generated<number>;
  imageCountAllTimeRank: Generated<number>;
  postCountDayRank: Generated<number>;
  postCountWeekRank: Generated<number>;
  postCountMonthRank: Generated<number>;
  postCountYearRank: Generated<number>;
  postCountAllTimeRank: Generated<number>;
  articleCountDayRank: Generated<number>;
  articleCountWeekRank: Generated<number>;
  articleCountMonthRank: Generated<number>;
  articleCountYearRank: Generated<number>;
  articleCountAllTimeRank: Generated<number>;
};
export type TagsOnArticle = {
  articleId: number;
  tagId: number;
  createdAt: Generated<Timestamp>;
};
export type TagsOnBounty = {
  bountyId: number;
  tagId: number;
  createdAt: Generated<Timestamp>;
};
export type TagsOnCollection = {
  collectionId: number;
  tagId: number;
  createdAt: Generated<Timestamp | null>;
};
export type TagsOnImage = {
  imageId: number;
  tagId: number;
  createdAt: Generated<Timestamp>;
  automated: Generated<boolean>;
  confidence: number | null;
  disabled: Generated<boolean>;
  disabledAt: Timestamp | null;
  needsReview: Generated<boolean>;
  source: Generated<TagSource>;
};
export type TagsOnImageVote = {
  imageId: number;
  tagId: number;
  userId: number;
  vote: number;
  createdAt: Generated<Timestamp>;
  applied: Generated<boolean>;
};
export type TagsOnModels = {
  modelId: number;
  tagId: number;
  createdAt: Generated<Timestamp>;
};
export type TagsOnModelsVote = {
  modelId: number;
  tagId: number;
  userId: number;
  vote: number;
  createdAt: Generated<Timestamp>;
};
export type TagsOnPost = {
  postId: number;
  tagId: number;
  createdAt: Generated<Timestamp>;
  confidence: number | null;
  disabled: Generated<boolean>;
  needsReview: Generated<boolean>;
};
export type TagsOnPostVote = {
  postId: number;
  tagId: number;
  userId: number;
  vote: number;
  createdAt: Generated<Timestamp>;
};
export type TagsOnQuestions = {
  questionId: number;
  tagId: number;
};
export type TagsOnTags = {
  fromTagId: number;
  toTagId: number;
  type: Generated<TagsOnTagsType>;
  createdAt: Generated<Timestamp>;
};
export type TagStat = {
  tagId: number;
  followerCountDay: number;
  followerCountWeek: number;
  followerCountMonth: number;
  followerCountYear: number;
  followerCountAllTime: number;
  hiddenCountDay: number;
  hiddenCountWeek: number;
  hiddenCountMonth: number;
  hiddenCountYear: number;
  hiddenCountAllTime: number;
  modelCountDay: number;
  modelCountWeek: number;
  modelCountMonth: number;
  modelCountYear: number;
  modelCountAllTime: number;
  imageCountDay: number;
  imageCountWeek: number;
  imageCountMonth: number;
  imageCountYear: number;
  imageCountAllTime: number;
  postCountDay: number;
  postCountWeek: number;
  postCountMonth: number;
  postCountYear: number;
  postCountAllTime: number;
};
export type Technique = {
  id: Generated<number>;
  name: string;
  createdAt: Generated<Timestamp>;
  enabled: Generated<boolean>;
  type: TechniqueType;
};
export type Thread = {
  id: Generated<number>;
  locked: Generated<boolean>;
  parentThreadId: number | null;
  rootThreadId: number | null;
  questionId: number | null;
  answerId: number | null;
  imageId: number | null;
  postId: number | null;
  reviewId: number | null;
  commentId: number | null;
  modelId: number | null;
  articleId: number | null;
  bountyId: number | null;
  bountyEntryId: number | null;
  clubPostId: number | null;
  metadata: Generated<unknown>;
};
export type TipConnection = {
  transactionId: string;
  entityId: number;
  entityType: string;
};
export type Tool = {
  id: Generated<number>;
  name: string;
  icon: string | null;
  createdAt: Generated<Timestamp>;
  enabled: Generated<boolean>;
  type: ToolType;
  domain: string | null;
  priority: number | null;
  description: string | null;
  metadata: Generated<unknown>;
};
export type User = {
  id: Generated<number>;
  name: string | null;
  username: string | null;
  email: string | null;
  emailVerified: Timestamp | null;
  image: string | null;
  showNsfw: Generated<boolean>;
  blurNsfw: Generated<boolean>;
  browsingLevel: Generated<number>;
  onboarding: Generated<number>;
  isModerator: Generated<boolean | null>;
  createdAt: Generated<Timestamp>;
  deletedAt: Timestamp | null;
  customerId: string | null;
  subscriptionId: string | null;
  /**
   * Updated via trigger
   */
  mutedAt: Timestamp | null;
  muted: Generated<boolean>;
  muteConfirmedAt: Timestamp | null;
  bannedAt: Timestamp | null;
  autoplayGifs: Generated<boolean | null>;
  filePreferences: Generated<unknown>;
  meta: Generated<unknown | null>;
  leaderboardShowcase: string | null;
  excludeFromLeaderboards: Generated<boolean>;
  rewardsEligibility: Generated<RewardsEligibility>;
  eligibilityChangedAt: Timestamp | null;
  profilePictureId: number | null;
  settings: Generated<unknown | null>;
  publicSettings: Generated<unknown | null>;
};
export type UserCosmetic = {
  userId: number;
  cosmeticId: number;
  obtainedAt: Generated<Timestamp>;
  equippedAt: Timestamp | null;
  data: unknown | null;
  claimKey: Generated<string>;
  equippedToId: number | null;
  equippedToType: CosmeticEntity | null;
  forId: number | null;
  forType: CosmeticEntity | null;
};
export type UserCosmeticShopPurchases = {
  userId: number;
  cosmeticId: number;
  shopItemId: number;
  unitAmount: number;
  purchasedAt: Generated<Timestamp>;
  buzzTransactionId: string;
  refunded: boolean;
};
export type UserEngagement = {
  userId: number;
  targetUserId: number;
  type: UserEngagementType;
  createdAt: Generated<Timestamp>;
};
export type UserLink = {
  id: Generated<number>;
  userId: number;
  url: string;
  type: LinkType;
};
export type UserMetric = {
  userId: number;
  timeframe: MetricTimeframe;
  followingCount: Generated<number>;
  followerCount: Generated<number>;
  reactionCount: Generated<number>;
  hiddenCount: Generated<number>;
  uploadCount: Generated<number>;
  reviewCount: Generated<number>;
  answerCount: Generated<number>;
  answerAcceptCount: Generated<number>;
  updatedAt: Generated<Timestamp>;
};
export type UserNotificationSettings = {
  id: Generated<number>;
  userId: number;
  type: string;
  disabledAt: Generated<Timestamp>;
};
export type UserProfile = {
  userId: number;
  coverImageId: number | null;
  bio: string | null;
  message: string | null;
  messageAddedAt: Timestamp | null;
  location: string | null;
  nsfw: Generated<boolean>;
  privacySettings: Generated<unknown>;
  profileSectionsSettings: Generated<unknown>;
  showcaseItems: Generated<unknown>;
};
export type UserPurchasedRewards = {
  buzzTransactionId: string;
  userId: number | null;
  purchasableRewardId: number | null;
  createdAt: Generated<Timestamp>;
  meta: Generated<unknown>;
  code: string;
};
export type UserRank = {
  userId: number;
  downloadCountDayRank: Generated<number>;
  downloadCountWeekRank: Generated<number>;
  downloadCountMonthRank: Generated<number>;
  downloadCountYearRank: Generated<number>;
  downloadCountAllTimeRank: Generated<number>;
  ratingCountDayRank: Generated<number>;
  ratingCountWeekRank: Generated<number>;
  ratingCountMonthRank: Generated<number>;
  ratingCountYearRank: Generated<number>;
  ratingCountAllTimeRank: Generated<number>;
  followerCountDayRank: Generated<number>;
  followerCountWeekRank: Generated<number>;
  followerCountMonthRank: Generated<number>;
  followerCountYearRank: Generated<number>;
  followerCountAllTimeRank: Generated<number>;
  ratingDayRank: Generated<number>;
  ratingWeekRank: Generated<number>;
  ratingMonthRank: Generated<number>;
  ratingYearRank: Generated<number>;
  ratingAllTimeRank: Generated<number>;
  favoriteCountDayRank: Generated<number>;
  favoriteCountWeekRank: Generated<number>;
  favoriteCountMonthRank: Generated<number>;
  favoriteCountYearRank: Generated<number>;
  favoriteCountAllTimeRank: Generated<number>;
  answerCountDayRank: Generated<number>;
  answerCountWeekRank: Generated<number>;
  answerCountMonthRank: Generated<number>;
  answerCountYearRank: Generated<number>;
  answerCountAllTimeRank: Generated<number>;
  answerAcceptCountDayRank: Generated<number>;
  answerAcceptCountWeekRank: Generated<number>;
  answerAcceptCountMonthRank: Generated<number>;
  answerAcceptCountYearRank: Generated<number>;
  answerAcceptCountAllTimeRank: Generated<number>;
  thumbsUpCountDayRank: Generated<number>;
  thumbsUpCountWeekRank: Generated<number>;
  thumbsUpCountMonthRank: Generated<number>;
  thumbsUpCountYearRank: Generated<number>;
  thumbsUpCountAllTimeRank: Generated<number>;
  thumbsDownCountDayRank: Generated<number>;
  thumbsDownCountWeekRank: Generated<number>;
  thumbsDownCountMonthRank: Generated<number>;
  thumbsDownCountYearRank: Generated<number>;
  thumbsDownCountAllTimeRank: Generated<number>;
  leaderboardRank: number | null;
  leaderboardId: string | null;
  leaderboardTitle: string | null;
  leaderboardCosmetic: string | null;
};
export type UserReferral = {
  id: Generated<number>;
  userReferralCodeId: number | null;
  source: string | null;
  landingPage: string | null;
  loginRedirectReason: string | null;
  createdAt: Generated<Timestamp>;
  userId: number;
  note: string | null;
};
export type UserReferralCode = {
  id: Generated<number>;
  userId: number;
  code: string;
  note: string | null;
  deletedAt: Timestamp | null;
  createdAt: Generated<Timestamp>;
};
export type UserReport = {
  userId: number;
  reportId: number;
};
export type UserStat = {
  userId: number;
  uploadCountDay: number;
  uploadCountWeek: number;
  uploadCountMonth: number;
  uploadCountYear: number;
  uploadCountAllTime: number;
  reviewCountDay: number;
  reviewCountWeek: number;
  reviewCountMonth: number;
  reviewCountYear: number;
  reviewCountAllTime: number;
  downloadCountDay: number;
  downloadCountWeek: number;
  downloadCountMonth: number;
  downloadCountYear: number;
  downloadCountAllTime: number;
  generationCountDay: number;
  generationCountWeek: number;
  generationCountMonth: number;
  generationCountYear: number;
  generationCountAllTime: number;
  ratingCountDay: number;
  ratingCountWeek: number;
  ratingCountMonth: number;
  ratingCountYear: number;
  ratingCountAllTime: number;
  followingCountDay: number;
  followingCountWeek: number;
  followingCountMonth: number;
  followingCountYear: number;
  followingCountAllTime: number;
  followerCountDay: number;
  followerCountWeek: number;
  followerCountMonth: number;
  followerCountYear: number;
  followerCountAllTime: number;
  hiddenCountDay: number;
  hiddenCountWeek: number;
  hiddenCountMonth: number;
  hiddenCountYear: number;
  hiddenCountAllTime: number;
  ratingDay: number;
  ratingWeek: number;
  ratingMonth: number;
  ratingYear: number;
  ratingAllTime: number;
  favoriteCountDay: number;
  favoriteCountWeek: number;
  favoriteCountMonth: number;
  favoriteCountYear: number;
  favoriteCountAllTime: number;
  answerCountDay: number;
  answerCountWeek: number;
  answerCountMonth: number;
  answerCountYear: number;
  answerCountAllTime: number;
  answerAcceptCountDay: number;
  answerAcceptCountWeek: number;
  answerAcceptCountMonth: number;
  answerAcceptCountYear: number;
  answerAcceptCountAllTime: number;
  thumbsUpCountDay: number;
  thumbsUpCountWeek: number;
  thumbsUpCountMonth: number;
  thumbsUpCountYear: number;
  thumbsUpCountAllTime: number;
  thumbsDownCountDay: number;
  thumbsDownCountWeek: number;
  thumbsDownCountMonth: number;
  thumbsDownCountYear: number;
  thumbsDownCountAllTime: number;
  reactionCountDay: number;
  reactionCountWeek: number;
  reactionCountMonth: number;
  reactionCountYear: number;
  reactionCountAllTime: number;
};
export type UserStripeConnect = {
  userId: number;
  connectedAccountId: string;
  status: Generated<StripeConnectStatus>;
  payoutsEnabled: Generated<boolean>;
  chargesEnabled: Generated<boolean>;
};
export type Vault = {
  userId: number;
  storageKb: number;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  meta: Generated<unknown>;
};
export type VaultItem = {
  id: Generated<number>;
  vaultId: number;
  status: Generated<VaultItemStatus>;
  files: Generated<unknown>;
  modelVersionId: number;
  modelId: number;
  modelName: string;
  versionName: string;
  creatorId: number | null;
  creatorName: string;
  type: ModelType;
  baseModel: string;
  category: string;
  createdAt: Generated<Timestamp>;
  addedAt: Generated<Timestamp>;
  refreshedAt: Timestamp | null;
  modelSizeKb: number;
  detailsSizeKb: number;
  imagesSizeKb: number;
  notes: string | null;
  meta: Generated<unknown>;
};
export type VerificationToken = {
  identifier: string;
  token: string;
  expires: Timestamp;
};
export type Webhook = {
  id: Generated<number>;
  url: string;
  notifyOn: string[];
  active: Generated<boolean>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  userId: number;
};
export type DB = {
  _LicenseToModel: LicenseToModel;
  Account: Account;
  Announcement: Announcement;
  Answer: Answer;
  AnswerMetric: AnswerMetric;
  AnswerRank: AnswerRank;
  AnswerReaction: AnswerReaction;
  AnswerVote: AnswerVote;
  ApiKey: ApiKey;
  Article: Article;
  ArticleEngagement: ArticleEngagement;
  ArticleMetric: ArticleMetric;
  ArticleRank: ArticleRank;
  ArticleReaction: ArticleReaction;
  ArticleReport: ArticleReport;
  ArticleStat: ArticleStat;
  BlockedImage: BlockedImage;
  Bounty: Bounty;
  BountyBenefactor: BountyBenefactor;
  BountyEngagement: BountyEngagement;
  BountyEntry: BountyEntry;
  BountyEntryMetric: BountyEntryMetric;
  BountyEntryRank: BountyEntryRank;
  BountyEntryReaction: BountyEntryReaction;
  BountyEntryReport: BountyEntryReport;
  BountyEntryStat: BountyEntryStat;
  BountyMetric: BountyMetric;
  BountyRank: BountyRank;
  BountyReport: BountyReport;
  BountyStat: BountyStat;
  BuildGuide: BuildGuide;
  BuzzClaim: BuzzClaim;
  BuzzTip: BuzzTip;
  BuzzWithdrawalRequest: BuzzWithdrawalRequest;
  BuzzWithdrawalRequestHistory: BuzzWithdrawalRequestHistory;
  Chat: Chat;
  ChatMember: ChatMember;
  ChatMessage: ChatMessage;
  ChatReport: ChatReport;
  Club: Club;
  ClubAdmin: ClubAdmin;
  ClubAdminInvite: ClubAdminInvite;
  ClubMembership: ClubMembership;
  ClubMembershipCharge: ClubMembershipCharge;
  ClubMetric: ClubMetric;
  ClubPost: ClubPost;
  ClubPostMetric: ClubPostMetric;
  ClubPostReaction: ClubPostReaction;
  ClubRank: ClubRank;
  ClubStat: ClubStat;
  ClubTier: ClubTier;
  Collection: Collection;
  CollectionContributor: CollectionContributor;
  CollectionItem: CollectionItem;
  CollectionMetric: CollectionMetric;
  CollectionRank: CollectionRank;
  CollectionReport: CollectionReport;
  CollectionStat: CollectionStat;
  Comment: Comment;
  CommentReaction: CommentReaction;
  CommentReport: CommentReport;
  CommentV2: CommentV2;
  CommentV2Reaction: CommentV2Reaction;
  CommentV2Report: CommentV2Report;
  Cosmetic: Cosmetic;
  CosmeticShopItem: CosmeticShopItem;
  CosmeticShopSection: CosmeticShopSection;
  CosmeticShopSectionItem: CosmeticShopSectionItem;
  CsamReport: CsamReport;
  CustomerSubscription: CustomerSubscription;
  Donation: Donation;
  DonationGoal: DonationGoal;
  DownloadHistory: DownloadHistory;
  EntityAccess: EntityAccess;
  EntityCollaborator: EntityCollaborator;
  EntityMetric: EntityMetric;
  EntityMetricImage: EntityMetricImage;
  File: File;
  GenerationCoverage: GenerationCoverage;
  GenerationServiceProvider: GenerationServiceProvider;
  HomeBlock: HomeBlock;
  Image: Image;
  ImageConnection: ImageConnection;
  ImageEngagement: ImageEngagement;
  ImageMetric: ImageMetric;
  ImageModHelper: ImageModHelper;
  ImageRatingRequest: ImageRatingRequest;
  ImageReaction: ImageReaction;
  ImageReport: ImageReport;
  ImageResource: ImageResource;
  ImageResourceHelper: ImageResourceHelper;
  ImageStat: ImageStat;
  ImageTag: ImageTag;
  ImageTechnique: ImageTechnique;
  ImageTool: ImageTool;
  Import: Import;
  JobQueue: JobQueue;
  KeyValue: KeyValue;
  Leaderboard: Leaderboard;
  LeaderboardResult: LeaderboardResult;
  License: License;
  Link: Link;
  Log: Log;
  ModActivity: ModActivity;
  Model: Model;
  ModelAssociations: ModelAssociations;
  ModelEngagement: ModelEngagement;
  ModelFile: ModelFile;
  ModelFileHash: ModelFileHash;
  ModelHash: ModelHash;
  ModelInterest: ModelInterest;
  ModelMetric: ModelMetric;
  ModelMetricDaily: ModelMetricDaily;
  ModelReport: ModelReport;
  ModelReportStat: ModelReportStat;
  ModelTag: ModelTag;
  ModelVersion: ModelVersion;
  ModelVersionEngagement: ModelVersionEngagement;
  ModelVersionExploration: ModelVersionExploration;
  ModelVersionMetric: ModelVersionMetric;
  ModelVersionMonetization: ModelVersionMonetization;
  ModelVersionSponsorshipSettings: ModelVersionSponsorshipSettings;
  Partner: Partner;
  Post: Post;
  PostHelper: PostHelper;
  PostImageTag: PostImageTag;
  PostMetric: PostMetric;
  PostRank: PostRank;
  PostReaction: PostReaction;
  PostReport: PostReport;
  PostResourceHelper: PostResourceHelper;
  PostStat: PostStat;
  PostTag: PostTag;
  PressMention: PressMention;
  Price: Price;
  Product: Product;
  PurchasableReward: PurchasableReward;
  Purchase: Purchase;
  QueryDurationLog: QueryDurationLog;
  QueryParamsLog: QueryParamsLog;
  QuerySqlLog: QuerySqlLog;
  Question: Question;
  QuestionMetric: QuestionMetric;
  QuestionRank: QuestionRank;
  QuestionReaction: QuestionReaction;
  RecommendedResource: RecommendedResource;
  RedeemableCode: RedeemableCode;
  Report: Report;
  ResourceReview: ResourceReview;
  ResourceReviewHelper: ResourceReviewHelper;
  ResourceReviewReaction: ResourceReviewReaction;
  ResourceReviewReport: ResourceReviewReport;
  RunStrategy: RunStrategy;
  SavedModel: SavedModel;
  Session: Session;
  SessionInvalidation: SessionInvalidation;
  Tag: Tag;
  TagEngagement: TagEngagement;
  TagMetric: TagMetric;
  TagRank: TagRank;
  TagsOnArticle: TagsOnArticle;
  TagsOnBounty: TagsOnBounty;
  TagsOnCollection: TagsOnCollection;
  TagsOnImage: TagsOnImage;
  TagsOnImageVote: TagsOnImageVote;
  TagsOnModels: TagsOnModels;
  TagsOnModelsVote: TagsOnModelsVote;
  TagsOnPost: TagsOnPost;
  TagsOnPostVote: TagsOnPostVote;
  TagsOnQuestions: TagsOnQuestions;
  TagsOnTags: TagsOnTags;
  TagStat: TagStat;
  Technique: Technique;
  Thread: Thread;
  TipConnection: TipConnection;
  Tool: Tool;
  User: User;
  UserCosmetic: UserCosmetic;
  UserCosmeticShopPurchases: UserCosmeticShopPurchases;
  UserEngagement: UserEngagement;
  UserLink: UserLink;
  UserMetric: UserMetric;
  UserNotificationSettings: UserNotificationSettings;
  UserProfile: UserProfile;
  UserPurchasedRewards: UserPurchasedRewards;
  UserRank: UserRank;
  UserReferral: UserReferral;
  UserReferralCode: UserReferralCode;
  UserReport: UserReport;
  UserStat: UserStat;
  UserStripeConnect: UserStripeConnect;
  Vault: Vault;
  VaultItem: VaultItem;
  VerificationToken: VerificationToken;
  Webhook: Webhook;
};
