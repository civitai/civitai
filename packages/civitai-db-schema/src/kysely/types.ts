import type { ColumnType } from 'kysely';
export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

import type {
  ReferralRewardStatus,
  ReferralRewardKind,
  ReferralRedemptionType,
  BuzzWithdrawalRequestStatus,
  UserPaymentConfigurationProvider,
  CashWithdrawalStatus,
  CashWithdrawalMethod,
  CryptoTransactionStatus,
  RewardsEligibility,
  PaymentProvider,
  UserEngagementType,
  LinkType,
  ModelType,
  ImportStatus,
  ModelStatus,
  TrainingStatus,
  CommercialUse,
  CheckpointType,
  ModelUploadType,
  ModelUsageControl,
  ModelModifier,
  ContentType,
  ModelFlagStatus,
  ModelEngagementType,
  ModelVersionSponsorshipSettingsType,
  ModelVersionMonetizationType,
  LicensingFeeType,
  LicensingFeeSettlementCurrency,
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
  EntityModerationStatus,
  ImageEngagementType,
  ImageOnModelType,
  TagTarget,
  TagType,
  TagsOnTagsType,
  TagSource,
  PartnerPricingModel,
  ApiKeyType,
  TagEngagementType,
  DomainColor,
  CosmeticType,
  CosmeticSource,
  CosmeticShopItemStatus,
  CosmeticEntity,
  BuzzAccountType,
  ArticleStatus,
  ArticleIngestionStatus,
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
  AppealStatus,
  AuctionType,
  ModerationRuleAction,
  ChangelogType,
  NewOrderRankType,
  ChallengeSource,
  ChallengeStatus,
  PrizeMode,
  PoolTrigger,
  ChallengeReviewCostType,
  EntityMetric_EntityType_Type,
  EntityMetric_MetricType_Type,
  ComicProjectStatus,
  ComicReferenceStatus,
  ComicPanelStatus,
  ComicChapterStatus,
  ComicReferenceType,
  ComicEngagementType,
  ComicGenre,
  UserRestrictionStatus,
  StrikeReason,
  StrikeStatus,
  WildcardSetKind,
  WildcardSetAuditStatus,
  WildcardSetCategoryAuditStatus,
  ReviewVerdict,
  Model3DStatus,
  Model3DEngagementType,
  ShopifyMerchOrderStatus,
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
export type AdToken = {
  id: Generated<number>;
  token: string;
  userId: number;
  createdAt: Generated<Timestamp>;
  expiresAt: Timestamp | null;
};
export type Announcement = {
  id: Generated<number>;
  title: string;
  content: string;
  emoji: string | null;
  color: Generated<string>;
  domain: Generated<DomainColor[]>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  startsAt: Timestamp | null;
  endsAt: Timestamp | null;
  metadata: unknown | null;
  disabled: Generated<boolean>;
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
  tokenScope: Generated<number>;
  userId: number;
  createdAt: Generated<Timestamp>;
  type: Generated<ApiKeyType>;
  expiresAt: Timestamp | null;
  lastUsedAt: Timestamp | null;
  clientId: string | null;
  buzzLimit: unknown | null;
};
export type AppBlock = {
  id: string;
  app_id: string;
  block_id: string;
  version: string;
  manifest: unknown;
  status: Generated<string>;
  content_rating: string;
  promotion_eligible: Generated<boolean>;
  health_status: Generated<string>;
  health_checked_at: Timestamp | null;
  render_mode: Generated<string>;
  trust_tier: Generated<string>;
  asset_bundle_url: string | null;
  asset_bundle_sha256: string | null;
  approved_scopes: Generated<string[]>;
  current_version_sha: string | null;
  current_version_deployed_at: Timestamp | null;
  repo_url: string | null;
  category: string | null;
  featured: Generated<boolean>;
  featured_order: number | null;
  screenshots: unknown | null;
  external_url: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
};
export type AppBlockPublishRequest = {
  id: string;
  app_block_id: string | null;
  slug: string;
  submitted_by_user_id: number;
  submitted_at: Generated<Timestamp>;
  version: string;
  manifest: unknown;
  bundle_key: string;
  bundle_sha256: string;
  bundle_size_bytes: string;
  file_summary: unknown;
  manifest_diff_summary: unknown;
  status: string;
  reviewed_by_user_id: number | null;
  reviewed_at: Timestamp | null;
  rejection_reason: string | null;
  approval_notes: string | null;
  forgejo_commit_sha: string | null;
  deploy_state: string | null;
  deploy_detail: string | null;
  deploy_updated_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
};
export type AppBlockReview = {
  id: Generated<number>;
  app_block_id: string;
  user_id: number;
  rating: number;
  recommended: Generated<boolean>;
  details: string | null;
  exclude: Generated<boolean>;
  tos_violation: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
};
export type AppDevForgejoIdentity = {
  user_id: number;
  forgejo_username: string;
  forgejo_token_encrypted: string;
  created_at: Generated<Timestamp>;
};
export type Appeal = {
  id: Generated<number>;
  userId: number;
  entityType: EntityType;
  entityId: number;
  status: Generated<AppealStatus>;
  appealMessage: string;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  resolvedAt: Timestamp | null;
  resolvedBy: number | null;
  resolvedMessage: string | null;
  internalNotes: string | null;
  buzzTransactionId: string | null;
};
export type AppListing = {
  id: string;
  kind: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  icon_id: number | null;
  cover_id: number | null;
  category: string | null;
  status: Generated<string>;
  content_rating: string | null;
  external_url: string | null;
  connect_client_id: string | null;
  app_block_id: string | null;
  featured: Generated<boolean>;
  featured_order: number | null;
  user_id: number;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
};
export type AppListingMetric = {
  app_listing_id: string;
  thumbs_up_count: Generated<number>;
  thumbs_down_count: Generated<number>;
  install_count: Generated<number>;
  open_count: Generated<number>;
  connect_count: Generated<number>;
  visit_count: Generated<number>;
  tipped_count: Generated<number>;
  tipped_amount_count: Generated<number>;
  updated_at: Generated<Timestamp>;
};
export type AppListingPublishRequest = {
  id: string;
  app_listing_id: string | null;
  kind: string;
  slug: string;
  submitted_by_user_id: number;
  submitted_at: Generated<Timestamp>;
  status: string;
  reviewed_by_user_id: number | null;
  reviewed_at: Timestamp | null;
  rejection_reason: string | null;
  approval_notes: string | null;
  changelog: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
};
export type AppListingReview = {
  id: Generated<number>;
  app_listing_id: string;
  user_id: number;
  recommended: boolean;
  details: string | null;
  exclude: Generated<boolean>;
  tos_violation: Generated<boolean>;
  metadata: unknown | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
};
export type AppListingScreenshot = {
  id: string;
  app_listing_id: string;
  image_id: number | null;
  order: Generated<number>;
  caption: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
};
export type AppUserScopeGrant = {
  id: string;
  user_id: number;
  app_block_id: string;
  version: string;
  granted_scopes: Generated<string[]>;
  granted_at: Generated<Timestamp>;
  revoked_at: Timestamp | null;
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
  contentScannedAt: Timestamp | null;
  ingestion: Generated<ArticleIngestionStatus>;
  scanRequestedAt: Timestamp | null;
  userId: number;
  availability: Generated<Availability>;
  unlisted: Generated<boolean>;
  nsfwLevel: Generated<number>;
  userNsfwLevel: Generated<number>;
  moderatorNsfwLevel: number | null;
  moderatorNsfwLevelBasis: number | null;
  lockedProperties: Generated<string[]>;
  status: Generated<ArticleStatus>;
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
export type ArticleRatingReview = {
  id: Generated<number>;
  articleId: number;
  userId: number;
  createdAt: Generated<Timestamp>;
  resolvedAt: Timestamp | null;
  resolvedBy: number | null;
  currentLevel: number;
  suggestedLevel: number;
  appliedLevel: number | null;
  userComment: string | null;
  modComment: string | null;
  status: Generated<ReportStatus>;
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
export type Auction = {
  id: Generated<number>;
  auctionBaseId: number;
  startAt: Timestamp;
  endAt: Timestamp;
  quantity: number;
  minPrice: number;
  validFrom: Timestamp;
  validTo: Timestamp;
  finalized: Generated<boolean>;
};
export type AuctionBase = {
  id: Generated<number>;
  type: AuctionType;
  ecosystem: string | null;
  name: string;
  slug: string;
  quantity: number;
  minPrice: number;
  active: Generated<boolean>;
  runForDays: Generated<number>;
  validForDays: Generated<number>;
  description: string | null;
};
export type BaseModelLicensingFee = {
  baseModel: string;
  modelType: ModelType;
  modelVersionId: number;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type Bid = {
  id: Generated<number>;
  auctionId: number;
  userId: number;
  entityId: number;
  amount: number;
  createdAt: Generated<Timestamp>;
  deleted: Generated<boolean>;
  transactionIds: Generated<string[]>;
  isRefunded: Generated<boolean>;
  fromRecurring: Generated<boolean>;
  accountType: Generated<string>;
};
export type BidRecurring = {
  id: Generated<number>;
  auctionBaseId: number;
  userId: number;
  entityId: number;
  amount: number;
  createdAt: Generated<Timestamp>;
  startAt: Timestamp;
  endAt: Timestamp | null;
  isPaused: Generated<boolean>;
  accountType: Generated<string>;
};
export type BlockAttributionPayout = {
  id: string;
  app_owner_user_id: number;
  /**
   * Caller-supplied period bucket, e.g. ISO week '2026-W22'. The
   * (owner, period) pair is the idempotency key.
   */
  period_key: string;
  /**
   * Net publisher share minted for this period (sum of contributing
   * confirmed rows' app_owner_share_cents, after clawbacks net out).
   */
  total_cents: number;
  /**
   * Number of block_buzz_attribution rows flipped to paid_out by this mint.
   */
  row_count: number;
  created_at: Generated<Timestamp>;
};
export type BlockBuzzAttribution = {
  id: string;
  user_id: number;
  buzz_amount: number;
  usd_amount_cents: number;
  buzz_type: Generated<string>;
  payment_provider: string;
  payment_transaction_id: string;
  buzz_transaction_id: string | null;
  app_id: string;
  app_block_id: string;
  block_instance_id: string;
  scope: string;
  model_id: number | null;
  rate_card_version: string;
  app_owner_share_cents: number;
  platform_share_cents: number;
  provider_fee_cents: number;
  app_owner_user_id: number;
  status: Generated<string>;
  voided_reason: string | null;
  hold_reason: string | null;
  held_at: Timestamp | null;
  entry_type: Generated<string>;
  attributed_at: Generated<Timestamp>;
  confirmed_at: Timestamp | null;
  voided_at: Timestamp | null;
  paid_out_at: Timestamp | null;
  payout_id: string | null;
};
export type BlockedImage = {
  hash: string;
  reason: Generated<BlockImageReason>;
  createdAt: Generated<Timestamp>;
};
export type Blocklist = {
  id: Generated<number>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  type: string;
  data: string[];
};
export type BlockScopeInvocation = {
  id: Generated<string>;
  user_id: number;
  app_block_id: string;
  block_instance_id: string;
  scope: string;
  endpoint: string;
  status_code: number;
  invoked_at: Generated<Timestamp>;
};
export type BlockSpendAttribution = {
  id: string;
  user_id: number;
  buzz_amount: number;
  buzz_type: Generated<string>;
  /**
   * USD value of the Buzz burned (buzzDollarRatio 1000:1 -> cents).
   * Recorded for reporting — it is platform revenue, NOT a split pool.
   */
  gross_value_cents: number;
  /**
   * Orchestrator workflow id — the idempotency anchor.
   */
  workflow_id: string;
  app_id: string;
  app_block_id: string;
  block_instance_id: string;
  model_id: number | null;
  rate_card_version: string;
  /**
   * The spend rev-share percentage stamped at write time.
   */
  spend_share_pct: number;
  app_owner_share_cents: number;
  app_owner_user_id: number;
  status: Generated<string>;
  /**
   * 'self_spend' / 'internal_owner' / 'manual_review'. Spend has no
   * refund path, so this is never 'refund'/'chargeback'.
   */
  voided_reason: string | null;
  attributed_at: Generated<Timestamp>;
  confirmed_at: Timestamp | null;
  voided_at: Timestamp | null;
  paid_out_at: Timestamp | null;
  payout_id: string | null;
};
export type BlockSubscriptionAttribution = {
  id: string;
  user_id: number;
  buzz_amount: Generated<number>;
  buzz_type: Generated<string>;
  /**
   * Gross USD value of the invoice, in cents.
   */
  gross_value_cents: number;
  payment_provider: string;
  /**
   * Per-period idempotency anchor — each renewal has its own invoice_id.
   */
  invoice_id: string;
  /**
   * Groups the periods of one subscription.
   */
  subscription_id: string | null;
  /**
   * subscription_create | subscription_cycle | subscription_update.
   */
  billing_reason: string | null;
  period_start: Timestamp | null;
  period_end: Timestamp | null;
  app_id: string;
  app_block_id: string;
  block_instance_id: string;
  scope: string;
  model_id: number | null;
  tier: string | null;
  /**
   * TRACK-ONLY (#2629): no rate applied at write time. 'unrated' sentinel
   * until the payout-time backpay stamps the signed-off version.
   */
  rate_card_version: Generated<string>;
  /**
   * 0 at write time; the payout-time backpay computes the real share.
   */
  subscription_share_pct: Generated<number>;
  app_owner_share_cents: Generated<number>;
  platform_share_cents: number;
  provider_fee_cents: number;
  app_owner_user_id: number;
  /**
   * 'tracked' (track-only event) | pending | confirmed | voided | paid_out | held.
   */
  status: Generated<string>;
  /**
   * 'charge' (forward) | 'clawback' (negative carry-forward on refund/proration).
   */
  entry_type: Generated<string>;
  /**
   * 'refund' / 'chargeback' / 'proration' / 'self_purchase' / 'internal_owner' / 'manual_review'.
   */
  voided_reason: string | null;
  attributed_at: Generated<Timestamp>;
  confirmed_at: Timestamp | null;
  voided_at: Timestamp | null;
  paid_out_at: Timestamp | null;
  payout_id: string | null;
};
export type BlockUserSettings = {
  block_instance_id: string;
  user_id: number;
  settings: Generated<unknown>;
  updated_at: Generated<Timestamp>;
};
export type BlockUserSubscription = {
  id: string;
  user_id: number;
  app_block_id: string;
  scope: string;
  target_model_types: string[];
  target_base_models: string[];
  /**
   * NEW (kill_per_model_installs): pin this subscription to specific model
   * ids. Empty = blanket (applies to every model that passes the type +
   * base-model filters). Non-empty + non-NULL slot_id = the per-model
   * install path that model_block_installs used to carry.
   */
  target_model_ids: Generated<number[]>;
  /**
   * NEW (kill_per_model_installs): when set, this subscription targets a
   * specific slot id (e.g. "model.sidebar_top"). When NULL, it applies to
   * every slot the manifest declares (the blanket-subscription shape).
   */
  slot_id: string | null;
  /**
   * NEW (kill_per_model_installs): copied from model_block_installs.pinned
   * _version. NULL = use the AppBlock's current approved manifest; semver
   * string = use that version's manifest from app_block_publish_requests.
   */
  pinned_version: string | null;
  /**
   * NEW (kill_per_model_installs): preserves the bki_* id from the migrated
   * install row so block_buzz_attribution, block_scope_invocations, and
   * block_user_settings continue to resolve. NULL for blanket
   * subscriptions (which synthesise bus_pub_* / bus_view_* on read).
   */
  block_instance_id: string | null;
  /**
   * NEW (kill_per_model_installs): mirrors model_block_installs.installed
   * _by_user_id. For migrated rows this equals user_id by construction;
   * kept as a separate column so future "installed by mod / installed via
   * admin tooling" cases are expressible without schema change.
   */
  installed_by_user_id: number | null;
  settings: Generated<unknown>;
  enabled: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
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
  buzzTransactionId: Generated<string[]>;
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
export type Bug = {
  id: Generated<number>;
  title: string;
  summary: string;
  content: string | null;
  status: Generated<string>;
  clickupUrl: string | null;
  firstSeenAt: Generated<Timestamp>;
  resolvedAt: Timestamp | null;
  publishedAt: Timestamp | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  disabled: Generated<boolean>;
  domain: Generated<DomainColor[]>;
  tags: Generated<string[]>;
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
  claimed: Generated<number>;
  limit: number | null;
  accountType: Generated<BuzzAccountType>;
  useMultiplier: Generated<boolean>;
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
  requestedToProvider: Generated<UserPaymentConfigurationProvider>;
  requestedToId: string;
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
export type CashWithdrawal = {
  id: string;
  transactionId: string | null;
  userId: number;
  amount: number;
  method: CashWithdrawalMethod;
  fee: number;
  status: CashWithdrawalStatus;
  note: string | null;
  metadata: Generated<unknown>;
  createdAt: Generated<Timestamp | null>;
  updatedAt: Timestamp | null;
};
export type Challenge = {
  id: Generated<number>;
  startsAt: Timestamp;
  endsAt: Timestamp;
  visibleAt: Timestamp;
  title: string;
  description: string | null;
  theme: string | null;
  invitation: string | null;
  coverImageId: number | null;
  nsfwLevel: Generated<number>;
  modelVersionIds: Generated<number[]>;
  allowedNsfwLevel: Generated<number>;
  judgingPrompt: string | null;
  reviewPercentage: Generated<number>;
  maxReviews: number | null;
  collectionId: number | null;
  maxEntriesPerUser: Generated<number>;
  prizes: Generated<unknown>;
  entryPrize: unknown | null;
  entryPrizeRequirement: Generated<number>;
  prizePool: Generated<number>;
  prizeMode: Generated<PrizeMode>;
  basePrizePool: Generated<number>;
  buzzPerAction: Generated<number>;
  poolTrigger: PoolTrigger | null;
  maxPrizePool: number | null;
  prizeDistribution: unknown | null;
  operationBudget: Generated<number>;
  operationSpent: Generated<number>;
  reviewCostType: Generated<ChallengeReviewCostType>;
  reviewCost: Generated<number>;
  createdById: number;
  source: Generated<ChallengeSource>;
  judgeId: number | null;
  status: Generated<ChallengeStatus>;
  metadata: unknown | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  eventId: number | null;
};
export type ChallengeEvent = {
  id: Generated<number>;
  title: string;
  description: string | null;
  titleColor: string | null;
  startDate: Timestamp;
  endDate: Timestamp;
  active: Generated<boolean>;
  winnerCooldownDays: number | null;
  createdById: number | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type ChallengeJudge = {
  id: Generated<number>;
  userId: number;
  name: string;
  bio: string | null;
  sourceCollectionId: number | null;
  systemPrompt: string | null;
  collectionPrompt: string | null;
  contentPrompt: string | null;
  reviewPrompt: string | null;
  reviewTemplate: string | null;
  winnerSelectionPrompt: string | null;
  active: Generated<boolean>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type ChallengeWinner = {
  id: Generated<number>;
  challengeId: number;
  userId: number;
  imageId: number | null;
  place: number;
  buzzAwarded: number;
  pointsAwarded: number;
  reason: string | null;
  createdAt: Generated<Timestamp>;
};
export type Changelog = {
  id: Generated<number>;
  title: string;
  content: string;
  link: string | null;
  cta: string | null;
  effectiveAt: Timestamp;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  type: ChangelogType;
  tags: Generated<string[]>;
  disabled: Generated<boolean>;
  titleColor: string | null;
  sticky: Generated<boolean>;
  domain: Generated<DomainColor[]>;
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
  model3dId: number | null;
  addedById: number | null;
  reviewedById: number | null;
  reviewedAt: Timestamp | null;
  note: string | null;
  status: Generated<CollectionItemStatus>;
  tagId: number | null;
};
export type CollectionItemScore = {
  userId: number;
  collectionItemId: number;
  score: number;
  createdAt: Generated<Timestamp>;
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
export type ComicChapter = {
  id: Generated<number>;
  projectId: number;
  name: Generated<string>;
  position: Generated<number>;
  status: Generated<ComicChapterStatus>;
  availability: Generated<Availability>;
  earlyAccessConfig: unknown | null;
  earlyAccessEndsAt: Timestamp | null;
  publishedAt: Timestamp | null;
  nsfwLevel: Generated<number>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type ComicChapterRead = {
  userId: number;
  chapterId: number;
  unread: Generated<boolean>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
};
export type ComicPanel = {
  id: Generated<number>;
  projectId: number;
  chapterPosition: number;
  imageId: number | null;
  prompt: string;
  enhancedPrompt: string | null;
  imageUrl: string | null;
  position: Generated<number>;
  status: Generated<ComicPanelStatus>;
  workflowId: string | null;
  civitaiJobId: string | null;
  errorMessage: string | null;
  metadata: unknown | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type ComicPanelReference = {
  panelId: number;
  referenceId: number;
};
export type ComicProject = {
  id: Generated<number>;
  userId: number;
  name: string;
  description: string | null;
  coverImageId: number | null;
  heroImageId: number | null;
  heroImagePosition: Generated<number>;
  status: Generated<ComicProjectStatus>;
  tosViolation: Generated<boolean>;
  meta: unknown | null;
  baseModel: string | null;
  genre: ComicGenre | null;
  nsfwLevel: Generated<number>;
  publishedAt: Timestamp | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type ComicProjectEngagement = {
  userId: number;
  projectId: number;
  type: Generated<ComicEngagementType>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
};
export type ComicProjectMetric = {
  comicProjectId: number;
  updatedAt: Generated<Timestamp>;
  tippedCount: Generated<number>;
  tippedAmountCount: Generated<number>;
  followerCount: Generated<number>;
  hiddenCount: Generated<number>;
  readerCount: Generated<number>;
  chapterReadCount: Generated<number>;
};
export type ComicProjectReference = {
  projectId: number;
  referenceId: number;
  createdAt: Generated<Timestamp>;
};
export type ComicProjectReport = {
  comicProjectId: number;
  reportId: number;
};
export type ComicReference = {
  id: Generated<number>;
  userId: number;
  name: string;
  type: Generated<ComicReferenceType>;
  description: string | null;
  status: Generated<ComicReferenceStatus>;
  errorMessage: string | null;
  buzzCost: Generated<number>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type ComicReferenceImage = {
  referenceId: number;
  imageId: number;
  position: Generated<number>;
  createdAt: Generated<Timestamp>;
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
  pinnedAt: Timestamp | null;
  reactionCount: Generated<number>;
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
  createdById: number | null;
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
  status: Generated<CosmeticShopItemStatus>;
  reviewedById: number | null;
  reviewedAt: Timestamp | null;
  rejectionReason: string | null;
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
export type CoveredCheckpoint = {
  model_id: number;
  version_id: number;
};
export type CryptoDeposit = {
  paymentId: string;
  userId: number;
  status: Generated<string>;
  payCurrency: string;
  payAmount: number | null;
  outcomeAmount: number | null;
  buzzCredited: number | null;
  bonusBuzz: number | null;
  multiplier: number | null;
  depositFee: number | null;
  serviceFee: number | null;
  feeCurrency: string | null;
  paidFiat: number | null;
  chain: string | null;
  retryCount: Generated<number>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type CryptoTransaction = {
  key: string;
  userId: number;
  status: Generated<CryptoTransactionStatus>;
  amount: number;
  currency: Generated<Currency>;
  sweepTxHash: string | null;
  note: string | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type CryptoWallet = {
  userId: number;
  chain: Generated<string>;
  wallet: string;
  smartAccount: string | null;
  payCurrency: Generated<string>;
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
  buzzType: Generated<string>;
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
export type EcosystemCheckpoints = {
  id: number;
  name: string;
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
export type EntityModeration = {
  id: Generated<number>;
  entityType: string;
  entityId: number;
  workflowId: string | null;
  status: Generated<EntityModerationStatus>;
  retryCount: Generated<number>;
  blocked: boolean | null;
  triggeredLabels: Generated<string[]>;
  result: unknown | null;
  contentHash: string | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type FeaturedModelVersion = {
  id: Generated<number>;
  modelVersionId: number;
  validFrom: Timestamp;
  validTo: Timestamp;
  position: number;
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
export type GenerationBaseModel = {
  baseModel: string;
};
export type GenerationCoverage = {
  modelId: number;
  modelVersionId: number;
  covered: boolean;
};
export type GenerationPreset = {
  id: Generated<number>;
  userId: number;
  name: string;
  description: string | null;
  ecosystem: string;
  values: unknown;
  sortOrder: Generated<number>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
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
  minor: Generated<boolean>;
  poi: Generated<boolean>;
  acceptableMinor: Generated<boolean>;
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
export type ImageFlag = {
  imageId: number;
  promptNsfw: Generated<boolean>;
  resourcesNsfw: Generated<boolean>;
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
  weight: Generated<number>;
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
  imageId: number;
  reviewId: number | null;
  reviewRating: number | null;
  reviewDetails: string | null;
  reviewCreatedAt: Timestamp | null;
  name: string | null;
  modelVersionId: number;
  modelVersionName: string | null;
  modelVersionCreatedAt: Timestamp | null;
  modelId: number | null;
  modelName: string | null;
  modelDownloadCount: number | null;
  modelCommentCount: number | null;
  modelThumbsUpCount: number | null;
  modelThumbsDownCount: number | null;
  modelType: ModelType | null;
  modelVersionBaseModel: string | null;
  detected: boolean | null;
};
export type ImageResourceNew = {
  imageId: number;
  modelVersionId: number;
  strength: number | null;
  detected: Generated<boolean>;
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
export type ImageTagForReview = {
  imageId: number;
  tagId: number;
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
  scannedAt: Timestamp | null;
  sfwOnly: Generated<boolean>;
  allowNoCredit: Generated<boolean>;
  allowCommercialUse: Generated<CommercialUse[]>;
  allowDerivatives: Generated<boolean>;
  allowDifferentLicense: Generated<boolean>;
};
export type Model3D = {
  id: Generated<number>;
  name: string;
  description: string | null;
  userId: number;
  thumbnailImageId: number | null;
  licenseId: number;
  licenseDetails: string | null;
  workflowId: string | null;
  sourceImageId: number | null;
  generationParams: unknown | null;
  status: Generated<Model3DStatus>;
  nsfw: Generated<boolean>;
  tosViolation: Generated<boolean>;
  poi: Generated<boolean>;
  minor: Generated<boolean>;
  unlisted: Generated<boolean>;
  lockedProperties: Generated<string[]>;
  availability: Generated<Availability>;
  nsfwLevel: Generated<number>;
  meta: Generated<unknown>;
  gallerySettings: Generated<unknown>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  publishedAt: Timestamp | null;
  deletedAt: Timestamp | null;
  deletedBy: number | null;
};
export type Model3DEngagement = {
  userId: number;
  model3dId: number;
  type: Model3DEngagementType;
  createdAt: Generated<Timestamp>;
};
export type Model3DFile = {
  id: Generated<number>;
  model3dId: number;
  name: string;
  url: string;
  sizeKB: number;
  format: string;
  variant: Generated<string>;
  isPrimary: Generated<boolean>;
  metadata: unknown | null;
  virusScanResult: Generated<ScanResultCode>;
  virusScanMessage: string | null;
  rawScanResult: unknown | null;
  scannedAt: Timestamp | null;
  scanRequestedAt: Timestamp | null;
  exists: boolean | null;
  createdAt: Generated<Timestamp>;
};
export type Model3DLicense = {
  id: Generated<number>;
  name: string;
  description: string;
  allowCommercialUse: Generated<boolean>;
  allowPrintFarm: Generated<boolean>;
  allowDerivatives: Generated<boolean>;
  allowRedistribution: Generated<boolean>;
  requireAttribution: Generated<boolean>;
  isCustom: Generated<boolean>;
  createdAt: Generated<Timestamp>;
};
export type Model3DMetric = {
  model3dId: number;
  downloadCount: Generated<number>;
  commentCount: Generated<number>;
  collectedCount: Generated<number>;
  imageCount: Generated<number>;
  tippedCount: Generated<number>;
  tippedAmountCount: Generated<number>;
  ratingCount: Generated<number>;
  recommendedCount: Generated<number>;
  reactionCount: Generated<number>;
  earnedAmount: Generated<number>;
  updatedAt: Generated<Timestamp>;
  nsfwLevel: Generated<number>;
  userId: Generated<number>;
  status: Generated<Model3DStatus>;
  availability: Generated<Availability>;
  poi: Generated<boolean>;
  minor: Generated<boolean>;
};
export type Model3DReport = {
  model3dId: number;
  reportId: number;
};
export type Model3DReview = {
  id: Generated<number>;
  model3dId: number;
  userId: number;
  recommended: Generated<boolean>;
  details: string | null;
  nsfw: Generated<boolean>;
  tosViolation: Generated<boolean>;
  exclude: Generated<boolean>;
  metadata: unknown | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type Model3DReviewReport = {
  model3dReviewId: number;
  reportId: number;
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
export type ModelBaseModelMetric = {
  modelId: number;
  baseModel: string;
  thumbsUpCount: Generated<number>;
  downloadCount: Generated<number>;
  imageCount: Generated<number>;
  status: Generated<ModelStatus>;
  availability: Generated<Availability>;
  nsfwLevel: Generated<number>;
  mode: ModelModifier | null;
  poi: Generated<boolean>;
  minor: Generated<boolean>;
  updatedAt: Generated<Timestamp>;
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
export type ModelFlag = {
  modelId: number;
  poi: Generated<boolean>;
  minor: Generated<boolean>;
  sfwOnly: Generated<boolean>;
  nsfw: Generated<boolean>;
  triggerWords: Generated<boolean>;
  poiName: Generated<boolean>;
  status: Generated<ModelFlagStatus>;
  details: unknown | null;
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
  downloadCount: Generated<number>;
  commentCount: Generated<number>;
  collectedCount: Generated<number>;
  imageCount: Generated<number>;
  tippedCount: Generated<number>;
  tippedAmountCount: Generated<number>;
  generationCount: Generated<number>;
  thumbsUpCount: Generated<number>;
  thumbsDownCount: Generated<number>;
  earnedAmount: Generated<number>;
  updatedAt: Generated<Timestamp>;
  poi: Generated<boolean>;
  minor: Generated<boolean>;
  nsfwLevel: Generated<number>;
  userId: Generated<number>;
  lastVersionAt: Timestamp | null;
  mode: ModelModifier | null;
  status: Generated<ModelStatus>;
  availability: Generated<Availability>;
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
  baseModelType: Generated<string>;
  meta: Generated<unknown>;
  requireAuth: Generated<boolean>;
  settings: unknown | null;
  availability: Generated<Availability>;
  nsfwLevel: Generated<number>;
  earlyAccessEndsAt: Timestamp | null;
  earlyAccessConfig: unknown | null;
  uploadType: Generated<ModelUploadType>;
  usageControl: Generated<ModelUsageControl>;
  earlyAccessTimeFrame: Generated<number>;
  flags: Generated<number>;
  licensingFee: number | null;
  licensingFeeType: Generated<LicensingFeeType | null>;
  licensingFeeSettlementCurrency: Generated<LicensingFeeSettlementCurrency | null>;
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
  downloadCount: Generated<number>;
  commentCount: Generated<number>;
  collectedCount: Generated<number>;
  imageCount: Generated<number>;
  tippedCount: Generated<number>;
  tippedAmountCount: Generated<number>;
  generationCount: Generated<number>;
  thumbsUpCount: Generated<number>;
  thumbsDownCount: Generated<number>;
  earnedAmount: Generated<number>;
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
export type ModerationRule = {
  id: Generated<number>;
  entityType: EntityType;
  definition: unknown;
  action: ModerationRuleAction;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  enabled: Generated<boolean>;
  order: number | null;
  reason: string | null;
  createdById: number;
};
export type NewOrderPlayer = {
  userId: number;
  rankType: NewOrderRankType;
  startAt: Generated<Timestamp>;
  exp: Generated<number>;
  fervor: Generated<number>;
};
export type NewOrderRank = {
  type: NewOrderRankType;
  name: string;
  minExp: number;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  iconUrl: string | null;
};
export type NewOrderSmite = {
  id: Generated<number>;
  targetPlayerId: number;
  givenById: number;
  size: number;
  remaining: number;
  reason: string | null;
  createdAt: Generated<Timestamp>;
  cleansedAt: Timestamp | null;
  cleansedReason: string | null;
};
export type OauthClient = {
  id: string;
  secret: string | null;
  name: string;
  description: Generated<string>;
  logoUrl: string | null;
  redirectUris: Generated<string[]>;
  allowedOrigins: Generated<string[]>;
  grants: Generated<string[]>;
  allowedScopes: Generated<number>;
  isConfidential: Generated<boolean>;
  /**
   * Login gating: "open" (anyone), "testers" (only users holding the "tester" UserRole), "disabled" (no one).
   * Read by the auth hub's /authorize gate. First-party (spoke) clients have no row here, so are never gated.
   */
  accessMode: Generated<string>;
  userId: number;
  isVerified: Generated<boolean>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
};
export type OauthConsent = {
  id: Generated<number>;
  userId: number;
  clientId: string;
  scope: number;
  buzzLimit: unknown | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
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
  disabled: Generated<boolean>;
};
export type PlatformDefaultBlock = {
  app_block_id: string;
  slot_id: string;
  target_model_types: string[];
  min_content_rating: string | null;
  max_content_rating: string | null;
  priority: Generated<number>;
  enabled: Generated<boolean>;
  promoted_at: Generated<Timestamp>;
  promoted_by: number | null;
};
export type Post = {
  id: Generated<number>;
  nsfw: Generated<boolean>;
  title: string | null;
  detail: string | null;
  userId: number;
  modelVersionId: number | null;
  model3dId: number | null;
  model3dReviewId: number | null;
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
  ageGroup: Generated<MetricTimeframe>;
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
  postId: number;
  reviewId: number | null;
  reviewRating: number | null;
  reviewRecommended: boolean | null;
  reviewDetails: string | null;
  reviewCreatedAt: Timestamp | null;
  name: string | null;
  imageId: number;
  modelVersionId: number;
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
  provider: Generated<PaymentProvider>;
};
export type Product = {
  id: string;
  active: boolean;
  name: string;
  description: string | null;
  metadata: unknown;
  defaultPriceId: string | null;
  provider: Generated<PaymentProvider>;
};
export type PromptAllowlist = {
  id: Generated<number>;
  trigger: string;
  category: string;
  addedBy: number;
  reason: string | null;
  userRestrictionId: number | null;
  createdAt: Generated<Timestamp>;
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
  userId: number;
  productId: string | null;
  priceId: string | null;
  status: string | null;
  createdAt: Generated<Timestamp>;
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
  metadata: unknown | null;
  priceId: string | null;
};
export type ReferralAttribution = {
  id: Generated<number>;
  referralCodeId: number;
  refereeId: number;
  eventType: string;
  sourceEventId: string | null;
  tier: string | null;
  amount: number | null;
  paymentProvider: string | null;
  stripePaymentIntentId: string | null;
  stripeInvoiceId: string | null;
  stripeChargeId: string | null;
  paymentMethodFingerprint: string | null;
  ipAddress: string | null;
  metadata: Generated<unknown>;
  createdAt: Generated<Timestamp>;
};
export type ReferralMilestone = {
  id: Generated<number>;
  userId: number;
  threshold: number;
  bonusAmount: number;
  awardedAt: Generated<Timestamp>;
};
export type ReferralRedemption = {
  id: Generated<number>;
  userId: number;
  tokensSpent: number;
  rewardType: Generated<ReferralRedemptionType>;
  metadata: Generated<unknown>;
  createdAt: Generated<Timestamp>;
};
export type ReferralReward = {
  id: Generated<number>;
  userId: number;
  refereeId: number | null;
  kind: ReferralRewardKind;
  status: Generated<ReferralRewardStatus>;
  tokenAmount: Generated<number>;
  buzzAmount: Generated<number>;
  points: Generated<number>;
  tierGranted: string | null;
  sourceEventId: string;
  metadata: Generated<unknown>;
  earnedAt: Generated<Timestamp>;
  settledAt: Timestamp | null;
  redeemedAt: Timestamp | null;
  expiresAt: Timestamp | null;
  revokedAt: Timestamp | null;
  revokedReason: string | null;
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
export type ReportAutomated = {
  id: Generated<number>;
  reportId: number;
  metadata: Generated<unknown>;
  createdAt: Generated<Timestamp>;
};
export type ResourceOverride = {
  hash: string;
  modelVersionId: number;
  type: ModelHashType;
  createdAt: Generated<Timestamp>;
};
export type ResourceReview = {
  id: Generated<number>;
  modelId: number;
  modelVersionId: number;
  rating: number;
  recommended: Generated<boolean>;
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
export type RestrictedBaseModels = {
  baseModel: string;
};
export type RewardsBonusEvent = {
  id: Generated<number>;
  name: string;
  description: string | null;
  /**
   * Stored as multiplier * 10. e.g. 15 = 1.5x (50% MORE), 20 = 2x, 30 = 3x, 40 = 4x. Minimum effective value 10 (no bonus).
   */
  multiplier: number;
  articleId: number | null;
  bannerLabel: string | null;
  enabled: Generated<boolean>;
  startsAt: Timestamp | null;
  endsAt: Timestamp | null;
  createdById: number;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type Role = {
  id: string;
  description: string | null;
  createdById: number | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
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
export type ScannerContentSnapshot = {
  contentHash: string;
  scanner: string;
  content: unknown;
  createdAt: Generated<Timestamp>;
};
export type ScannerLabelReview = {
  id: Generated<number>;
  contentHash: string;
  version: string;
  label: string;
  reviewedBy: number;
  reviewedAt: Generated<Timestamp>;
  verdict: ReviewVerdict;
  note: string | null;
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
export type ShadowTagsOnImage = {
  imageId: number;
  tagId: number;
  confidence: number;
};
export type ShopifyCustomerLink = {
  id: Generated<number>;
  shopifyCustomerId: string;
  email: string;
  userId: number;
  createdAt: Generated<Timestamp>;
};
export type ShopifyMerchOrder = {
  id: Generated<number>;
  shopifyOrderId: string;
  email: string;
  shopifyCustomerId: string | null;
  subtotal: string;
  couponCodes: string[];
  buzzAmount: number;
  status: Generated<ShopifyMerchOrderStatus>;
  userId: number | null;
  grantedAt: Timestamp | null;
  createdAt: Generated<Timestamp>;
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
  filterableOnly: Generated<boolean>;
};
export type TagsOnImageDetails = {
  imageId: number;
  tagId: number;
  source: TagSource;
  automated: boolean;
  disabled: boolean;
  needsReview: boolean;
  reserved_1: boolean;
  reserved_2: boolean;
  confidence: number;
};
export type TagsOnImageNew = {
  imageId: number;
  tagId: number;
  attributes: number;
};
export type TagsOnImageVote = {
  imageId: number;
  tagId: number;
  userId: number;
  vote: number;
  createdAt: Generated<Timestamp>;
  applied: Generated<boolean>;
};
export type TagsOnModel3D = {
  model3dId: number;
  tagId: number;
  createdAt: Generated<Timestamp>;
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
  comicProjectId: number | null;
  comicChapterPosition: number | null;
  challengeId: number | null;
  model3dId: number | null;
  model3dReviewId: number | null;
  metadata: Generated<unknown>;
  commentCount: Generated<number>;
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
  unlisted: Generated<boolean>;
  type: ToolType;
  domain: string | null;
  priority: number | null;
  description: string | null;
  supported: Generated<boolean>;
  company: string | null;
  metadata: Generated<unknown>;
  alias: string | null;
};
export type TrustedSpokeDomain = {
  id: Generated<number>;
  domain: string;
  includeSubdomains: Generated<boolean>;
  label: string | null;
  enabled: Generated<boolean>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
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
  flags: Generated<number>;
  isModerator: Generated<boolean | null>;
  createdAt: Generated<Timestamp>;
  deletedAt: Timestamp | null;
  /**
   * Set on moderator mute-confirmation; cleared via trigger on unmute
   */
  mutedAt: Timestamp | null;
  muted: Generated<boolean>;
  /**
   * For timed mutes from strike escalation
   */
  muteExpiresAt: Timestamp | null;
  bannedAt: Timestamp | null;
  autoplayGifs: Generated<boolean | null>;
  filePreferences: Generated<unknown>;
  meta: Generated<unknown | null>;
  leaderboardShowcase: string | null;
  excludeFromLeaderboards: Generated<boolean>;
  rewardsEligibility: Generated<RewardsEligibility>;
  eligibilityChangedAt: Timestamp | null;
  customerId: string | null;
  paddleCustomerId: string | null;
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
export type UserPaymentConfiguration = {
  userId: number;
  tipaltiAccountId: string | null;
  tipaltiAccountStatus: Generated<string>;
  tipaltiPaymentsEnabled: Generated<boolean>;
  tipaltiWithdrawalMethod: CashWithdrawalMethod | null;
  stripeAccountId: string | null;
  stripeAccountStatus: Generated<string>;
  stripePaymentsEnabled: Generated<boolean>;
  meta: Generated<unknown>;
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
  firstPaidAt: Timestamp | null;
  paidMonthCount: Generated<number>;
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
export type UserRestriction = {
  id: Generated<number>;
  userId: number;
  type: Generated<string>;
  status: Generated<UserRestrictionStatus>;
  triggers: Generated<unknown>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
  resolvedAt: Timestamp | null;
  resolvedBy: number | null;
  resolvedMessage: string | null;
  userMessage: string | null;
  userMessageAt: Timestamp | null;
};
export type UserRole = {
  userId: number;
  role: string;
  note: string | null;
  addedById: number | null;
  createdAt: Generated<Timestamp>;
};
export type UserStat = {
  userId: number;
  uploadCountAllTime: number;
  reviewCountAllTime: number;
  downloadCountAllTime: number;
  generationCountAllTime: number;
  followingCountAllTime: number;
  followerCountAllTime: number;
  hiddenCountAllTime: number;
  answerCountAllTime: number;
  answerAcceptCountAllTime: number;
  thumbsUpCountAllTime: number;
  thumbsDownCountAllTime: number;
  reactionCountAllTime: number;
};
export type UserStrike = {
  id: Generated<number>;
  userId: number;
  reason: StrikeReason;
  status: Generated<StrikeStatus>;
  points: Generated<number>;
  description: string;
  internalNotes: string | null;
  entityType: EntityType | null;
  entityId: number | null;
  reportId: number | null;
  createdAt: Generated<Timestamp>;
  expiresAt: Timestamp;
  voidedAt: Timestamp | null;
  voidedBy: number | null;
  voidReason: string | null;
  issuedBy: number | null;
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
export type WildcardSet = {
  id: Generated<number>;
  kind: WildcardSetKind;
  modelVersionId: number | null;
  ownerUserId: number | null;
  name: string;
  auditStatus: Generated<WildcardSetAuditStatus>;
  auditRuleVersion: string | null;
  auditedAt: Timestamp | null;
  nsfw: Generated<boolean>;
  usable: Generated<boolean>;
  isInvalidated: Generated<boolean>;
  invalidationReason: string | null;
  invalidatedAt: Timestamp | null;
  metadata: unknown | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type WildcardSetCategory = {
  id: Generated<number>;
  wildcardSetId: number;
  name: string;
  values: string[];
  valueCount: Generated<number>;
  auditStatus: Generated<WildcardSetCategoryAuditStatus>;
  auditRuleVersion: string | null;
  auditedAt: Timestamp | null;
  auditNote: string | null;
  nsfw: Generated<boolean>;
  blocked: Generated<boolean>;
  metadata: unknown | null;
  displayOrder: Generated<number>;
  createdAt: Generated<Timestamp>;
  updatedAt: Timestamp;
};
export type DB = {
  _LicenseToModel: LicenseToModel;
  Account: Account;
  AdToken: AdToken;
  Announcement: Announcement;
  Answer: Answer;
  AnswerMetric: AnswerMetric;
  AnswerRank: AnswerRank;
  AnswerReaction: AnswerReaction;
  AnswerVote: AnswerVote;
  ApiKey: ApiKey;
  app_block_publish_requests: AppBlockPublishRequest;
  app_block_reviews: AppBlockReview;
  app_blocks: AppBlock;
  app_dev_forgejo_identity: AppDevForgejoIdentity;
  app_listing_metrics: AppListingMetric;
  app_listing_publish_requests: AppListingPublishRequest;
  app_listing_reviews: AppListingReview;
  app_listing_screenshots: AppListingScreenshot;
  app_listings: AppListing;
  app_user_scope_grants: AppUserScopeGrant;
  Appeal: Appeal;
  Article: Article;
  ArticleEngagement: ArticleEngagement;
  ArticleMetric: ArticleMetric;
  ArticleRank: ArticleRank;
  ArticleRatingReview: ArticleRatingReview;
  ArticleReaction: ArticleReaction;
  ArticleReport: ArticleReport;
  ArticleStat: ArticleStat;
  Auction: Auction;
  AuctionBase: AuctionBase;
  BaseModelLicensingFee: BaseModelLicensingFee;
  Bid: Bid;
  BidRecurring: BidRecurring;
  block_attribution_payout: BlockAttributionPayout;
  block_buzz_attribution: BlockBuzzAttribution;
  block_scope_invocations: BlockScopeInvocation;
  block_spend_attribution: BlockSpendAttribution;
  block_subscription_attribution: BlockSubscriptionAttribution;
  block_user_settings: BlockUserSettings;
  block_user_subscriptions: BlockUserSubscription;
  BlockedImage: BlockedImage;
  Blocklist: Blocklist;
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
  Bug: Bug;
  BuildGuide: BuildGuide;
  BuzzClaim: BuzzClaim;
  BuzzTip: BuzzTip;
  BuzzWithdrawalRequest: BuzzWithdrawalRequest;
  BuzzWithdrawalRequestHistory: BuzzWithdrawalRequestHistory;
  CashWithdrawal: CashWithdrawal;
  Challenge: Challenge;
  ChallengeEvent: ChallengeEvent;
  ChallengeJudge: ChallengeJudge;
  ChallengeWinner: ChallengeWinner;
  Changelog: Changelog;
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
  CollectionItemScore: CollectionItemScore;
  CollectionMetric: CollectionMetric;
  CollectionRank: CollectionRank;
  CollectionReport: CollectionReport;
  CollectionStat: CollectionStat;
  ComicChapter: ComicChapter;
  ComicChapterRead: ComicChapterRead;
  ComicPanel: ComicPanel;
  ComicPanelReference: ComicPanelReference;
  ComicProject: ComicProject;
  ComicProjectEngagement: ComicProjectEngagement;
  ComicProjectMetric: ComicProjectMetric;
  ComicProjectReference: ComicProjectReference;
  ComicProjectReport: ComicProjectReport;
  ComicReference: ComicReference;
  ComicReferenceImage: ComicReferenceImage;
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
  CoveredCheckpoint: CoveredCheckpoint;
  CryptoDeposit: CryptoDeposit;
  CryptoTransaction: CryptoTransaction;
  CryptoWallet: CryptoWallet;
  CsamReport: CsamReport;
  CustomerSubscription: CustomerSubscription;
  Donation: Donation;
  DonationGoal: DonationGoal;
  DownloadHistory: DownloadHistory;
  EcosystemCheckpoints: EcosystemCheckpoints;
  EntityAccess: EntityAccess;
  EntityCollaborator: EntityCollaborator;
  EntityMetric: EntityMetric;
  EntityMetricImage: EntityMetricImage;
  EntityModeration: EntityModeration;
  FeaturedModelVersion: FeaturedModelVersion;
  File: File;
  GenerationBaseModel: GenerationBaseModel;
  GenerationCoverage: GenerationCoverage;
  GenerationPreset: GenerationPreset;
  GenerationServiceProvider: GenerationServiceProvider;
  HomeBlock: HomeBlock;
  Image: Image;
  ImageConnection: ImageConnection;
  ImageEngagement: ImageEngagement;
  ImageFlag: ImageFlag;
  ImageModHelper: ImageModHelper;
  ImageRatingRequest: ImageRatingRequest;
  ImageReaction: ImageReaction;
  ImageReport: ImageReport;
  ImageResource: ImageResource;
  ImageResourceHelper: ImageResourceHelper;
  ImageResourceNew: ImageResourceNew;
  ImageTag: ImageTag;
  ImageTagForReview: ImageTagForReview;
  ImageTechnique: ImageTechnique;
  ImageTool: ImageTool;
  Import: Import;
  JobQueue: JobQueue;
  KeyValue: KeyValue;
  Leaderboard: Leaderboard;
  LeaderboardResult: LeaderboardResult;
  License: License;
  Link: Link;
  ModActivity: ModActivity;
  Model: Model;
  Model3D: Model3D;
  Model3DEngagement: Model3DEngagement;
  Model3DFile: Model3DFile;
  Model3DLicense: Model3DLicense;
  Model3DMetric: Model3DMetric;
  Model3DReport: Model3DReport;
  Model3DReview: Model3DReview;
  Model3DReviewReport: Model3DReviewReport;
  ModelAssociations: ModelAssociations;
  ModelBaseModelMetric: ModelBaseModelMetric;
  ModelEngagement: ModelEngagement;
  ModelFile: ModelFile;
  ModelFileHash: ModelFileHash;
  ModelFlag: ModelFlag;
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
  ModerationRule: ModerationRule;
  NewOrderPlayer: NewOrderPlayer;
  NewOrderRank: NewOrderRank;
  NewOrderSmite: NewOrderSmite;
  OauthClient: OauthClient;
  OauthConsent: OauthConsent;
  Partner: Partner;
  platform_default_blocks: PlatformDefaultBlock;
  Post: Post;
  PostHelper: PostHelper;
  PostImageTag: PostImageTag;
  PostMetric: PostMetric;
  PostReaction: PostReaction;
  PostReport: PostReport;
  PostResourceHelper: PostResourceHelper;
  PostStat: PostStat;
  PostTag: PostTag;
  PressMention: PressMention;
  Price: Price;
  Product: Product;
  PromptAllowlist: PromptAllowlist;
  PurchasableReward: PurchasableReward;
  Purchase: Purchase;
  Question: Question;
  QuestionMetric: QuestionMetric;
  QuestionRank: QuestionRank;
  QuestionReaction: QuestionReaction;
  RecommendedResource: RecommendedResource;
  RedeemableCode: RedeemableCode;
  ReferralAttribution: ReferralAttribution;
  ReferralMilestone: ReferralMilestone;
  ReferralRedemption: ReferralRedemption;
  ReferralReward: ReferralReward;
  Report: Report;
  ReportAutomated: ReportAutomated;
  ResourceOverride: ResourceOverride;
  ResourceReview: ResourceReview;
  ResourceReviewHelper: ResourceReviewHelper;
  ResourceReviewReaction: ResourceReviewReaction;
  ResourceReviewReport: ResourceReviewReport;
  RestrictedBaseModels: RestrictedBaseModels;
  RewardsBonusEvent: RewardsBonusEvent;
  Role: Role;
  RunStrategy: RunStrategy;
  SavedModel: SavedModel;
  ScannerContentSnapshot: ScannerContentSnapshot;
  ScannerLabelReview: ScannerLabelReview;
  Session: Session;
  SessionInvalidation: SessionInvalidation;
  ShadowTagsOnImage: ShadowTagsOnImage;
  ShopifyCustomerLink: ShopifyCustomerLink;
  ShopifyMerchOrder: ShopifyMerchOrder;
  Tag: Tag;
  TagEngagement: TagEngagement;
  TagMetric: TagMetric;
  TagRank: TagRank;
  TagsOnArticle: TagsOnArticle;
  TagsOnBounty: TagsOnBounty;
  TagsOnCollection: TagsOnCollection;
  TagsOnImageDetails: TagsOnImageDetails;
  TagsOnImageNew: TagsOnImageNew;
  TagsOnImageVote: TagsOnImageVote;
  TagsOnModel3D: TagsOnModel3D;
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
  TrustedSpokeDomain: TrustedSpokeDomain;
  User: User;
  UserCosmetic: UserCosmetic;
  UserCosmeticShopPurchases: UserCosmeticShopPurchases;
  UserEngagement: UserEngagement;
  UserLink: UserLink;
  UserMetric: UserMetric;
  UserNotificationSettings: UserNotificationSettings;
  UserPaymentConfiguration: UserPaymentConfiguration;
  UserProfile: UserProfile;
  UserPurchasedRewards: UserPurchasedRewards;
  UserRank: UserRank;
  UserReferral: UserReferral;
  UserReferralCode: UserReferralCode;
  UserReport: UserReport;
  UserRestriction: UserRestriction;
  UserRole: UserRole;
  UserStat: UserStat;
  UserStrike: UserStrike;
  Vault: Vault;
  VaultItem: VaultItem;
  VerificationToken: VerificationToken;
  Webhook: Webhook;
  WildcardSet: WildcardSet;
  WildcardSetCategory: WildcardSetCategory;
};
