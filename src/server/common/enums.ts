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
  // MostTipped = 'Most Buzz',
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
  // MostTipped = 'Most Buzz',
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
  Moderation,
  Label,
  FaceDetection,
  WD14,
}

export enum CommentV2Sort {
  Newest = 'Newest',
  Oldest = 'Oldest',
}

export enum ArticleSort {
  MostBookmarks = 'Most Bookmarks',
  MostReactions = 'Most Reactions',
  // MostTipped = 'Most Buzz',
  MostComments = 'Most Comments',
  MostCollected = 'Most Collected',
  Newest = 'Newest',
}

export enum ModelType {
  Checkpoint = 'Checkpoint',
  TextualInversion = 'TextualInversion',
  MotionModule = 'MotionModule',
  Hypernetwork = 'Hypernetwork',
  AestheticGradient = 'AestheticGradient',
  LORA = 'LORA',
  LoCon = 'LoCon',
  Controlnet = 'Controlnet',
  Upscaler = 'Upscaler',
  VAE = 'VAE',
  Poses = 'Poses',
  Wildcards = 'Wildcards',
  Other = 'Other',
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
}

export enum ThreadSort {
  Newest = 'Newest',
  Oldest = 'Oldest',
  MostReactions = 'Most Reactions',
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
