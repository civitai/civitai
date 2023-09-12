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
  Newest = 'Newest',
}

export enum ReviewSort {
  Newest = 'newest',
  Oldest = 'oldest',
  MostLiked = 'most-liked',
  MostDisliked = 'most-disliked',
  MostComments = 'most-comments',
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
}

export enum PostSort {
  MostReactions = 'Most Reactions',
  MostComments = 'Most Comments',
  MostCollected = 'Most Collected',
  Newest = 'Newest',
}

export enum BrowsingMode {
  All = 'All',
  SFW = 'SFW',
  NSFW = 'NSFW',
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
}

export enum BountySort {
  HighestBounty = 'Highest Bounty',
  EndingSoon = 'Ending Soon',
  MostLiked = 'Most Liked',
  MostDiscussed = 'Most Discussed',
  MostContributors = 'Most Contributors',
  MostTracked = 'Most Tracked',
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
