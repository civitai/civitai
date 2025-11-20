/**
 * Shared schema types to break circular dependencies
 *
 * This file contains type-only exports for schema types that are used across
 * multiple schema files. By extracting these types here, we break circular
 * dependencies between schema files.
 *
 * IMPORTANT: This file should only contain type definitions, not Zod schemas.
 * The actual Zod schemas remain in their respective schema files.
 */

// User-related types
export type UserTier = 'free' | 'founder' | 'bronze' | 'silver' | 'gold';

export type UserSubscriptionByBuzzType = {
  tier: UserTier;
  isMember: boolean;
  subscriptionId: string;
  status: string;
};

export type UserSubscriptionsByBuzzType = Record<string, UserSubscriptionByBuzzType>;

export type UserAssistantPersonality = 'civbot' | 'civchan';

export type TourSettingsSchema = Record<
  string,
  {
    completed?: boolean;
    currentStep?: number;
  }
>;

export type UserScoreMeta = {
  total: number;
  models?: number;
  articles?: number;
  images?: number;
  users?: number;
  reportsActioned?: number;
  reportsAgainst?: number;
};

// Model-related types
export type ModelGallerySettingsSchema = {
  users?: number[] | undefined;
  tags?: number[] | undefined;
  images?: number[] | undefined;
  level?: number | undefined;
  hiddenImages?: Record<string, number[]> | undefined;
  pinnedPosts?: Record<string, number[]> | undefined;
};

export type ModelMeta = Partial<{
  unpublishedReason: string;
  customMessage: string;
  needsReview: boolean;
  unpublishedAt: string;
  archivedAt: string;
  archivedBy: number;
  takenDownAt: string;
  takenDownBy: number;
  bountyId: number;
  unpublishedBy: number;
  declinedReason: string;
  declinedAt: string;
  showcaseCollectionId: number;
  cannotPromote: boolean;
  cannotPublish: boolean;
  commentsLocked: boolean;
  profanityMatches: string[];
  profanityEvaluation: { reason?: string; metrics?: any };
}>;

// Model Version-related types
export type ModelVersionEarlyAccessConfig = {
  timeframe: number;
  chargeForDownload?: boolean;
  downloadPrice?: number;
  chargeForGeneration?: boolean;
  generationPrice?: number;
  generationTrialLimit?: number;
  donationGoalEnabled?: boolean;
  donationGoal?: number;
  donationGoalId?: number;
  originalPublishedAt?: Date;
  freeGeneration?: boolean;
};

export type ModelVersionMeta = ModelMeta & {
  picFinderModelId?: number;
  earlyAccessDownloadData?: { date: string; downloads: number }[];
  generationImagesCount?: { date: string; generations: number }[];
  allowAIRecommendations?: boolean;
  hadEarlyAccessPurchase?: boolean;
};

export type TrainingDetailsBaseModelList =
  | 'sd_1_5'
  | 'anime'
  | 'semi'
  | 'realistic'
  | 'sdxl'
  | 'pony'
  | 'illustrious'
  | 'flux_dev'
  | 'hy_720_fp8'
  | 'wan_2_1_i2v_14b_720p'
  | 'wan_2_1_t2v_14b'
  | 'chroma'
  | 'qwen_image';

export type TrainingDetailsBaseModelCustom = string;

export type TrainingDetailsBaseModel =
  | TrainingDetailsBaseModelList
  | TrainingDetailsBaseModelCustom;

export type TrainingDetailsParams = {
  unetLR: number;
  textEncoderLR: number;
  optimizerType: string;
  networkDim: number;
  networkAlpha: number;
  lrScheduler: string;
  maxTrainEpochs: number;
  numRepeats: number;
  resolution: number;
  loraType: string;
  enableBucket: boolean;
  keepTokens: number;
  clipSkip?: number;
  flipAugmentation?: boolean;
  noiseOffset?: number;
  lrSchedulerNumCycles: number;
  trainBatchSize: number;
  minSnrGamma: number;
  optimizerArgs?: string;
  shuffleCaption: boolean;
  targetSteps: number;
  engine?: 'kohya' | 'rapid' | 'musubi' | 'ai-toolkit';
};

export type RecommendedSettingsSchema = {
  minStrength?: number | null;
  maxStrength?: number | null;
  strength?: number | null;
};

// Image-related types
export type ImageEntityType = 'Bounty' | 'BountyEntry' | 'User' | 'Post' | 'Article';

export type ComfyMetaSchema = Partial<{
  prompt: Record<string, any>;
  workflow: Partial<{
    nodes?: Array<Record<string, any>>;
  }>;
}>;

export type ExternalMetaSchema = {
  source?: {
    name?: string;
    homepage?: string;
  };
  details?: Record<string, string | number | boolean>;
  createUrl?: string;
  referenceUrl?: string;
};

export type CivitaiResource = {
  type?: string;
  weight?: number;
  modelVersionId: number;
};

export type ImageMetaProps = {
  prompt?: string;
  negativePrompt?: string;
  cfgScale?: number;
  steps?: number;
  sampler?: string;
  seed?: number;
  clipSkip?: number;
  'Clip skip'?: number;
  comfy?: string | ComfyMetaSchema;
  external?: ExternalMetaSchema;
  effects?: Record<string, any>;
  engine?: string;
  version?: string;
  process?: string;
  type?: string;
  workflow?: string;
  resources?: Array<{
    type: string;
    name?: string;
    weight?: number;
    hash?: string;
  }>;
  additionalResources?: Array<{
    name?: string;
    type?: string;
    strength?: number;
    strengthClip?: number;
  }>;
  civitaiResources?: CivitaiResource[];
  extra?: {
    remixOfId?: number;
  };
} & Record<string, unknown>;

export type FaceDetectionInput = {
  age: number;
  emotions: Array<{ emotion: string; score: number }>;
  gender: 'male' | 'female' | 'unknown';
  genderConfidence?: number;
  live: number;
  real: number;
};

export type ImageAnalysisInput = {
  drawing: number;
  hentai: number;
  neutral: number;
  porn: number;
  sexy: number;
  faces?: FaceDetectionInput[];
};

// Generation-related types
export type GenerationLimits = {
  quantity: number;
  queue: number;
  steps: number;
  resources: number;
};

export type GenerationStatus = {
  available: boolean;
  message?: string | null;
  limits: Record<UserTier, GenerationLimits>;
  charge: boolean;
};
