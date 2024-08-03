import { MantineTheme } from '@mantine/core';
import {
  BountyType,
  Currency,
  MetricTimeframe,
  ModelStatus,
  ModelType,
  ModelVersionMonetizationType,
  ModelVersionSponsorshipSettingsType,
  ReviewReactions,
} from '@prisma/client';
import { Icon, IconBolt, IconCurrencyDollar, IconProps } from '@tabler/icons-react';
import { ModelSort } from '~/server/common/enums';
import { IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { ArticleSort, CollectionSort, ImageSort, PostSort, QuestionSort } from './enums';
import { GenerationResource } from '~/shared/constants/generation.constants';
import { env } from '~/env/client.mjs';
import { ForwardRefExoticComponent, RefAttributes } from 'react';
import { increaseDate } from '~/utils/date-helpers';

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
    limit: 50,
  },
  articleFilterDefaults: {
    sort: ArticleSort.Newest,
    period: MetricTimeframe.AllTime,
    limit: 50,
  },
  collectionFilterDefaults: {
    sort: CollectionSort.Newest,
    limit: 50,
  },
  baseModels: [
    'ODOR',
    'SD 1.4',
    'SD 1.5',
    'SD 1.5 LCM',
    'SD 1.5 Hyper',
    'SD 2.0',
    'SD 2.0 768',
    'SD 2.1',
    'SD 2.1 768',
    'SD 2.1 Unclip',
    'SDXL 0.9',
    'SDXL 1.0',
    'SD 3',
    'Pony',
    'Flux.1 S',
    'Flux.1 D',
    'AuraFlow',
    'SDXL 1.0 LCM',
    'SDXL Distilled',
    'SDXL Turbo',
    'SDXL Lightning',
    'SDXL Hyper',
    'Stable Cascade',
    'SVD',
    'SVD XT',
    'Playground v2',
    'PixArt a',
    'PixArt E',
    'Hunyuan 1',
    'Lumina',
    'Kolors',
    'Other',
  ],
  hiddenBaseModels: [
    'ODOR',
    'SD 2.1 768',
    'SD 2.1 Unclip',
    'SDXL Distilled',
    'SDXL 0.9',
    'SD 2.0 768',
  ] as string[],
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
  modelFileFormats: ['SafeTensor', 'PickleTensor', 'Diffusers', 'Core ML', 'ONNX', 'Other'],
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
    bounty: 320,
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
    'DPM++ 3M SDE',
    'DPM fast',
    'DPM adaptive',
    'LMS Karras',
    'DPM2 Karras',
    'DPM2 a Karras',
    'DPM++ 2S a Karras',
    'DPM++ 2M Karras',
    'DPM++ SDE Karras',
    'DPM++ 2M SDE Karras',
    'DPM++ 3M SDE Karras',
    'DPM++ 3M SDE Exponential',
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
    maxVideoFileSize: 750 * 1024 ** 2, // 750MB
    maxVideoDimension: 3840,
    maxVideoDurationSeconds: 245,
  },
  bounties: {
    engagementTypes: ['active', 'favorite', 'tracking', 'supporter', 'awarded'],
    minCreateAmount: 500,
    maxCreateAmount: 100000000,
    supportedBountyToModels: [BountyType.ModelCreation, BountyType.LoraCreation],
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
    buzzDollarRatio: 1000,
    platformFeeRate: 3000, // 30.00%. Divide by 10000
    minBuzzWithdrawal: 100000,
    maxBuzzWithdrawal: 100000000,
    generationBuzzChargingStartDate: new Date('2024-04-04T00:00:00.000Z'),
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
  article: {
    coverImageHeight: 400,
    coverImageWidth: 850,
  },
  comments: {
    imageMaxDepth: 3,
    bountyEntryMaxDepth: 3,
    maxDepth: 5,
  },
  altTruncateLength: 125,
  system: {
    user: { id: -1, username: 'civitai' },
  },
  creatorsProgram: {
    rewards: {
      earlyAccessUniqueDownload: 10,
      generatedImageWithResource: 10 / 1000, // 10 buzz for every 1000 images.
    },
  },
  purchasableRewards: {
    coverImageAspectRatio: 1 / 2,
    coverImageWidth: 180,
  },
  supportedBaseModelAddendums: ['SD 1.5', 'SDXL 1.0'],
  vault: {
    keys: {
      details: ':modelVersionId/:userId/details.pdf',
      images: ':modelVersionId/:userId/images.zip',
      cover: ':modelVersionId/:userId/cover.jpg',
    },
  },
  supporterBadge: 'f2ca7cb5-66af-4403-8645-949a65ac42dc',
  memberships: {
    tierOrder: ['founder', 'bronze', 'silver', 'gold'],
    badges: {
      founder: 'f2ca7cb5-66af-4403-8645-949a65ac42dc',
      bronze: 'f2ca7cb5-66af-4403-8645-949a65ac42dc',
      silver: '9f174f9f-e823-44af-b969-cd1a1d7efb08',
      gold: '758f52cb-29f7-4c40-b0fd-1a45b904bd51',
    },
    founderDiscount: {
      maxDiscountDate: new Date('2024-05-01T00:00:00Z'),
      discountPercent: 50,
      tier: 'founder',
    },
  },
  freeMembershipDetails: {
    name: 'Free',
    price: 0,
    badge: '020f374d-f165-4f45-9082-371e696a44ff',
    metadata: {
      monthlyBuzz: 0,
      generationLimit: 1,
      quantityLimit: 4,
      queueLimit: 4,
      badgeType: 'none',
    },
  },
  cosmeticShop: {
    sectionImageAspectRatio: 250 / 1288,
    sectionImageHeight: 250,
    sectionImageWidth: 1288,
  },
  cosmetics: {
    frame: {
      padding: 6,
    },
  },
  modelGallery: {
    maxPinnedPosts: 10,
  },
  chat: {
    airRegex: /^civitai:(?<mId>\d+)@(?<mvId>\d+)$/i,
    // TODO disable just "image.civitai.com" with nothing else
    civRegex: new RegExp(
      `^(?:https?://)?(?:image\\.)?(?:${(env.NEXT_PUBLIC_BASE_URL ?? 'civitai.com')
        .replace(/^https?:\/\//, '')
        .replace(/\./g, '\\.')}|civitai\\.com)`
    ),
    externalRegex: /^(?:https?:\/\/)?(?:www\.)?(github\.com|twitter\.com|x\.com)/,
  },
  entityCollaborators: {
    maxCollaborators: 15,
  },
  earlyAccess: {
    buzzChargedPerDay: 100,
    timeframeValues: [3, 5, 7, 9, 12, 15],
    scoreTimeFrameUnlock: [
      [900, 3],
      [1800, 5],
      [2200, 7],
      [8500, 9],
      [18000, 12],
      [40000, 15],
    ],
  },
} as const;
export const activeBaseModels = constants.baseModels.filter(
  (model) => !constants.hiddenBaseModels.includes(model)
);

export const zipModelFileTypes: ModelFileFormat[] = ['Core ML', 'Diffusers', 'ONNX'];
export type ZipModelFileType = (typeof zipModelFileTypes)[number];

export const POST_IMAGE_LIMIT = 20;
export const POST_TAG_LIMIT = 5;
export const CAROUSEL_LIMIT = 20;
export const DEFAULT_EDGE_IMAGE_WIDTH = 450;
export const MAX_ANIMATION_DURATION_SECONDS = 30;
export const MAX_POST_IMAGES_WIDTH = 700;

export type BaseModelType = (typeof constants.baseModelTypes)[number];

export type BaseModel = (typeof constants.baseModels)[number];

export type BaseModelSetType = (typeof baseModelSetTypes)[number];
export const baseModelSetTypes = [
  'SD1',
  'SD2',
  'SD3',
  'SDXL',
  'SDXLDistilled',
  'SCascade',
  'Pony',
  'PixArtA',
  'PixArtE',
  'Lumina',
  'Kolors',
  'HyDit1',
  'ODOR',
] as const;

const defineBaseModelSets = <T extends Record<BaseModelSetType, BaseModel[]>>(args: T) => args;
export const baseModelSets = defineBaseModelSets({
  SD1: ['SD 1.4', 'SD 1.5', 'SD 1.5 LCM', 'SD 1.5 Hyper'],
  SD2: ['SD 2.0', 'SD 2.0 768', 'SD 2.1', 'SD 2.1 768', 'SD 2.1 Unclip'],
  SD3: ['SD 3'],
  Flux1: ['Flux.1 S', 'Flux.1 D'],
  SDXL: ['SDXL 0.9', 'SDXL 1.0', 'SDXL 1.0 LCM', 'SDXL Lightning', 'SDXL Hyper', 'SDXL Turbo'],
  SDXLDistilled: ['SDXL Distilled'],
  PixArtA: ['PixArt a'],
  PixArtE: ['PixArt E'],
  Lumina: ['Lumina'],
  Kolors: ['Kolors'],
  HyDit1: ['Hunyuan 1'],
  SCascade: ['Stable Cascade'],
  Pony: ['Pony'],
  ODOR: ['ODOR'],
});

type LicenseDetails = {
  url: string;
  name: string;
  notice?: string;
  poweredBy?: string;
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
    notice:
      'This Stability AI Model is licensed under the Stability AI Non-Commercial Research Community License, Copyright (c) Stability AI Ltd. All Rights Reserved.',
  },
  svd: {
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDV',
    name: 'Stable Video Diffusion Non-Commercial Research Community License',
    notice:
      'Stable Video Diffusion is licensed under the Stable Video Diffusion Research License, Copyright (c) Stability AI Ltd. All Rights Reserved.',
  },
  'playground v2': {
    url: 'https://huggingface.co/playgroundai/playground-v2-1024px-aesthetic/blob/main/LICENSE.md',
    name: 'Playground v2 Community License',
  },
  agpl: {
    url: 'https://github.com/PixArt-alpha/PixArt-alpha/blob/master/LICENSE',
    name: 'agpl-3.0',
  },
  'SAI NC RC': {
    url: 'https://huggingface.co/stabilityai/stable-cascade/blob/main/LICENSE',
    name: 'SAI NC RC',
    notice:
      'This Stability AI Model is licensed under the Stability AI Non-Commercial Research Community License, Copyright (c) Stability AI Ltd. All Rights Reserved.',
  },
  'SAI CLA': {
    url: '',
    name: 'Stability AI Community License Agreement',
    notice:
      'This Stability AI Model is licensed under the Stability AI Community License, Copyright (c)  Stability AI Ltd. All Rights Reserved.',
    poweredBy: 'Powered by Stability AI',
  },
  'hunyuan community': {
    url: 'https://github.com/Tencent/HunyuanDiT/blob/main/LICENSE.txt',
    name: 'Tencent Hunyuan Community License Agreement',
  },
  'kolors license': {
    url: 'https://raw.githubusercontent.com/Kwai-Kolors/Kolors/master/MODEL_LICENSE',
    name: 'Kolors License',
  },
  'apache 2.0': {
    url: 'https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/apache-2.0.md',
    name: 'Apache 2.0',
  },
  flux1D: {
    url: 'https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md',
    name: 'FLUX.1 [dev] Non-Commercial License',
    notice:
      'The FLUX.1 [dev] Model is licensed by Black Forest Labs. Inc. under the FLUX.1 [dev] Non-Commercial License. Copyright Black Forest Labs. Inc.',
    poweredBy:
      'IN NO EVENT SHALL BLACK FOREST LABS, INC. BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH USE OF THIS MODEL.',
  },
};

export const baseModelLicenses: Record<BaseModel, LicenseDetails | undefined> = {
  'SD 1.4': baseLicenses['openrail'],
  'SD 1.5': baseLicenses['openrail'],
  'SD 1.5 LCM': baseLicenses['openrail++'],
  'SD 1.5 Hyper': baseLicenses['openrail++'],
  'SD 2.0': baseLicenses['openrail'],
  'SD 2.0 768': baseLicenses['openrail'],
  'SD 2.1': baseLicenses['openrail'],
  'SD 2.1 768': baseLicenses['openrail'],
  'SD 2.1 Unclip': baseLicenses['openrail'],
  'SD 3': baseLicenses['SAI CLA'],
  'SDXL 0.9': baseLicenses['sdxl 0.9'],
  'SDXL 1.0': baseLicenses['openrail++'],
  'SDXL 1.0 LCM': baseLicenses['openrail++'],
  'SDXL Distilled': baseLicenses['openrail++'],
  'SDXL Turbo': baseLicenses['sdxl turbo'],
  'SDXL Lightning': baseLicenses['openrail++'],
  'SDXL Hyper': baseLicenses['openrail++'],
  SVD: baseLicenses['svd'],
  'SVD XT': baseLicenses['svd'],
  'Playground v2': baseLicenses['playground v2'],
  'PixArt a': baseLicenses['openrail++'],
  'PixArt E': baseLicenses['openrail++'],
  'Hunyuan 1': baseLicenses['hunyuan community'],
  Lumina: baseLicenses['apache 2.0'],
  Kolors: baseLicenses['kolors license'],
  'Stable Cascade': baseLicenses['SAI NC RC'],
  Pony: baseLicenses['openrail++'],
  AuraFlow: baseLicenses['apache 2.0'],
  'Flux.1 S': baseLicenses['apache 2.0'],
  'Flux.1 D': baseLicenses['flux1D'],
  ODOR: undefined,
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
    workflow: 'txt2img',
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
    baseModel: 'SD1',
    denoise: 0.4,
    upscale: 1.5,
    civitaiTip: 0,
    creatorTip: 0.25,
    model: {
      id: 128713,
      name: '8',
      modelId: 4384,
      modelName: 'DreamShaper',
      modelType: 'Checkpoint',
      baseModel: 'SD 1.5',
      strength: 1,
      trainedWords: [],
      minStrength: -1,
      maxStrength: 2,
      covered: true,
      // image: { url: 'dd9b038c-bd15-43ab-86ab-66e145ad7ff2' },
      minor: false,
      available: true,
    } as GenerationResource,
  },
  maxValues: {
    seed: 4294967295,
    clipSkip: 3,
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
      { type: ModelType.DoRA, baseModelSet: 'SD1' },
      { type: ModelType.LoCon, baseModelSet: 'SD1' },
      { type: ModelType.TextualInversion, baseModelSet: 'SD1' },
      { type: ModelType.VAE, baseModelSet: 'SD1' },
    ] as ResourceFilter[],
    aspectRatios: [
      { label: 'Square', width: 512, height: 512 },
      { label: 'Landscape', width: 768, height: 512 },
      { label: 'Portrait', width: 512, height: 768 },
    ],
    checkpoint: {
      id: 128713,
      name: '8',
      trainedWords: [],
      modelId: 4384,
      modelName: 'DreamShaper',
      modelType: 'Checkpoint',
      baseModel: 'SD 1.5',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      covered: true,
      minor: false,
      available: true,
    } as GenerationResource,
  },
  SDXL: {
    additionalResourceTypes: [
      { type: ModelType.LORA, baseModelSet: 'SDXL' },
      { type: ModelType.DoRA, baseModelSet: 'SDXL' },
      { type: ModelType.LoCon, baseModelSet: 'SDXL' },
      { type: ModelType.TextualInversion, baseModelSet: 'SDXL', baseModels: ['SD 1.5'] },
      { type: ModelType.VAE, baseModelSet: 'SDXL' },
    ] as ResourceFilter[],
    aspectRatios: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1216, height: 832 },
      { label: 'Portrait', width: 832, height: 1216 },
    ],
    checkpoint: {
      id: 128078,
      name: 'v1.0 VAE fix',
      trainedWords: [],
      modelId: 101055,
      modelName: 'SD XL',
      modelType: 'Checkpoint',
      baseModel: 'SDXL 1.0',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      covered: true,
      minor: false,
      available: true,
    } as GenerationResource,
  },
  Pony: {
    additionalResourceTypes: [
      {
        type: ModelType.LORA,
        baseModelSet: 'Pony',
        baseModels: ['SDXL 0.9', 'SDXL 1.0', 'SDXL 1.0 LCM'],
      },
      {
        type: ModelType.DoRA,
        baseModelSet: 'Pony',
        baseModels: ['SDXL 0.9', 'SDXL 1.0', 'SDXL 1.0 LCM'],
      },
      {
        type: ModelType.LoCon,
        baseModelSet: 'Pony',
        baseModels: ['SDXL 0.9', 'SDXL 1.0', 'SDXL 1.0 LCM'],
      },
      { type: ModelType.TextualInversion, baseModelSet: 'Pony', baseModels: ['SD 1.5'] },
      { type: ModelType.VAE, baseModelSet: 'SDXL' },
    ] as ResourceFilter[],
    aspectRatios: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1216, height: 832 },
      { label: 'Portrait', width: 832, height: 1216 },
    ],
    checkpoint: {
      id: 290640,
      name: 'V6 (start with this one)',
      trainedWords: [],
      modelId: 257749,
      modelName: 'Pony Diffusion V6 XL',
      modelType: 'Checkpoint',
      baseModel: 'Pony',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      covered: true,
      minor: false,
      available: true,
    } as GenerationResource,
  },
};

// export type GenerationBaseModel = keyof typeof generationConfig;

export function getGenerationConfig(baseModel = 'SD1') {
  if (!(baseModel in generationConfig))
    throw new Error(`unsupported baseModel: ${baseModel} in generationConfig`);
  return generationConfig[baseModel as keyof typeof generationConfig];
}

export const MODELS_SEARCH_INDEX = 'models_v9';
export const IMAGES_SEARCH_INDEX = 'images_v6';
export const ARTICLES_SEARCH_INDEX = 'articles_v5';
export const USERS_SEARCH_INDEX = 'users_v3';
export const COLLECTIONS_SEARCH_INDEX = 'collections_v3';
export const BOUNTIES_SEARCH_INDEX = 'bounties_v3';

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
  {
    icon: ForwardRefExoticComponent<IconProps & RefAttributes<Icon>>;
    color: (theme: MantineTheme) => string;
    fill?: (theme: MantineTheme) => string | string;
  }
> = {
  [Currency.BUZZ]: {
    icon: IconBolt,
    color: (theme) => theme.colors.yellow[7],
    fill: (theme) => theme.colors.yellow[7],
  },
  [Currency.USD]: {
    icon: IconCurrencyDollar,
    color: (theme) => theme.colors.yellow[7],
    fill: undefined,
  },
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

export const RECAPTCHA_ACTIONS = {
  STRIPE_TRANSACTION: 'STRIPE_TRANSACTION',
  COMPLETE_ONBOARDING: 'COMPLETE_ONBOARDING',
} as const;

export type RecaptchaAction = keyof typeof RECAPTCHA_ACTIONS;

export const creatorCardStats = [
  'followers',
  'likes',
  'uploads',
  'downloads',
  'generations',
  'reactions',
];
export const creatorCardStatsDefaults = ['followers', 'likes'];
export const creatorCardMaxStats = 3;

export const milestoneNotificationFix = '2024-04-20';

export const orchestratorIntegrationDate = new Date('7-12-2024');
export const downloadGeneratedImagesByDate = increaseDate(orchestratorIntegrationDate, 30, 'days');
