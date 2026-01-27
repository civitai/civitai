import { env } from '~/env/client';
import { BanReasonCode, ModelSort, NsfwLevel } from '~/server/common/enums';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import {
  BountyType,
  Currency,
  MetricTimeframe,
  ModelStatus,
  ModelVersionMonetizationType,
  ModelVersionSponsorshipSettingsType,
  ReviewReactions,
} from '~/shared/utils/prisma/enums';
import { increaseDate } from '~/utils/date-helpers';
import { ArticleSort, CollectionSort, ImageSort, PostSort, QuestionSort } from './enums';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { BaseModel } from '~/shared/constants/base-model.constants';

export const lipsum = `
Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.
`;

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
  trainingMediaTypes: ['image', 'video'],
  trainingModelTypes: ['Character', 'Style', 'Concept', 'Effect'],
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
    accept: [...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE],
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
    epochGenerationTimeLimit: 15, // In days
  },
  tagVoting: {
    voteDuration: 1000 * 60 * 60 * 24,
    upvoteThreshold: 3,
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
    maxChargeAmount: 500000, // $500.00
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
  profanity: {
    thresholds: {
      shortContentWordLimit: 100,
      shortContentMatchThreshold: 5,
      longContentDensityThreshold: 0.02, // 2%
      diversityThreshold: 10,
    },
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
    maxLength: 50000, // 50k characters
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
  supporterBadge: '69b4d872-fdc1-4b72-8a4b-258c0065e1aa',
  memberships: {
    tierOrder: ['free', 'founder', 'bronze', 'silver', 'gold'],
    badges: {
      free: '69b4d872-fdc1-4b72-8a4b-258c0065e1aa',
      founder: '69b4d872-fdc1-4b72-8a4b-258c0065e1aa',
      bronze: '69b4d872-fdc1-4b72-8a4b-258c0065e1aa',
      silver: '6961e252-3f94-4eee-ae79-01af2403fa49',
      gold: '8e9f9aa3-74ce-443c-bf4a-e298b9019f42',
    },
    founderDiscount: {
      maxDiscountDate: new Date('2024-05-01T00:00:00Z'),
      discountPercent: 50,
      tier: 'founder',
    },
    membershipDetailsAddons: {
      free: {
        maxPrivateModels: 0,
        supportLevel: 'Basic',
      },
      founder: {
        maxPrivateModels: 3,
        supportLevel: 'Priority',
      },
      bronze: {
        maxPrivateModels: 3,
        supportLevel: 'Priority',
      },
      silver: {
        maxPrivateModels: 10,
        supportLevel: 'Premium',
      },
      gold: {
        maxPrivateModels: 100,
        supportLevel: 'VIP',
      },
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
    maxPinnedPosts: 20,
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

  autoLabel: {
    labelTypes: ['tag', 'caption'] as const,
  },
} as const;

export const maxOrchestratorImageFileSize = 24 * 1024 ** 2; // 24MB
export const maxImageFileSize = 50 * 1024 ** 2; // 50MB
export const maxVideoFileSize = 750 * 1024 ** 2; // 750MB
export const maxVideoDimension = 3840;
export const maxVideoDurationSeconds = 245;

export function isOrchestratorUrl(url: string) {
  try {
    const { host } = new URL(url);
    return /^orchestration[a-z0-9-]*\.civitai\.com$/i.test(host);
  } catch {
    return false;
  }
}

export const zipModelFileTypes: ModelFileFormat[] = ['Core ML', 'Diffusers', 'ONNX'];
export type ZipModelFileType = (typeof zipModelFileTypes)[number];

export const POST_IMAGE_LIMIT = 20;
export const POST_TAG_LIMIT = 5;
export const POST_MINIMUM_SCHEDULE_MINUTES = 60;
export const CAROUSEL_LIMIT = 20;
export const DEFAULT_EDGE_IMAGE_WIDTH = 450;
export const MAX_ANIMATION_DURATION_SECONDS = 30;
export const MAX_POST_IMAGES_WIDTH = 800;

export type BaseModelType = (typeof constants.baseModelTypes)[number];

type LicenseDetails = {
  url: string;
  name: string;
  notice?: string;
  poweredBy?: string;
  restrictedNsfwLevels?: NsfwLevel[];
};
const baseLicenses: Record<string, LicenseDetails> = {
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
    restrictedNsfwLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
  },
  svd: {
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDV',
    name: 'Stable Video Diffusion Non-Commercial Research Community License',
    notice:
      'Stable Video Diffusion is licensed under the Stable Video Diffusion Research License, Copyright (c) Stability AI Ltd. All Rights Reserved.',
    restrictedNsfwLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
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
    restrictedNsfwLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
  },
  'SAI CLA': {
    url: '',
    name: 'Stability AI Community License Agreement',
    notice:
      'This Stability AI Model is licensed under the Stability AI Community License, Copyright (c)  Stability AI Ltd. All Rights Reserved.',
    poweredBy: 'Powered by Stability AI',
    restrictedNsfwLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
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
  noobAi: {
    url: 'https://huggingface.co/Laxhar/noobai-XL-1.0/blob/main/README.md#model-license',
    name: 'NoobAI License',
  },
  mit: {
    url: 'https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/mit.md',
    name: 'MIT',
  },
  openai: {
    url: 'https://openai.com/policies/',
    name: 'OpenAI',
  },
  imagen4: {
    url: 'https://deepmind.google/about/responsibility-safety/',
    name: 'Imagen4',
  },
  veo3: {
    url: 'https://policies.google.com/terms',
    name: 'Veo 3',
  },
  seedream: {
    url: 'https://seed.bytedance.com/en/user-agreement',
    name: 'Seedream',
  },
  ponyV7: {
    url: 'https://purplesmart.ai/license',
    name: 'Pony',
  },
  ltxv2: {
    url: 'https://github.com/Lightricks/LTX-2/blob/main/LICENSE',
    name: 'LTXV2',
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
  'Pony V7': baseLicenses['ponyV7'],
  AuraFlow: baseLicenses['apache 2.0'],
  Chroma: baseLicenses['apache 2.0'],
  'Flux.1 S': baseLicenses['apache 2.0'],
  'Flux.1 D': baseLicenses['flux1D'],
  'Flux.1 Krea': baseLicenses['flux1D'],
  'Flux.1 Kontext': baseLicenses['flux1D'],
  'Flux.2 D': baseLicenses['flux1D'],
  'Flux.2 Klein 9B': baseLicenses['flux1D'],
  'Flux.2 Klein 9B-base': baseLicenses['flux1D'],
  'Flux.2 Klein 4B': baseLicenses['apache 2.0'],
  'Flux.2 Klein 4B-base': baseLicenses['apache 2.0'],
  ODOR: undefined,
  Other: undefined,
  Illustrious: baseLicenses['illustrious license'],
  Mochi: baseLicenses['apache 2.0'],
  LTXV: baseLicenses['ltxv license'],
  LTXV2: baseLicenses['ltxv2'],
  CogVideoX: baseLicenses['cogvideox license'],
  NoobAI: baseLicenses['noobAi'],
  HiDream: baseLicenses['mit'],
  OpenAI: baseLicenses['openai'],
  'Nano Banana': baseLicenses['imagen4'],
  Imagen4: baseLicenses['imagen4'],
  'Veo 3': baseLicenses['veo3'],
  'Wan Video': baseLicenses['apache 2.0'],
  'Wan Video 1.3B t2v': baseLicenses['apache 2.0'],
  'Wan Video 14B t2v': baseLicenses['apache 2.0'],
  'Wan Video 14B i2v 480p': baseLicenses['apache 2.0'],
  'Wan Video 14B i2v 720p': baseLicenses['apache 2.0'],
  'Wan Video 2.2 I2V-A14B': baseLicenses['apache 2.0'],
  'Wan Video 2.2 T2V-A14B': baseLicenses['apache 2.0'],
  'Wan Video 2.2 TI2V-5B': baseLicenses['apache 2.0'],
  'Wan Video 2.5 T2V': baseLicenses['apache 2.0'],
  'Wan Video 2.5 I2V': baseLicenses['apache 2.0'],
  Qwen: baseLicenses['apache 2.0'],
  Seedream: baseLicenses['seedream'],
  'Sora 2': baseLicenses['openai'],
  ZImageTurbo: baseLicenses['apache 2.0'],
  ZImageBase: baseLicenses['apache 2.0'],
};

export type ModelFileType = (typeof constants.modelFileTypes)[number];
export type Sampler = (typeof constants.samplers)[number];

// Base models that use licenses with NSFW restrictions
export const nsfwRestrictedBaseModels: BaseModel[] = Object.entries(baseModelLicenses)
  .filter(
    ([, license]) =>
      license && license.restrictedNsfwLevels && license.restrictedNsfwLevels.length > 0
  )
  .map(([baseModel]) => baseModel as BaseModel);

export function getRestrictedNsfwLevelsForBaseModel(baseModel: string): NsfwLevel[] {
  const license = baseModelLicenses[baseModel as BaseModel];
  return license?.restrictedNsfwLevels || [];
}

export function isNsfwLevelRestrictedForBaseModel(
  baseModel: string,
  nsfwLevel: NsfwLevel
): boolean {
  const restrictedLevels = getRestrictedNsfwLevelsForBaseModel(baseModel);
  return restrictedLevels.includes(nsfwLevel);
}

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

const commonAspectRatios = [
  { label: 'Square', width: 1024, height: 1024 },
  { label: 'Landscape', width: 1216, height: 832 },
  { label: 'Portrait', width: 832, height: 1216 },
];

const seedreamSizes = [
  { label: '16:9', width: 2560, height: 1440 },
  { label: '4:3', width: 2304, height: 1728 },
  { label: '1:1', width: 2048, height: 2048 },
  { label: '3:4', width: 1728, height: 2304 },
  { label: '9:16', width: 1440, height: 2560 },
];

const seedreamSizes4K = [
  { label: '16:9', width: 4096, height: 2304 },
  { label: '4:3', width: 4096, height: 3072 },
  { label: '1:1', width: 4096, height: 4096 },
  { label: '3:4', width: 3072, height: 4096 },
  { label: '9:16', width: 2304, height: 4096 },
];

export const qwenSizes = [
  { label: '16:9', width: 1664, height: 928 },
  { label: '4:3', width: 1472, height: 1104 },
  { label: '1:1', width: 1328, height: 1328 },
  { label: '3:4', width: 1104, height: 1472 },
  { label: '9:16', width: 928, height: 1664 },
];

export const ponyV7Sizes = [
  { label: '3:2', width: 1536, height: 1024 },
  { label: '6:5', width: 1536, height: 1280 },
  { label: '1:1', width: 1536, height: 1536 },
  { label: '5:6', width: 1280, height: 1536 },
  { label: '2:3', width: 1024, height: 1536 },
];

const nanoBananaProSizes = [
  { label: '16:9', width: 2560, height: 1440 },
  { label: '4:3', width: 2304, height: 1728 },
  { label: '1:1', width: 2048, height: 2048 },
  { label: '3:4', width: 1728, height: 2304 },
  { label: '9:16', width: 1440, height: 2560 },
];

export const generationResourceConfig: Record<number, MixedObject> = {
  2470991: {
    aspectRatios: seedreamSizes4K,
  },
};

export type GenerationConfigKey = keyof typeof generationConfig;
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
      model: {
        id: 4384,
        name: 'DreamShaper',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  SDXL: {
    aspectRatios: commonAspectRatios,
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
      model: {
        id: 101055,
        name: 'SD XL',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Pony: {
    aspectRatios: commonAspectRatios,
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
      model: {
        id: 257749,
        name: 'Pony Diffusion V6 XL',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  PonyV7: {
    aspectRatios: ponyV7Sizes,
    checkpoint: {
      id: 2152373,
      name: 'v7.0',
      trainedWords: [],
      baseModel: 'PonyV7',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1901521,
        name: 'Pony V7',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Illustrious: {
    aspectRatios: commonAspectRatios,
    // doesn't work for all illustrios models
    // aspectRatios: [
    //   { label: 'Square', width: 1536, height: 1536 },
    //   { label: 'Landscape', width: 1920, height: 1280 },
    //   { label: 'Portrait', width: 1280, height: 1920 },
    // ],
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
      model: {
        id: 795765,
        name: 'Illustrious-XL',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Chroma: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 2164239,
      name: 'v1.0-HD',
      trainedWords: [],
      baseModel: 'Chroma',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1330309,
        name: 'Chroma',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  NoobAI: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 1190596,
      name: 'V-Pred-1.0-Version',
      trainedWords: [],
      baseModel: 'NoobAI',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 833294,
        name: 'NoobAI-XL (NAI-XL)',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Flux1: {
    aspectRatios: commonAspectRatios,
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
      model: {
        id: 618692,
        name: 'FLUX',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  FluxKrea: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 2068000,
      name: '',
      trainedWords: [],
      baseModel: 'Flux.1 Krea',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 618692,
        name: 'FLUX',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Flux2: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 2439067,
      name: '',
      trainedWords: [],
      baseModel: 'Flux.2 D',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 2165902,
        name: 'FLUX.2',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Qwen: {
    aspectRatios: qwenSizes,
    checkpoint: {
      id: 2552908,
      name: 'fp8_e4m3fn',
      trainedWords: [],
      baseModel: 'Qwen',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 2268063,
        name: 'Qwen-Image-2512',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Seedream: {
    aspectRatios: seedreamSizes,
    checkpoint: {
      id: 2470991,
      name: 'v4.5',
      trainedWords: [],
      baseModel: 'Seedream',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1951069,
        name: 'Seedream',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  HiDream: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 1771369,
      name: '',
      trainedWords: [],
      baseModel: 'HiDream',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      covered: true,
      model: {
        id: 1562709,
        name: 'HiDream',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Flux1Kontext: {
    aspectRatios: [
      { label: '21:9', width: 21, height: 9 },
      { label: '16:9', width: 16, height: 9 },
      { label: '4:3', width: 4, height: 3 },
      { label: '3:2', width: 3, height: 2 },
      { label: '1:1', width: 1, height: 1 },
      { label: '2:3', width: 2, height: 3 },
      { label: '3:4', width: 3, height: 4 },
      { label: '9:16', width: 9, height: 16 },
      { label: '9:21', width: 9, height: 21 },
    ],
    checkpoint: {
      id: 1892509,
      name: 'Flux.1 Kontext [Pro]',
      trainedWords: [],
      baseModel: 'Flux.1 Kontext',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1672021,
        name: 'FLUX.1 Kontext',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  // SD3: {
  //   aspectRatios: commonAspectRatios,
  //   checkpoint: {
  //     id: 983309,
  //     name: 'Large',
  //     trainedWords: [],
  //     baseModel: 'SD 3.5',
  //     strength: 1,
  //     minStrength: -1,
  //     maxStrength: 2,
  //     canGenerate: true,
  //     hasAccess: true,
  //     model: {
  //       id: 878387,
  //       name: 'Stable Diffusion 3.5 Large',
  //       type: 'Checkpoint',
  //     },
  //   } as GenerationResource,
  // },
  // SD3_5M: {
  //   aspectRatios: commonAspectRatios,
  //   checkpoint: {
  //     id: 1003708,
  //     name: 'Medium',
  //     trainedWords: [],
  //     baseModel: 'SD 3.5 Medium',
  //     strength: 1,
  //     minStrength: -1,
  //     maxStrength: 2,
  //     canGenerate: true,
  //     hasAccess: true,
  //     model: {
  //       id: 896953,
  //       name: 'Stable Diffusion 3.5 Medium',
  //       type: 'Checkpoint',
  //     },
  //   } as GenerationResource,
  // },
  OpenAI: {
    aspectRatios: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1536, height: 1024 },
      { label: 'Portrait', width: 1024, height: 1536 },
    ],
    checkpoint: {
      id: 1733399,
      name: '4o Image Gen 1',
      trainedWords: [],
      baseModel: 'OpenAI',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1532032,
        name: `OpenAI's GPT-image-1`,
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },

  Imagen4: {
    aspectRatios: [
      { label: '16:9', width: 16, height: 9 },
      { label: '4:3', width: 4, height: 3 },
      { label: '1:1', width: 1, height: 1 },
      { label: '3:4', width: 3, height: 4 },
      { label: '9:16', width: 9, height: 16 },
    ],
    checkpoint: {
      id: 1889632,
      name: 'Imagen 4',
      trainedWords: [],
      baseModel: 'Imagen4',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1669468,
        name: `Google Imagen 4`,
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  NanoBanana: {
    aspectRatios: nanoBananaProSizes,
    checkpoint: {
      id: 2154472,
      name: 'Nano Banana',
      trainedWords: [],
      baseModel: 'NanoBanana',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1903424,
        name: `Google Nano Banana`,
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  ZImageTurbo: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 2442439,
      name: 'v1.0',
      trainedWords: [],
      baseModel: 'ZImageTurbo',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 2168935,
        name: 'ZImageTurbo',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  ZImageBase: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 2635223,
      name: 'Base',
      trainedWords: [],
      baseModel: 'ZImageBase',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 2342797,
        name: 'Z Image Base',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },

  Other: {
    aspectRatios: commonAspectRatios,
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
    seed: null,
    clipSkip: 2,
    quantity: 2,
    aspectRatio: '1:1',
    resolution: '2k',
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
    fluxUltraRaw: false,
    model: generationConfig.Flux1.checkpoint,
    priority: 'low',
    sourceImage: null,
    openAIQuality: 'medium',
    vae: null,
    resources: null,
    outputFormat: 'jpeg',
  },
  maxValues: {
    seed: 4294967295,
    clipSkip: 3,
  },
} as const;
export const maxRandomSeed = 2147483647;
export const maxUpscaleSize = 3840;
export const minDownscaleSize = 320;
export const minUploadSize = 300;

// export type GenerationBaseModel = keyof typeof generationConfig;

export function getGenerationConfig(baseModel = 'SD1', modelVersionId?: number) {
  if (!(baseModel in generationConfig)) {
    return getGenerationConfig(); // fallback to default config
    // throw new Error(`unsupported baseModel: ${baseModel} in generationConfig`);
  }

  const modelConfig = modelVersionId ? generationResourceConfig[modelVersionId] : undefined;
  const baseModelConfig = generationConfig[baseModel as keyof typeof generationConfig];
  return { ...baseModelConfig, ...modelConfig };
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

export const BUZZ_FEATURE_LIST = [
  'Pay for on-site model training',
  'Pay for on-site image generation',
  'Purchase early access to models',
  'Support your favorite creators via tips',
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

export const milestoneNotificationFix = '2025-05-28';

export const orchestratorIntegrationDate = new Date('7-12-2024');
export const downloadGeneratedImagesByDate = increaseDate(orchestratorIntegrationDate, 30, 'days');

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
  [BanReasonCode.Nudify]: {
    code: BanReasonCode.Nudify,
    publicBanReasonLabel: 'Content violated ToS',
    privateBanReasonLabel: 'Publishing resource that nudifies subjects',
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
  [BanReasonCode.RRDViolation]: {
    code: BanReasonCode.RRDViolation,
    publicBanReasonLabel: 'Violated Responsible Resource Development',
    privateBanReasonLabel: 'Violated Responsible Resource Development (e.g., deepfakes)',
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

export const newOrderConfig = {
  baseExp: 100,
  blessedBuzzConversionRatio: 1 / 1000,
  smiteSize: 10,
  welcomeImageUrl: 'f2a97014-c0e2-48ba-bb7d-99435922850b',
  cosmetics: {
    badgeIds: { acolyte: 858, knight: 859, templar: 860 },
  },
  limits: {
    knightVotes: 5,
    templarVotes: 2,
    templarPicks: 24,
    minKnightVotes: 4,
    maxKnightVotes: 10,
  },
};

export const buzzBulkBonusMultipliers = [
  // Order from bottom to top. This value SHOULD BE BASED OFF OF BUZZ.
  [250000, 1.1],
  [300000, 1.15],
  [400000, 1.2],
];

export const NOW_PAYMENTS_FIXED_FEE = 100; // 1.00 USD
export const COINBASE_FIXED_FEE = 0; // 0.00 USD

export const specialCosmeticRewards = {
  annualRewards: {
    gold: [
      870, // gold annual badge
      864, // cyan contentframe - gold annual
      865, // danger yellow contentframe - gold annual
    ],
    silver: [
      869, // silver annual badge
      863, // sword avatar - silver annual
      862, // robot background - silver annual
    ],
    bronze: [
      868, // bronze annual badge
      867, // poiny avatarframe - bronze annual
    ],
  },
  bulkBuzzRewards: [
    866, // bulk buzz buy - badge
    872, // bulk buzz buy - background
  ],
  crypto: [874],
};

export type LiveFeatureFlags = {
  buzzGiftCards: boolean;
  /** Custom training page announcement message. If null/empty, shows the default message. */
  trainingAnnouncement?: string | null;
};

export const DEFAULT_LIVE_FEATURE_FLAGS: LiveFeatureFlags = {
  buzzGiftCards: false,
  trainingAnnouncement: null,
};

export const EARLY_ACCESS_CONFIG: {
  article: number;
  buzzChargedPerDay: number;
  timeframeValues: number[];
  scoreTimeFrameUnlock: Array<[number | ((args: { features?: FeatureAccess }) => boolean), number]>;
  scoreQuantityUnlock: Array<[number | ((args: { features?: FeatureAccess }) => boolean), number]>;
} = {
  article: 6341,
  buzzChargedPerDay: 100,
  timeframeValues: [3, 5, 7, 9, 12, 15, 30],
  scoreTimeFrameUnlock: [
    // The maximum amount of days that can be set based off of score.
    [40000, 3],
    [65000, 5],
    [90000, 7],
    [125000, 9],
    [200000, 12],
    [250000, 15],
    [({ features }: { features?: FeatureAccess }) => features?.thirtyDayEarlyAccess ?? false, 30],
  ],
  scoreQuantityUnlock: [
    // How many items can be marked EA at the same time based off of score.
    [40000, 1],
    [65000, 2],
    [90000, 4],
    [125000, 6],
    [200000, 8],
    [250000, 20],
    [({ features }: { features?: FeatureAccess }) => features?.thirtyDayEarlyAccess ?? false, 30],
  ],
};

export const KEY_VALUE_KEYS = {
  REDEEM_CODE_GIFT_NOTICES: 'redeemCodeGiftNotices',
} as const;
