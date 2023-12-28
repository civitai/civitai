import {
  Currency,
  MetricTimeframe,
  ModelStatus,
  ModelType,
  ModelVersionMonetizationType,
  ModelVersionSponsorshipSettingsType,
  ReviewReactions,
} from '@prisma/client';
import { ModelSort } from '~/server/common/enums';
import { IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { IconBolt, IconCurrencyDollar, TablerIconsProps } from '@tabler/icons-react';
import { MantineTheme } from '@mantine/core';
import {
  ArticleSort,
  BrowsingMode,
  CollectionSort,
  ImageSort,
  PostSort,
  QuestionSort,
} from './enums';
import { Generation } from '~/server/services/generation/generation.types';

export const constants = {
  modelFilterDefaults: {
    sort: ModelSort.HighestRated,
    period: MetricTimeframe.AllTime,
  },
  questionFilterDefaults: {
    sort: QuestionSort.MostLiked,
    period: MetricTimeframe.AllTime,
    limit: 50,
  },
  galleryFilterDefaults: {
    sort: ImageSort.MostReactions,
    period: MetricTimeframe.AllTime,
    limit: 50,
  },
  postFilterDefaults: {
    sort: PostSort.MostReactions,
    period: MetricTimeframe.AllTime,
    browsingMode: BrowsingMode.All,
    limit: 50,
  },
  articleFilterDefaults: {
    sort: ArticleSort.Newest,
    period: MetricTimeframe.AllTime,
    browsingMode: BrowsingMode.SFW,
    limit: 50,
  },
  collectionFilterDefaults: {
    sort: CollectionSort.Newest,
    browsingMode: BrowsingMode.SFW,
    limit: 50,
  },
  baseModels: [
    'SD 1.4',
    'SD 1.5',
    'SD 1.5 LCM',
    'SD 2.0',
    'SD 2.0 768',
    'SD 2.1',
    'SD 2.1 768',
    'SD 2.1 Unclip',
    'SDXL 0.9',
    'SDXL 1.0',
    'SDXL 1.0 LCM',
    'SDXL Distilled',
    'SDXL Turbo',
    'SVD',
    'SVD XT',
    'Playground v2',
    'PixArt a',
    'Other',
  ],
  modelFileTypes: [
    'Model',
    'Text Encoder',
    'Pruned Model',
    'Negative',
    'Training Data',
    'VAE',
    'Config',
    'Archive',
  ],
  trainingModelTypes: ['Character', 'Style', 'Concept'],
  baseModelTypes: ['Standard', 'Inpainting', 'Refiner', 'Pix2Pix'],
  modelFileFormats: ['SafeTensor', 'PickleTensor', 'Diffusers', 'Core ML', 'Other'],
  modelFileSizes: ['full', 'pruned'],
  modelFileFp: ['fp16', 'fp32', 'bf16'],
  imageFormats: ['optimized', 'metadata'],
  tagFilterDefaults: {
    trendingTagsLimit: 20,
  },
  reportingFilterDefaults: {
    limit: 50,
  },
  modelFileOrder: {
    Model: 0,
    'Pruned Model': 1,
    'Training Data': 2,
    Config: 3,
    'Text Encoder': 4,
    VAE: 5,
    Negative: 6,
    Archive: 7,
  },
  cardSizes: {
    model: 320,
    image: 320,
    articles: 320,
    bounty: 332,
    club: 320,
  },
  modPublishOnlyStatuses: [ModelStatus.UnpublishedViolation, ModelStatus.Deleted] as ModelStatus[],
  cacheTime: {
    postCategories: 60 * 60 * 1,
  },
  timeCutOffs: {
    updatedModel: 2 * 60 * 60 * 1000,
  },
  samplers: [
    'Euler a',
    'Euler',
    'LMS',
    'Heun',
    'DPM2',
    'DPM2 a',
    'DPM++ 2S a',
    'DPM++ 2M',
    'DPM++ SDE',
    'DPM++ 2M SDE',
    'DPM fast',
    'DPM adaptive',
    'LMS Karras',
    'DPM2 Karras',
    'DPM2 a Karras',
    'DPM++ 2S a Karras',
    'DPM++ 2M Karras',
    'DPM++ SDE Karras',
    'DPM++ 2M SDE Karras',
    'DDIM',
    'PLMS',
    'UniPC',
    'LCM',
  ],
  availableReactions: {
    [ReviewReactions.Like]: '👍',
    [ReviewReactions.Dislike]: '👎',
    [ReviewReactions.Heart]: '❤️',
    [ReviewReactions.Laugh]: '😂',
    [ReviewReactions.Cry]: '😢',
  },
  richTextEditor: {
    maxFileSize: 1024 * 1024 * 5, // 5MB
    accept: IMAGE_MIME_TYPE,
    // Taken from https://v5.mantine.dev/others/tiptap/#text-color
    presetColors: [
      '#25262b',
      '#868e96',
      '#fa5252',
      '#e64980',
      '#be4bdb',
      '#7950f2',
      '#4c6ef5',
      '#228be6',
      '#15aabf',
      '#12b886',
      '#40c057',
      '#82c91e',
      '#fab005',
      '#fd7e14',
    ] as string[],
  },
  imageGuard: {
    noAccountLimit: 5,
    cutoff: 1000 * 60 * 60 * 24,
  },
  imageGeneration: {
    drawerZIndex: 301,
    requestBlocking: {
      warned: 3,
      notified: 5,
      muted: 8,
    },
    maxConcurrentRequests: 10,
  },
  tagVoting: {
    voteDuration: 1000 * 60 * 60 * 24,
    upvoteThreshold: 3,
  },
  imageTags: {
    styles: ['anime', 'cartoon', 'comics', 'manga'] as string[],
  },
  maxTrainingRetries: 2,
  mediaUpload: {
    maxImageFileSize: 50 * 1024 ** 2, // 50MB
    maxVideoDimension: 3840,
    maxVideoDurationSeconds: 120,
  },
  bounties: {
    engagementTypes: ['active', 'favorite', 'tracking', 'supporter', 'awarded'],
    minCreateAmount: 500,
    maxCreateAmount: 100000000,
  },
  defaultCurrency: Currency.BUZZ,
  referrals: {
    referralCodeMinLength: 6,
    referralCodeMaxCount: 3,
  },
  leaderboard: {
    legendScoring: {
      diamond: 10,
      gold: 8,
      silver: 6,
      bronze: 4,
    },
  },
  buzz: {
    minChargeAmount: 500, // $5.00
    maxChargeAmount: 99999999, // $999,999.99
    cutoffDate: new Date('2023-10-17T00:00:00.000Z'),
    referralBonusAmount: 500,
    maxTipAmount: 100000000,
    minTipAmount: 50,
    maxEntityTip: 2000,
  },
  profile: {
    coverImageAspectRatio: 1 / 4,
    mobileCoverImageAspectRatio: 1 / 4,
    coverImageHeight: 400,
    coverImageWidth: 1600,
    showcaseItemsLimit: 32,
    bioMaxLength: 400,
    messageMaxLength: 1200,
    locationMaxLength: 30,
  },
  clubs: {
    tierMaxMemberLimit: 9999,
    tierImageAspectRatio: 1 / 1,
    tierImageDisplayWidth: 124,
    tierImageSidebarDisplayWidth: 84,
    avatarDisplayWidth: 124,
    minMonthlyBuzz: 5,
    minStripeCharge: 3000, // 3000 Buzz = $3.00 USD
    headerImageAspectRatio: 1 / 4,
    postCoverImageAspectRatio: 1 / 4,
    engagementTypes: ['engaged'],
    coverImageHeight: 400,
    coverImageWidth: 1600,
  },
} as const;

export const zipModelFileTypes: ModelFileFormat[] = ['Core ML', 'Diffusers'];
export type ZipModelFileType = (typeof zipModelFileTypes)[number];

export const POST_IMAGE_LIMIT = 20;
export const CAROUSEL_LIMIT = 20;
export const DEFAULT_EDGE_IMAGE_WIDTH = 450;

export type BaseModelType = (typeof constants.baseModelTypes)[number];

export type BaseModel = (typeof constants.baseModels)[number];

export const baseModelSetTypes = ['SD1', 'SD2', 'SDXL', 'SDXLDistilled'] as const;
export type BaseModelSetType = (typeof baseModelSetTypes)[number];
export const baseModelSets: Record<BaseModelSetType, BaseModel[]> = {
  SD1: ['SD 1.4', 'SD 1.5', 'SD 1.5 LCM'],
  SD2: ['SD 2.0', 'SD 2.0 768', 'SD 2.1', 'SD 2.1 768', 'SD 2.1 Unclip'],
  SDXL: ['SDXL 0.9', 'SDXL 1.0', 'SDXL 1.0 LCM'],
  SDXLDistilled: ['SDXL Distilled'],
};

type LicenseDetails = {
  url: string;
  name: string;
};
export const baseLicenses: Record<string, LicenseDetails> = {
  openrail: {
    url: 'https://huggingface.co/spaces/CompVis/stable-diffusion-license',
    name: 'CreativeML Open RAIL-M',
  },
  'sdxl 0.9': {
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDXL0.9',
    name: 'SDXL 0.9 research license',
  },
  'openrail++': {
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDXL1.0',
    name: 'CreativeML Open RAIL++-M',
  },
  'sdxl turbo': {
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDXL-Turbo',
    name: 'Stability AI Non-Commercial Research Community License',
  },
  svd: {
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDV',
    name: 'Stable Video Diffusion Non-Commercial Research Community License',
  },
  'playground v2': {
    url: 'https://huggingface.co/playgroundai/playground-v2-1024px-aesthetic/blob/main/LICENSE.md',
    name: 'Playground v2 Community License',
  },
  agpl: {
    url: 'https://github.com/PixArt-alpha/PixArt-alpha/blob/master/LICENSE',
    name: 'agpl-3.0',
  },
};

export const baseModelLicenses: Record<BaseModel, LicenseDetails | undefined> = {
  'SD 1.4': baseLicenses['openrail'],
  'SD 1.5': baseLicenses['openrail'],
  'SD 1.5 LCM': baseLicenses['openrail++'],
  'SD 2.0': baseLicenses['openrail'],
  'SD 2.0 768': baseLicenses['openrail'],
  'SD 2.1': baseLicenses['openrail'],
  'SD 2.1 768': baseLicenses['openrail'],
  'SD 2.1 Unclip': baseLicenses['openrail'],
  'SDXL 0.9': baseLicenses['sdxl 0.9'],
  'SDXL 1.0': baseLicenses['openrail++'],
  'SDXL 1.0 LCM': baseLicenses['openrail++'],
  'SDXL Distilled': baseLicenses['openrail++'],
  'SDXL Turbo': baseLicenses['sdxl turbo'],
  SVD: baseLicenses['svd'],
  'SVD XT': baseLicenses['svd'],
  'Playground v2': baseLicenses['playground v2'],
  'PixArt a': baseLicenses['agpl'],
  Other: undefined,
};

export type ModelFileType = (typeof constants.modelFileTypes)[number];
export type Sampler = (typeof constants.samplers)[number];

export const samplerMap = new Map<Sampler, string[]>([
  ['Euler a', ['euler_ancestral']],
  ['Euler', ['euler']],
  ['LMS', ['lms']],
  ['Heun', ['heun']],
  ['DPM2', ['dpm_2']],
  ['DPM2 a', ['dpm_2_ancestral']],
  ['DPM++ 2S a', ['dpmpp_2s_ancestral']],
  ['DPM++ 2M', ['dpmpp_2m']],
  ['DPM++ SDE', ['dpmpp_sde', 'dpmpp_sde_gpu']],
  ['DPM++ 2M SDE', ['dpmpp_2m_sde']],
  ['DPM fast', ['dpm_fast']],
  ['DPM adaptive', ['dpm_adaptive']],
  ['LMS Karras', ['lms_karras']],
  ['DPM2 Karras', ['dpm_2_karras']],
  ['DPM2 a Karras', ['dpm_2_ancestral_karras']],
  ['DPM++ 2S a Karras', ['dpmpp_2s_ancestral_karras']],
  ['DPM++ 2M Karras', ['dpmpp_2m_karras']],
  ['DPM++ SDE Karras', ['dpmpp_sde_karras']],
  ['DPM++ 2M SDE Karras', ['dpmpp_2m_sde_karras']],
  ['DDIM', ['ddim']],
  ['PLMS', ['plms']],
  ['UniPC', ['uni_pc', 'uni_pc_bh2']],
  ['LCM', ['lcm']],
]);

export const samplerOffsets = {
  'Euler a': 4,
  Euler: 4,
  Heun: 8,
  LMS: 10,
  DDIM: 15,
  'DPM++ 2M Karras': 4,
  DPM2: 4,
  'DPM2 a': 4,
} as const;

export const generation = {
  formStoreKey: 'generation-form',
  samplers: Object.keys(samplerOffsets) as (keyof typeof samplerOffsets)[],
  lcmSamplers: ['LCM', 'Euler a'] as Sampler[],
  defaultValues: {
    cfgScale: 7,
    steps: 25,
    sampler: 'DPM++ 2M Karras',
    seed: undefined,
    clipSkip: 2,
    quantity: 4,
    aspectRatio: '0',
    prompt: '',
    negativePrompt: '',
    nsfw: false,
    model: {
      id: 128713,
      name: '8',
      modelId: 4384,
      modelName: 'DreamShaper',
      modelType: 'Checkpoint',
      baseModel: 'SD 1.5',
      strength: 1,
      trainedWords: [],
    } as Generation.Resource,
  },
  maxValues: {
    seed: 4294967295,
    steps: 80,
    quantity: 10,
    clipSkip: 10,
  },
} as const;

export type ResourceFilter = {
  type: ModelType;
  baseModelSet?: BaseModelSetType;
  baseModels?: BaseModel[];
};
export const generationConfig = {
  SD1: {
    // additionalResourceTypes: [{ type: ModelType.LORA, baseModel: 'SD1' }],
    additionalResourceTypes: [
      { type: ModelType.LORA, baseModelSet: 'SD1' },
      { type: ModelType.LoCon, baseModelSet: 'SD1' },
      { type: ModelType.TextualInversion, baseModelSet: 'SD1' },
    ] as ResourceFilter[],
    aspectRatios: [
      { label: 'Square', width: 512, height: 512 },
      { label: 'Landscape', width: 768, height: 512 },
      { label: 'Portrait', width: 512, height: 768 },
    ],
    costs: {
      base: 0,
      quantity: 1,
      steps: 40,
      width: 512,
      height: 512,
    },
    checkpoint: {
      id: 128713,
      name: '8',
      trainedWords: [],
      modelId: 4384,
      modelName: 'DreamShaper',
      modelType: 'Checkpoint',
      baseModel: 'SD 1.5',
      strength: 1,
    } as Generation.Resource,
  },
  SDXL: {
    additionalResourceTypes: [
      { type: ModelType.LORA, baseModelSet: 'SDXL' },
      { type: ModelType.TextualInversion, baseModelSet: 'SDXL', baseModels: ['SD 1.5'] },
    ] as ResourceFilter[],
    aspectRatios: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1216, height: 832 },
      { label: 'Portrait', width: 832, height: 1216 },
    ],
    costs: {
      // TODO.generation: Uncomment this out by next week once we start charging for SDXL generation
      // base: 4,
      base: 0,
      quantity: 1,
      steps: 40,
      width: 1024,
      height: 1024,
    },
    checkpoint: {
      id: 128078,
      name: 'v1.0 VAE fix',
      trainedWords: [],
      modelId: 101055,
      modelName: 'SD XL',
      modelType: 'Checkpoint',
      baseModel: 'SDXL 1.0',
      strength: 1,
    } as Generation.Resource,
  },
};

export type GenerationBaseModel = keyof typeof generationConfig;

export const getGenerationConfig = (baseModel?: string) => {
  const key = baseModel as keyof typeof generationConfig | undefined;
  return key && generationConfig[key] ? generationConfig[key] : generationConfig['SD1'];
};

export const MODELS_SEARCH_INDEX = 'models_v5';
export const IMAGES_SEARCH_INDEX = 'images_v3';
export const ARTICLES_SEARCH_INDEX = 'articles_v2';
export const USERS_SEARCH_INDEX = 'users_v2';
export const COLLECTIONS_SEARCH_INDEX = 'collections';
export const BOUNTIES_SEARCH_INDEX = 'bounties';

export const modelVersionMonetizationTypeOptions: Record<ModelVersionMonetizationType, string> = {
  [ModelVersionMonetizationType.PaidAccess]: 'Paid access',
  [ModelVersionMonetizationType.PaidEarlyAccess]: 'Paid early access',
  [ModelVersionMonetizationType.CivitaiClubOnly]: 'Exclusive to Civitai Club members',
  [ModelVersionMonetizationType.MySubscribersOnly]: 'Exclusive to my subscribers',
  [ModelVersionMonetizationType.Sponsored]: 'Sponsorships',
  [ModelVersionMonetizationType.PaidGeneration]: 'Paid on-site generation',
};

export const modelVersionSponsorshipSettingsTypeOptions: Record<
  ModelVersionSponsorshipSettingsType,
  string
> = {
  [ModelVersionSponsorshipSettingsType.FixedPrice]: 'Fixed Price',
  [ModelVersionSponsorshipSettingsType.Bidding]: 'Bidding',
};

export const CurrencyConfig: Record<
  Currency,
  { icon: (props: TablerIconsProps) => JSX.Element; color: (theme: MantineTheme) => string }
> = {
  [Currency.BUZZ]: { icon: IconBolt, color: (theme) => theme.colors.accent[5] },
  [Currency.USD]: { icon: IconCurrencyDollar, color: (theme) => theme.colors.accent[5] },
};

export const BUZZ_FEATURE_LIST = [
  'Support your favorite creators via tips and subscriptions',
  'Pay for on-site model training',
  'Create bounties for models, images and more!',
  'Purchase user cosmetics from our upcoming user cosmetic store!',
];

export const STRIPE_PROCESSING_AWAIT_TIME = 20000; // 20s
export const STRIPE_PROCESSING_CHECK_INTERVAL = 1000; // 1s

export const CacheTTL = {
  xs: 60 * 1,
  sm: 60 * 3,
  md: 60 * 10,
  lg: 60 * 30,
  hour: 60 * 60,
  day: 60 * 60 * 24,
  week: 60 * 60 * 24 * 7,
  month: 60 * 60 * 24 * 30,
} as const;
