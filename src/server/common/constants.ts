import type { MantineTheme } from '@mantine/core';
import {
  BountyType,
  Currency,
  MetricTimeframe,
  ModelStatus,
  ModelVersionMonetizationType,
  ModelVersionSponsorshipSettingsType,
  ReviewReactions,
} from '~/shared/utils/prisma/enums';
import { Icon, IconBolt, IconCurrencyDollar, IconProps } from '@tabler/icons-react';
import { ForwardRefExoticComponent, RefAttributes } from 'react';
import { env } from '~/env/client';
import { BanReasonCode, ModelSort } from '~/server/common/enums';
import { IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { increaseDate } from '~/utils/date-helpers';
import { ArticleSort, CollectionSort, ImageSort, PostSort, QuestionSort } from './enums';
import { GenerationResource } from '~/server/services/generation/generation.service';

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
    'SD 3.5',
    'SD 3.5 Medium',
    'SD 3.5 Large',
    'SD 3.5 Large Turbo',
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
    'Hunyuan Video',
    'Lumina',
    'Kolors',
    'Illustrious',
    'Mochi',
    'LTXV',
    'CogVideoX',
    'Other',
  ],
  hiddenBaseModels: [
    'ODOR',
    'SD 2.1 768',
    'SD 2.1 Unclip',
    'SDXL Distilled',
    'SDXL 0.9',
    'SD 2.0 768',
    'SDXL Turbo',
    'SVD XT',
    'Playground v2',
    'Stable Cascade',
    'SDXL 1.0 LCM',
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
  modelFileFormats: ['SafeTensor', 'PickleTensor', 'GGUF', 'Diffusers', 'Core ML', 'ONNX', 'Other'],
  modelFileSizes: ['full', 'pruned'],
  modelFileFp: ['fp16', 'fp8', 'nf4', 'fp32', 'bf16'],
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
    subjects: ['man', 'woman', 'men', 'women'] as string[],
  },
  maxTrainingRetries: 2,
  mediaUpload: {
    maxOrchestratorImageFileSize: 60 * 1024 ** 2, // 16MB
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
    getMaxDepth({ entityType }: { entityType: string }) {
      switch (entityType) {
        case 'image':
        case 'bountyEntry':
          return 3;
        default:
          return 5;
      }
    },
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
  supporterBadge: '69e4b7fd-129f-45bc-889b-81a846aa0d13',
  memberships: {
    tierOrder: ['free', 'founder', 'bronze', 'silver', 'gold'],
    badges: {
      free: '69e4b7fd-129f-45bc-889b-81a846aa0d13',
      founder: '69e4b7fd-129f-45bc-889b-81a846aa0d13',
      bronze: '69e4b7fd-129f-45bc-889b-81a846aa0d13',
      silver: 'c06c4d84-11f1-49ca-824c-2d7371c23366',
      gold: 'eae8457a-8b18-41a5-8ee7-2b99a1c663c6',
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
    badge: '69e4b7fd-129f-45bc-889b-81a846aa0d13',
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
    article: 6341,
    buzzChargedPerDay: 100,
    timeframeValues: [3, 5, 7, 9, 12, 15],
    scoreTimeFrameUnlock: [
      // The maximum amount of days that can be set based off of score.
      [40000, 3],
      [65000, 5],
      [90000, 7],
      [125000, 9],
      [200000, 12],
      [250000, 15],
    ],
    scoreQuantityUnlock: [
      // How many items can be marked EA at the same time based off of score.
      [40000, 1],
      [65000, 2],
      [90000, 4],
      [125000, 6],
      [200000, 8],
      [250000, 20],
    ],
  },
  autoLabel: {
    labelTypes: ['tag', 'caption'] as const,
  },
} as const;
export const activeBaseModels = constants.baseModels.filter(
  (model) => !constants.hiddenBaseModels.includes(model)
);

export const maxOrchestratorImageFileSize = 16 * 1024 ** 2; // 16MB
export const maxImageFileSize = 50 * 1024 ** 2; // 50MB
export const maxVideoFileSize = 750 * 1024 ** 2; // 750MB
export const maxVideoDimension = 3840;
export const maxVideoDurationSeconds = 245;
export const orchestratorUrls = [
  'https://orchestration.civitai.com',
  'https://orchestration-dev.civitai.com',
];
export function isOrchestratorUrl(url: string) {
  return orchestratorUrls.some((orchestratorUrl) => url.startsWith(orchestratorUrl));
}

export const zipModelFileTypes: ModelFileFormat[] = ['Core ML', 'Diffusers', 'ONNX'];
export type ZipModelFileType = (typeof zipModelFileTypes)[number];

export const POST_IMAGE_LIMIT = 20;
export const POST_TAG_LIMIT = 5;
export const CAROUSEL_LIMIT = 20;
export const DEFAULT_EDGE_IMAGE_WIDTH = 450;
export const MAX_ANIMATION_DURATION_SECONDS = 30;
export const MAX_POST_IMAGES_WIDTH = 800;

export type BaseModelType = (typeof constants.baseModelTypes)[number];

export type BaseModel = (typeof constants.baseModels)[number];

class BaseModelSet<TBaseModel, THidden extends TBaseModel> {
  name: string;
  baseModels: StringLiteral<TBaseModel>[];
  hidden?: StringLiteral<THidden>[];
  constructor(args: {
    name: string;
    baseModels: StringLiteral<TBaseModel>[];
    hidden?: StringLiteral<THidden>[];
  }) {
    this.name = args.name;
    this.baseModels = args.baseModels;
    this.hidden = args.hidden;
  }
}

export const baseModelSets = {
  SD1: new BaseModelSet({
    name: 'Stable Diffusion',
    baseModels: ['SD 1.4', 'SD 1.5', 'SD 1.5 LCM', 'SD 1.5 Hyper'],
  }),
  SD2: new BaseModelSet({
    name: 'Stable Diffusion',
    baseModels: ['SD 2.0', 'SD 2.0 768', 'SD 2.1', 'SD 2.1 768', 'SD 2.1 Unclip'],
    hidden: ['SD 2.1 768', 'SD 2.1 Unclip', 'SD 2.0 768'],
  }),
  SD3: new BaseModelSet({
    name: 'Stable Diffusion',
    baseModels: ['SD 3', 'SD 3.5', 'SD 3.5 Large', 'SD 3.5 Large Turbo'],
  }),
  SD3_5M: new BaseModelSet({
    name: 'Stable Diffusion',
    baseModels: ['SD 3.5 Medium'],
  }),
  Flux1: new BaseModelSet({ name: 'Flux', baseModels: ['Flux.1 S', 'Flux.1 D'] }),
  SDXL: new BaseModelSet({
    name: 'Stable Diffusion XL',
    baseModels: [
      'SDXL 0.9',
      'SDXL 1.0',
      'SDXL 1.0 LCM',
      'SDXL Lightning',
      'SDXL Hyper',
      'SDXL Turbo',
    ],
    hidden: ['SDXL 0.9', 'SDXL Turbo', 'SDXL 1.0 LCM'],
  }),
  SDXLDistilled: new BaseModelSet({
    name: 'Stable Diffusion XL',
    baseModels: ['SDXL Distilled'],
    hidden: ['SDXL Distilled'],
  }),
  PixArtA: new BaseModelSet({ name: 'PixArt alpha', baseModels: ['PixArt a'] }),
  PixArtE: new BaseModelSet({ name: 'PixArt sigma', baseModels: ['PixArt E'] }),
  Lumina: new BaseModelSet({ name: 'Lumina', baseModels: ['Lumina'] }),
  Kolors: new BaseModelSet({ name: 'Kolors', baseModels: ['Kolors'] }),
  HyDit1: new BaseModelSet({ name: 'Hunyuan DiT', baseModels: ['Hunyuan 1'] }),
  HyV1: new BaseModelSet({ name: 'Hunyuan Video', baseModels: ['Hunyuan Video'] }),
  SCascade: new BaseModelSet({ name: 'Stable Cascade', baseModels: ['Stable Cascade'] }),
  ODOR: new BaseModelSet({ name: 'ODOR', baseModels: ['Odor'], hidden: ['Odor'] }),
  Pony: new BaseModelSet({ name: 'Stable Diffusion', baseModels: ['Pony'] }),
  Illustrious: new BaseModelSet({ name: 'Illustrious', baseModels: ['Illustrious'] }),
  Other: new BaseModelSet({ name: 'Other', baseModels: ['Other'] }),
  Mochi: new BaseModelSet({ name: 'Mochi', baseModels: ['Mochi'] }),
  LTXV: new BaseModelSet({ name: 'LTXV', baseModels: ['LTXV'] }),
  CogVideoX: new BaseModelSet({ name: 'CogVideoX', baseModels: ['CogVideoX'] }),
};

type BaseModelSets = typeof baseModelSets;
export type BaseModelSetType = keyof BaseModelSets;
// export const baseModelSetTypes = Object.keys(baseModelSets) as BaseModelSetType[];
// type BaseModels = BaseModelSets[BaseModelSetType]['baseModels'][number];

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
  'hunyuan video': {
    url: 'https://huggingface.co/tencent/HunyuanVideo/blob/main/LICENSE',
    name: 'Tencent Hunyuan Community License Agreement',
    notice:
      'Tencent Hunyuan is licensed under the Tencent Hunyuan Community License Agreement, Copyright © 2024 Tencent. All Rights Reserved. The trademark rights of “Tencent Hunyuan” are owned by Tencent or its affiliate.',
    poweredBy: 'Powered by Tencent Hunyuan',
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
  'illustrious license': {
    url: 'https://freedevproject.org/faipl-1.0-sd/',
    name: 'Illustrious License',
  },
  'ltxv license': {
    url: 'https://huggingface.co/Lightricks/LTX-Video/blob/main/License.txt',
    name: 'LTX Video License',
  },
  'cogvideox license': {
    url: 'https://huggingface.co/THUDM/CogVideoX-5b/blob/main/LICENSE',
    name: 'CogVideoX License',
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
  'SD 3.5': baseLicenses['SAI CLA'],
  'SD 3.5 Medium': baseLicenses['SAI CLA'],
  'SD 3.5 Large': baseLicenses['SAI CLA'],
  'SD 3.5 Large Turbo': baseLicenses['SAI CLA'],
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
  'Hunyuan Video': baseLicenses['hunyuan video'],
  Lumina: baseLicenses['apache 2.0'],
  Kolors: baseLicenses['kolors license'],
  'Stable Cascade': baseLicenses['SAI NC RC'],
  Pony: baseLicenses['openrail++'],
  AuraFlow: baseLicenses['apache 2.0'],
  'Flux.1 S': baseLicenses['apache 2.0'],
  'Flux.1 D': baseLicenses['flux1D'],
  ODOR: undefined,
  Other: undefined,
  Illustrious: baseLicenses['illustrious license'],
  Mochi: baseLicenses['apache 2.0'],
  LTXV: baseLicenses['ltxv license'],
  CogVideoX: baseLicenses['cogvideox license'],
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
  undefined: 4,
} as const;

export const generationConfig = {
  SD1: {
    aspectRatios: [
      { label: 'Square', width: 512, height: 512 },
      { label: 'Landscape', width: 768, height: 512 },
      { label: 'Portrait', width: 512, height: 768 },
    ],
    checkpoint: {
      id: 128713,
      name: '8',
      trainedWords: [],
      baseModel: 'SD 1.5',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      covered: true,
      model: {
        id: 4384,
        name: 'DreamShaper',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  SDXL: {
    aspectRatios: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1216, height: 832 },
      { label: 'Portrait', width: 832, height: 1216 },
    ],
    checkpoint: {
      id: 128078,
      name: 'v1.0 VAE fix',
      trainedWords: [],
      baseModel: 'SDXL 1.0',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      covered: true,
      model: {
        id: 101055,
        name: 'SD XL',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Pony: {
    aspectRatios: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1216, height: 832 },
      { label: 'Portrait', width: 832, height: 1216 },
    ],
    checkpoint: {
      id: 290640,
      name: 'V6 (start with this one)',
      trainedWords: [],
      baseModel: 'Pony',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      covered: true,
      model: {
        id: 257749,
        name: 'Pony Diffusion V6 XL',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Illustrious: {
    aspectRatios: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1216, height: 832 },
      { label: 'Portrait', width: 832, height: 1216 },
    ],
    checkpoint: {
      id: 889818,
      name: 'v0.1',
      trainedWords: [],
      baseModel: 'Illustrious',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      covered: true,
      model: {
        id: 795765,
        name: 'Illustrious-XL',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Flux1: {
    aspectRatios: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1216, height: 832 },
      { label: 'Portrait', width: 832, height: 1216 },
    ],
    checkpoint: {
      id: 691639,
      name: '',
      trainedWords: [],
      baseModel: 'Flux.1 D',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      covered: true,
      model: {
        id: 618692,
        name: 'FLUX',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  SD3: {
    aspectRatios: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1216, height: 832 },
      { label: 'Portrait', width: 832, height: 1216 },
    ],
    checkpoint: {
      id: 983309,
      name: 'Large',
      trainedWords: [],
      baseModel: 'SD 3.5',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      covered: true,
      model: {
        id: 878387,
        name: 'Stable Diffusion 3.5 Large',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  SD3_5M: {
    aspectRatios: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1216, height: 832 },
      { label: 'Portrait', width: 832, height: 1216 },
    ],
    checkpoint: {
      id: 1003708,
      name: 'Medium',
      trainedWords: [],
      baseModel: 'SD 3.5 Medium',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      covered: true,
      model: {
        id: 896953,
        name: 'Stable Diffusion 3.5 Medium',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Other: {
    aspectRatios: [] as { label: string; width: number; height: number }[],
    checkpoint: {
      id: 164821,
      name: '',
      trainedWords: [],
      baseModel: 'Other',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      covered: true,
      model: {
        id: 147759,
        name: 'Remacri',
        type: 'Upscaler',
      },
    } as GenerationResource,
  },
};

export const generation = {
  formStoreKey: 'generation-form',
  samplers: Object.keys(samplerOffsets) as (keyof typeof samplerOffsets)[],
  lcmSamplers: ['LCM', 'Euler a'] as Sampler[],
  defaultValues: {
    workflow: 'txt2img',
    cfgScale: 3.5,
    steps: 25,
    sampler: 'DPM++ 2M Karras',
    seed: undefined,
    clipSkip: 2,
    quantity: 2,
    aspectRatio: '0',
    prompt: '',
    negativePrompt: '',
    nsfw: false,
    baseModel: 'Flux1',
    denoise: 0.4,
    upscale: 1.5,
    civitaiTip: 0,
    creatorTip: 0.25,
    fluxUltraAspectRatio: '4',
    fluxMode: 'urn:air:flux1:checkpoint:civitai:618692@691639',
    model: generationConfig.Flux1.checkpoint,
    priority: 'low',
  },
  maxValues: {
    seed: 4294967295,
    clipSkip: 3,
  },
} as const;
export const maxRandomSeed = 2147483647;

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
export const TOOLS_SEARCH_INDEX = 'tools_v2';

// Metrics:
export const METRICS_IMAGES_SEARCH_INDEX = 'metrics_images_v1';

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

type CurrencyTheme = {
  icon: ForwardRefExoticComponent<IconProps & RefAttributes<Icon>>;
  color: (theme: MantineTheme) => string;
  fill?: (theme: MantineTheme) => string | undefined;
};

export const CurrencyConfig: Record<
  Currency,
  CurrencyTheme & { themes?: Record<string, CurrencyTheme> }
> = {
  [Currency.BUZZ]: {
    icon: IconBolt,
    color: (theme) => theme.colors.yellow[7],
    fill: (theme) => theme.colors.yellow[7],
    themes: {
      generation: {
        icon: IconBolt,
        color: (theme) => theme.colors.blue[4],
        fill: (theme) => theme.colors.blue[4],
      },
    },
  },
  [Currency.USD]: {
    icon: IconCurrencyDollar,
    color: (theme) => theme.colors.yellow[7],
    fill: undefined,
  },
};

export const BUZZ_FEATURE_LIST = [
  'Support your favorite creators via tips',
  'Pay for on-site model training',
  'Create bounties for models, images and more!',
  'Purchase profile cosmetics from our Cosmetic Store!',
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
  PADDLE_TRANSACTION: 'PADDLE_TRANSACTION',
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

export const colorDomains = {
  green: env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN,
  blue: env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE,
  red: env.NEXT_PUBLIC_SERVER_DOMAIN_RED,
};
export type ColorDomain = keyof typeof colorDomains;

export function getRequestDomainColor(req: { headers: { host?: string } }) {
  const { host } = req.headers;
  if (!host) return undefined;
  for (const [color, domain] of Object.entries(colorDomains)) {
    if (host === domain) return color as ColorDomain;
  }
}

export const banReasonDetails: Record<
  BanReasonCode,
  {
    code: BanReasonCode;
    publicBanReasonLabel?: string;
    privateBanReasonLabel: string;
  }
> = {
  [BanReasonCode.SexualMinor]: {
    code: BanReasonCode.SexualMinor,
    publicBanReasonLabel: 'Content violated ToS',
    privateBanReasonLabel: 'Images of minors displayed sexually',
  },
  [BanReasonCode.SexualMinorGenerator]: {
    code: BanReasonCode.SexualMinorGenerator,
    publicBanReasonLabel: 'Content violated ToS',
    privateBanReasonLabel: 'Prompting for minors displayed sexually in the generator',
  },
  [BanReasonCode.SexualMinorTraining]: {
    code: BanReasonCode.SexualMinorTraining,
    publicBanReasonLabel: 'Content violated ToS',
    privateBanReasonLabel: 'Training resources on minors displayed sexually',
  },
  [BanReasonCode.SexualPOI]: {
    code: BanReasonCode.SexualPOI,
    publicBanReasonLabel: 'Content violated ToS',
    privateBanReasonLabel: 'Images of real people displayed sexually',
  },
  [BanReasonCode.Bestiality]: {
    code: BanReasonCode.Bestiality,
    publicBanReasonLabel: 'Content violated ToS',
    privateBanReasonLabel: 'Images depicting bestiality',
  },
  [BanReasonCode.Scat]: {
    code: BanReasonCode.Scat,
    publicBanReasonLabel: 'Content violated ToS',
    privateBanReasonLabel: 'Images depicting scat',
  },
  [BanReasonCode.Harassment]: {
    code: BanReasonCode.Harassment,
    publicBanReasonLabel: 'Community Abuse',
    privateBanReasonLabel: 'Harassing or spamming users',
  },
  [BanReasonCode.LeaderboardCheating]: {
    code: BanReasonCode.LeaderboardCheating,
    publicBanReasonLabel: 'Leaderboard manipulation',
    privateBanReasonLabel: 'Leaderboard manipulation',
  },
  [BanReasonCode.BuzzCheating]: {
    code: BanReasonCode.BuzzCheating,
    publicBanReasonLabel: 'Abusing Buzz System',
    privateBanReasonLabel: 'Abusing Buzz System',
  },
  [BanReasonCode.Other]: {
    code: BanReasonCode.Other,
    publicBanReasonLabel: '',
    privateBanReasonLabel: 'Other',
  },
};

export const HOLIDAY_PROMO_VALUE = 0.2;

export const MAX_APPEAL_MESSAGE_LENGTH = 220;

export const FEATURED_MODEL_COLLECTION_ID = 104;
