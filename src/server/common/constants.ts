import {
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
    'SD 2.0',
    'SD 2.0 768',
    'SD 2.1',
    'SD 2.1 768',
    'SD 2.1 Unclip',
    'SDXL 0.9',
    'SDXL 1.0',
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
  modelFileFormats: ['SafeTensor', 'PickleTensor', 'Diffusers', 'Other'],
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
    articles: 450,
    bounty: 332,
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
  imageGeneration: {
    drawerZIndex: 301,
  },
  tagVoting: {
    voteDuration: 1000 * 60 * 60 * 24,
    upvoteThreshold: 3,
  },
  imageTags: {
    styles: ['anime', 'cartoon', 'comics', 'manga'] as string[],
  },
  maxTrainingRetries: 2,
  imageUpload: {
    maxFileSize: 32 * 1024 ** 2, // 32MB
  },
} as const;

export const POST_IMAGE_LIMIT = 20;
export const CAROUSEL_LIMIT = 20;
export const DEFAULT_EDGE_IMAGE_WIDTH = 450;

export type BaseModelType = (typeof constants.baseModelTypes)[number];

export type BaseModel = (typeof constants.baseModels)[number];
export const baseModelSets: Record<string, BaseModel[]> = {
  SD1: ['SD 1.4', 'SD 1.5'],
  SD2: ['SD 2.0', 'SD 2.0 768', 'SD 2.1', 'SD 2.1 768', 'SD 2.1 Unclip'],
  SDXL: ['SDXL 0.9', 'SDXL 1.0'],
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
};

export const baseModelLicenses: Record<BaseModel, LicenseDetails | undefined> = {
  'SD 1.4': baseLicenses['openrail'],
  'SD 1.5': baseLicenses['openrail'],
  'SD 2.0': baseLicenses['openrail'],
  'SD 2.0 768': baseLicenses['openrail'],
  'SD 2.1': baseLicenses['openrail'],
  'SD 2.1 768': baseLicenses['openrail'],
  'SD 2.1 Unclip': baseLicenses['openrail'],
  'SDXL 0.9': baseLicenses['sdxl 0.9'],
  'SDXL 1.0': baseLicenses['openrail++'],
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
]);

export const generation = {
  formStoreKey: 'generation-form',
  aspectRatios: [
    { label: 'Square', width: 512, height: 512 },
    { label: 'Landscape', width: 768, height: 512 },
    { label: 'Portrait', width: 512, height: 768 },
  ],
  additionalResourceTypes: [ModelType.LORA, ModelType.TextualInversion],
  samplers: constants.samplers.filter((sampler) =>
    ['Euler a', 'Euler', 'Heun', 'LMS', 'DDIM', 'DPM++ 2M Karras', 'DPM2', 'DPM2 a'].includes(
      sampler
    )
  ),
  maxSeed: 4294967295,
  defaultValues: {
    cfgScale: 7,
    steps: 25,
    sampler: 'DPM++ 2M Karras',
    seed: undefined,
    clipSkip: 2,
    quantity: 4,
    aspectRatio: '512x512',
    prompt: '',
    negativePrompt: '',
  },
};

export const MODELS_SEARCH_INDEX = 'models_v2';
export const IMAGES_SEARCH_INDEX = 'images_v2';
export const ARTICLES_SEARCH_INDEX = 'articles_v2';
export const USERS_SEARCH_INDEX = 'users_v2';
export const COLLECTIONS_SEARCH_INDEX = 'collections';

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

export const DEFAULT_CURRENCY = 'USD';

export const CurrencyConfig: Record<
  Currency,
  { icon: (props: TablerIconsProps) => JSX.Element; color: (theme: MantineTheme) => string }
> = {
  [Currency.BUZZ]: { icon: IconBolt, color: (theme) => theme.colors.accent[5] },
  [Currency.USD]: { icon: IconCurrencyDollar, color: (theme) => theme.colors.accent[5] },
};

export const MIN_CREATE_BOUNTY_AMOUNT = 5000;
