export enum UploadType {
  Image = 'image',
  TrainingImages = 'training-images',
  TrainingImagesTemp = 'training-images-temp',
  Model = 'model',
  Default = 'default',
}

export type UploadTypeUnion = `${UploadType}`;

export enum ModelSort {
  HighestRated = 'Highest Rated',
  MostDownloaded = 'Most Downloaded',
  MostLiked = 'Most Liked',
  MostDiscussed = 'Most Discussed',
  MostCollected = 'Most Collected',
  ImageCount = 'Most Images',
  Newest = 'Newest',
  Oldest = 'Oldest',
}

export enum ReviewSort {
  Newest = 'newest',
  Oldest = 'oldest',
  MostLiked = 'most-liked',
  MostDisliked = 'most-disliked',
  MostComments = 'most-comments',
  Rating = 'rating',
}

export enum ReviewFilter {
  NSFW = 'nsfw',
  IncludesImages = 'includes-images',
}

export enum QuestionSort {
  Newest = 'Newest',
  MostLiked = 'Most Liked',
}

export enum QuestionStatus {
  Answered = 'Answered',
  Unanswered = 'Unanswered',
}

export enum ImageSort {
  MostReactions = 'Most Reactions',
  MostComments = 'Most Comments',
  MostCollected = 'Most Collected',
  Newest = 'Newest',
  Oldest = 'Oldest',
  Random = 'Random',
}

export const ImageSortHidden = {
  Random: ImageSort.Random,
};

export enum PostSort {
  MostReactions = 'Most Reactions',
  MostComments = 'Most Comments',
  MostCollected = 'Most Collected',
  Newest = 'Newest',
}

export enum ImageType {
  txt2img = 'txt2img',
  img2img = 'img2img',
  inpainting = 'inpainting',
}

export enum ImageResource {
  Manual = 'Manual',
  Automatic = 'Automatic',
}

export enum TagSort {
  MostModels = 'Most Models',
  MostImages = 'Most Images',
  MostPosts = 'Most Posts',
  MostArticles = 'Most Articles',
  MostHidden = 'Most Hidden',
}

export enum ImageScanType {
  Moderation = 0,
  Label = 1,
  FaceDetection = 2,
  WD14 = 3,
  Hash = 4,
  Hive = 5,
  MinorDetection = 6,
  HiveDemographics = 7,
  Clavata = 8,
  SpineRating = 9,
}

// export enum CommentV2Sort {
//   Newest = 'Newest',
//   Oldest = 'Oldest',
// }

export enum ArticleSort {
  MostBookmarks = 'Most Bookmarks',
  MostReactions = 'Most Reactions',
  MostComments = 'Most Comments',
  MostCollected = 'Most Collected',
  Newest = 'Newest',
  RecentlyUpdated = 'Recently Updated',
}

export enum CheckpointType {
  Trained = 'Trained',
  Merge = 'Merge',
}

export enum CollectionSort {
  MostContributors = 'Most Followers',
  Newest = 'Newest',
}

export enum SignalMessages {
  BuzzUpdate = 'buzz:update',
  ImageGenStatusUpdate = 'image-gen:status-update',
  TrainingUpdate = 'training:update',
  ImageIngestionStatus = 'image-ingestion:status',
  ChatNewMessage = 'chat:new-message',
  ChatNewRoom = 'chat:new-room',
  ChatTypingStatus = 'chat:typing-status',
  OrchestratorUpdate = 'orchestrator-job:status-update',
  TextToImageUpdate = 'orchestrator:text-to-image-update',
  SchedulerDownload = 'scheduler:download',
  NotificationNew = 'notification:new',
  ModelVersionPopularityUpdate = 'model-version:popularity:update',
  Pong = 'pong',
  CompensationPoolUpdate = 'creators-program:compensation-pool-update',
  CashInvalidator = 'creators-program:cash-invalidator',
  AuctionBidChange = 'auction:bid-change',
  TopicUpdate = 'topic:connections',
  NewOrderQueueUpdate = 'new-order:queue-update',
  NewOrderPlayerUpdate = 'new-order:player-update',
  SessionRefresh = 'session:refresh',
}

export enum BountySort {
  EndingSoon = 'Ending Soon',
  HighestBounty = 'Highest Bounty',
  MostLiked = 'Most Liked',
  MostDiscussed = 'Most Discussed',
  MostContributors = 'Most Contributors',
  MostTracked = 'Most Tracked',
  MostEntries = 'Most Entries',
  Newest = 'Newest',
}

export enum BountyBenefactorSort {
  HighestAmount = 'Highest Amount',
  Newest = 'Newest',
}

export enum BountyStatus {
  Open = 'Open',
  Expired = 'Expired',
  Awarded = 'Awarded',
}

export enum CollectionReviewSort {
  Newest = 'Newest',
  Oldest = 'Oldest',
}

export enum ClubMembershipSort {
  MostRecent = 'MostRecent',
  NextBillingDate = 'NextBillingDate',
  MostExpensive = 'MostExpensive',
}

export enum ClubSort {
  Newest = 'Newest',
  MostResources = 'Most Resources',
  MostPosts = 'Most Club Posts',
  MostMembers = 'Most Members',
}

export enum BlockedReason {
  TOS = 'tos',
  Moderated = 'moderated',
  CSAM = 'CSAM',
  AiNotVerified = 'AiNotVerified',
}

export enum ViolationType {
  RealPerson = 'realPerson',
  RealPersonNsfw = 'realPersonNsfw',
  RealisticMinor = 'realisticMinor',
  RealisticMinorNsfw = 'realisticMinorNsfw',
  AnimatedMinorNsfw = 'animatedMinorNsfw',
  SchoolNsfw = 'schoolNsfw',
  Bestiality = 'bestiality',
  SexualViolence = 'sexualViolence',
  MindAlteredNsfw = 'mindAlteredNsfw',
  FecalMatter = 'fecalMatter',
  Gore = 'gore',
  Diaper = 'diaper',
  Anorexia = 'anorexia',
  BodilyFluids = 'bodilyFluids',
  Incest = 'incest',
  Hate = 'hate',
  NonAi = 'non-ai',
  Spam = 'spam',
  Other = 'other',
}

export enum ThreadSort {
  Newest = 'Newest',
  Oldest = 'Oldest',
  MostReactions = 'Most Reactions',
}

export enum GenerationReactType {
  Favorited = 'favorited',
  Liked = 'liked',
  Disliked = 'disliked',
}

export enum GenerationSort {
  Newest = 'Newest',
  Oldest = 'Oldest',
}

export enum NsfwLevel {
  PG = 1,
  PG13 = 2,
  R = 4,
  X = 8,
  XXX = 16,
  Blocked = 32,
}

export enum OnboardingSteps {
  TOS = 1,
  Profile = 2,
  BrowsingLevels = 4,
  Buzz = 8,
  CreatorProgram = 16,
  BannedCreatorProgram = 32,
  RedTOS = 64,
}

export const OnboardingComplete =
  OnboardingSteps.TOS |
  OnboardingSteps.Profile |
  OnboardingSteps.BrowsingLevels |
  OnboardingSteps.Buzz;

export enum PurchasableRewardViewMode {
  Available = 'Available',
  Purchased = 'Purchased',
}

export enum PurchasableRewardModeratorViewMode {
  Available = 'Available',
  History = 'History',
  Purchased = 'Purchased',
}

export enum ImageConnectionType {
  Bounty = 'Bounty',
  BountyEntry = 'BountyEntry',
}

export enum SearchIndexUpdateQueueAction {
  Update = 'Update',
  Delete = 'Delete',
}

export enum VaultSort {
  RecentlyAdded = 'Recently Added',
  RecentlyCreated = 'Recently Created',
  ModelName = 'Model Name',
  ModelSize = 'Model Size',
}

export enum GenerationRequestStatus {
  Pending = 'Pending',
  Processing = 'Processing',
  Cancelled = 'Cancelled',
  Error = 'Error',
  Succeeded = 'Succeeded',
}

export enum EntityAccessPermission {
  None = 0, // Generally won't be used, but can be used to indicate no access
  EarlyAccessGeneration = 1,
  EarlyAccessDownload = 2,
  All = 1 + 2, // Sum of all prev. permissions.
}

// nb: when updating this, similar updates must be made to the notification DB
export enum NotificationCategory {
  Comment = 'Comment',
  Update = 'Update',
  Milestone = 'Milestone',
  Bounty = 'Bounty',
  Buzz = 'Buzz',
  Creator = 'Creator',
  System = 'System',
  Other = 'Other',
}

export enum BanReasonCode {
  SexualMinor = 'SexualMinor',
  SexualMinorGenerator = 'SexualMinorGenerator',
  SexualMinorTraining = 'SexualMinorTraining',
  SexualPOI = 'SexualPOI',
  Bestiality = 'Bestiality',
  Scat = 'Scat',
  Nudify = 'Nudify',
  Harassment = 'Harassment',
  LeaderboardCheating = 'LeaderboardCheating',
  BuzzCheating = 'BuzzCheating',
  RRDViolation = 'RRDViolation',
  Other = 'Other',
}

export enum StripeConnectStatus {
  PendingOnboarding = 'PendingOnboarding',
  PendingVerification = 'PendingVerification',
  Approved = 'Approved',
  Rejected = 'Rejected',
}

export enum TipaltiStatus {
  PendingOnboarding = 'PendingOnboarding',
  Active = 'ACTIVE',
  Suspended = 'SUSPENDED',
  Blocked = 'BLOCKED',
  BlockedByTipalti = 'BLOCKED_BY_TIPALTI',
  InternalValue = 'INTERNAL_VALUE',
}

export enum OrchPriorityTypes {
  High = 'high',
  Normal = 'normal',
  Low = 'low',
}

export enum OrchEngineTypes {
  Kohya = 'kohya',
  Rapid = 'flux-dev-fast',
  Flux2Dev = 'flux2-dev',
  Flux2DevEdit = 'flux2-dev-edit',
  Musubi = 'musubi',
  AiToolkit = 'ai-toolkit',
}

export enum BlocklistType {
  EmailDomain = 'EmailDomain',
  LinkDomain = 'LinkDomain',
  MessagePattern = 'MessagePattern',
}

export enum ToolSort {
  Newest = 'Newest',
  Oldest = 'Oldest',
  AZ = 'AZ',
  ZA = 'ZA',
}

export enum BuzzWithdrawalRequestSort {
  Newest = 'Newest',
  Oldest = 'Oldest',
  HighestAmount = 'Highest Amount',
  LowestAmount = 'Lowest Amount',
}

export enum SignalTopic {
  CreatorProgram = 'creators-program',
  Auction = 'auction', // with :auctionId
  ModelVersion = 'model-version', // with :modelVersionId
  NewOrderPlayer = 'new-order-player', // with :playerId
  NewOrderQueue = 'new-order-queue', // with :queueId
}

export enum NewOrderImageRatingStatus {
  Correct = 'Correct',
  Pending = 'Pending',
  Failed = 'Failed',
  Inconclusive = 'Inconclusive',
  AcolyteCorrect = 'AcolyteCorrect',
  AcolyteFailed = 'AcolyteFailed',
}

export enum NewOrderDamnedReason {
  InappropriateMinors = 'InappropriateMinors',
  RealisticMinors = 'RealisticMinors',
  DepictsRealPerson = 'DepictsRealPerson',
  Bestiality = 'Bestiality',
  Other = 'Other',
}

export enum NewOrderSignalActions {
  UpdateStats = 'update-stats',
  RankUp = 'rank-up',
  Reset = 'reset',
  AddImage = 'add-image',
  RemoveImage = 'remove-image',
}

export enum ExternalModerationType {
  Clavata = 'Clavata',
}

export enum ModReviewType {
  Minor = 'minor',
  POI = 'poi',
  Reported = 'reported',
  CSAM = 'csam',
  BlockedTags = 'tag',
  NewUsers = 'newUser',
  Appeals = 'appeal',
  RuleViolations = 'modRule',
}

export enum MarketplacePaymentMethod {
  CashApp = 'CashApp',
  Revolut = 'Revolut',
  Venmo = 'Venmo',
  Wise = 'Wise',
  Zelle = 'Zelle',
}
