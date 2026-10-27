import { env } from '~/env/client';
import { BanReasonCode, ModelSort, NsfwLevel } from '~/server/common/enums';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import {
  BountyType,
  CommercialUse,
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
import type { BaseModel } from '~/shared/constants/basemodel.constants';

export const lipsum = `
Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.
`;

/**
 * Comment surfaces laid out full-width, so a conversation can render open and deeply nested
 * without the indentation running out of room. Everything else gets the shallower defaults.
 *
 * Deep threads reach the end of an article's ceiling for 99.5% of article threads (prod,
 * Aug 2026); bounty and challenge threads have not been measured, and share the ceiling
 * because they share the layout.
 */
/** civitai.com and the deployment's own host, each with its `image.` subdomain. */
function chatCivHosts() {
  let baseHost = 'civitai.com';
  const base = env.NEXT_PUBLIC_BASE_URL;
  if (base) {
    try {
      baseHost = new URL(/^https?:\/\//i.test(base) ? base : `https://${base}`).hostname;
    } catch {
      // unparseable: civitai.com only
    }
  }
  return [...new Set([baseHost, 'civitai.com'])].flatMap((host) => [host, `image.${host}`]);
}

const wideCommentSurfaces = new Set(['article', 'bounty', 'challenge']);

function getCommentMaxDepth(entityType: string) {
  return wideCommentSurfaces.has(entityType) ? 10 : 5;
}

/**
 * Reply levels a surface opens up front, where it differs from "as deep as it holds" on a wide
 * surface or "none" elsewhere. A challenge puts its entry gallery *underneath* the discussion,
 * and opening every thread put that gallery 7.5 screens down (measured, 131-comment challenge);
 * one level costs 4.2. `image` and `bountyEntry` sit in narrow detail columns, so they open part
 * of their depth rather than all of it.
 */
const autoExpandDepthOverrides: Record<string, number> = { challenge: 1, image: 3, bountyEntry: 3 };

function getCommentAutoExpandDepth(entityType: string) {
  const override = autoExpandDepthOverrides[entityType];
  if (override === undefined && !wideCommentSurfaces.has(entityType)) return 0;
  const ceiling = getCommentMaxDepth(entityType) - 1;
  return Math.min(override ?? ceiling, ceiling);
}

/**
 * Ceiling on a batch `?ids=` lookup for the image REST routes
 * (`/api/v1/images` and `/api/v1/blocks/images`).
 *
 * NOT a new number. It is the ceiling the bridge message those routes replace
 * already enforced: `blocks.getImagesByIds` (`GET_IMAGES_BY_IDS`) validates
 * `imageIds: z.number().int().positive().array().min(1).max(100)` in
 * `src/server/routers/blocks.router.ts`, and its service states the same bound
 * as `BLOCK_GATED_IMAGES_MAX_IDS = 100` in
 * `src/server/services/blocks/block-gated-images.service.ts` ("Bound the read —
 * a grid page never needs more, and each id is a row lookup"). An app porting
 * off the bridge therefore meets exactly the limit it already coded against.
 *
 * It also equals `constants.galleryFilterDefaults.limit` below, so a caller that
 * sends a full batch and no `limit` gets every row in one page. Send fewer ids
 * than `limit`, or the page truncates — `ids` is a filter, not a paging bypass.
 *
 * Lives here, not next to `runImageSearch`, so a test can read it without
 * pulling in the image service (the same reason
 * `search-index/filterable-attributes.ts` is a leaf). The agreement with the
 * bridge is asserted, not merely described:
 * `src/server/services/__tests__/image-ids-batch-cap-parity.test.ts`.
 */
export const IMAGE_IDS_BATCH_MAX = 100;

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
    limit: 100,
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
    'Vision Encoder',
    'Pruned Model',
    'Negative',
    'Training Data',
    'VAE',
    'Config',
    'Archive',
    'UNet',
    'Diffusion Model',
    'CLIPVision',
    'ControlNet',
    'Workflow',
    'Upscaler',
    'Enhancement LoRA',
    'Other',
  ],
  trainingMediaTypes: ['image', 'video', 'audio'],
  trainingModelTypes: ['Character', 'Style', 'Concept', 'Effect'],
  baseModelTypes: ['Standard', 'Inpainting', 'Refiner', 'Pix2Pix'],
  modelFileFormats: ['SafeTensor', 'PickleTensor', 'GGUF', 'Diffusers', 'Core ML', 'ONNX', 'Other'],
  modelFileSizes: ['full', 'pruned'],
  modelFileFp: [
    'fp32',
    'fp16',
    'bf16',
    'mxfp8',
    'fp8_mixed',
    'fp8_scaled',
    'fp8',
    'int8',
    'nf4',
    'nvfp4',
    'int4',
  ],
  modelFileQuantTypes: [
    'None',
    'Q8_0',
    'Q6_K',
    'Q5_K_M',
    'Q5_K_S',
    'Q5_1',
    'Q5_0',
    'Q4_K_XL',
    'Q4_K_M',
    'Q4_K_S',
    'Q4_1',
    'Q4_0',
    'Q3_K_XL',
    'Q3_K_L',
    'Q3_K_M',
    'Q3_K_S',
    'Q2_K_XL',
    'Q2_K',
    'Q2_K_S',
    'IQ4_XS',
    'IQ4_KS',
    'IQ4_NL',
    'IQ3_M',
    'IQ3_S',
    'IQ3_XS',
    'IQ3_XXS',
    'IQ2_XS',
    'IQ2_XXS',
    'IQ2_S',
    'IQ2_M',
    'IQ1_S',
    'IQ1_M',
    'TQ2_0',
    'TQ1_0',
  ],
  modelFileComponentTypes: [
    'Checkpoint',
    'VAE',
    'TextEncoder',
    'UNet',
    'DiffusionModel',
    'CLIPVision',
    'CLIP',
    'VisionLanguage',
    'ControlNet',
    'Upscaler',
    'Workflow',
    'Config',
    'Other',
  ],
  tagFilterDefaults: {
    trendingTagsLimit: 20,
  },
  modelFileOrder: {
    Model: 0,
    'Pruned Model': 1,
    'Training Data': 2,
    Config: 3,
    'Text Encoder': 4,
    'Vision Encoder': 16,
    VAE: 5,
    Negative: 6,
    Archive: 7,
    UNet: 8,
    'Diffusion Model': 9,
    CLIPVision: 10,
    ControlNet: 11,
    Workflow: 12,
    Upscaler: 13,
    'Enhancement LoRA': 14,
    Other: 15,
  },
  modelAssociations: {
    limit: 10,
    // Server ceiling, deliberately above the UI limit: 9 models already hold 11-12
    // associations, and rejecting their saves would strand them.
    maxPerSave: 20,
  },
  cardSizes: {
    model: 320,
    image: 320,
    articles: 320,
    bounty: 320,
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
    maxFileSize: 1024 * 1024 * 50, // 50MB
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
    referralCodeMaxCount: 1,
    cookieDurationDays: 30,
    settlementWindowDays: 7,
    tokenExpiryDays: 90,
    minReferrerAccountAgeDays: 7,
    maxPaidMonthsPerReferee: 3,
    tokensPerTier: { bronze: 1, silver: 2, gold: 3 } as Record<string, number>,
    // Referral Points drive both milestone progress and Recruiter Score.
    // 1 point per Blue Buzz earned, plus a tier-weighted lump per paid
    // referral month (≈10% of each tier's monthly Buzz value).
    pointsPerTierMonth: { bronze: 1_000, silver: 2_500, gold: 5_000 } as Record<string, number>,
    // Cap how far into the future a referral subscription can be queued. Prevents
    // a hot referrer from queuing decades of perks (Stripe's date max is 2038).
    maxQueuedDays: 365,
    refereeBonusBuzzPct: 0.25,
    buzzKickbackPct: 0.1,
    shopItems: [
      { cost: 1, tier: 'bronze', durationDays: 14 },
      { cost: 2, tier: 'bronze', durationDays: 30 },
      { cost: 3, tier: 'silver', durationDays: 14 },
      { cost: 4, tier: 'silver', durationDays: 30 },
      { cost: 5, tier: 'gold', durationDays: 14 },
      { cost: 6, tier: 'gold', durationDays: 30 },
    ] as ReadonlyArray<{ cost: number; tier: string; durationDays: number }>,
    milestones: [
      { threshold: 1_000, bonus: 500 },
      { threshold: 10_000, bonus: 2_500 },
      { threshold: 50_000, bonus: 15_000 },
      { threshold: 200_000, bonus: 50_000 },
      { threshold: 1_000_000, bonus: 250_000 },
    ] as ReadonlyArray<{ threshold: number; bonus: number }>,
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
    maxChargeAmount: 500000, // $5,000.00
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
    /**
     * Deepest reply level a surface renders inline. Past it, "show replies" re-roots the
     * section on that comment instead. Resolve it against the *surface* entity type, never
     * the nested `comment` type every reply thread carries.
     */
    getMaxDepth({ entityType }: { entityType: string }) {
      return getCommentMaxDepth(entityType);
    },
    /** How many reply levels a surface opens up front. 0 leaves every thread behind its button. */
    getAutoExpandDepth({ entityType }: { entityType: string }) {
      return getCommentAutoExpandDepth(entityType);
    },
    /**
     * Most replies a single page may open up front, shallowest first. Threads past it stay behind
     * "show replies" — a 1k-comment article opening every thread is what made these pages
     * unresponsive before pagination, and this is what keeps a page a page's worth of work.
     */
    autoExpandBudget: 40,
    replyPageSize: 5,
    maxLength: 50000, // 50k characters
  },
  altTruncateLength: 125,
  system: {
    user: { id: -1, username: 'civitai' },
    // Public CivitaiOfficial content account (distinct from the system actor above).
    officialUserId: 12042163,
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
    maxCreatorHiddenUsers: 1000,
    maxCreatorHiddenUserNoteLength: 500,
  },
  chat: {
    airRegex: /^civitai:(?<mId>\d+)@(?<mvId>\d+)$/i,
    // Hosts a chat link may point at, matched exactly against the parsed hostname
    // (see `src/components/Chat/util.tsx`). Links to these hosts are rendered in-app.
    civHosts: chatCivHosts(),
    // Off-site hosts chat will link (and preview server-side). Exact hostnames only.
    externalHosts: [
      'github.com',
      'twitter.com',
      'x.com',
      'civitai.red',
      'education.civitai.com',
    ].flatMap((host) => [host, `www.${host}`]),
  },
  entityCollaborators: {
    maxCollaborators: 15,
  },

  /**
   * App Listing COLLABORATORS (editor seats on an App Block).
   *
   * Mirrors `entityCollaborators` deliberately, so the two collaborator surfaces
   * stay comparable. The cap counts PENDING + ACCEPTED seats (a rejected seat is
   * inert and does not occupy one) — see `app-collaborator.service.ts`.
   */
  appCollaborators: {
    /** Max pending+accepted editor seats per app. */
    maxCollaborators: 15,
    /**
     * Minimum gap between re-invite NOTIFICATIONS to the same (app, user).
     *
     * 🔴 The `EntityCollaborator` sibling's equivalent throttle is INVERTED —
     * `entity-collaborator.service.ts` compares `lastMessageSentAt >= (now - 1d)`
     * where the semantically identical `sendMessagesToCollaborators` correctly uses
     * `lte`. As written it re-notifies precisely when it should stay silent. This
     * one is written the correct way round (`lastNotifiedAt <= now - window`), and
     * `app-collaborator.service.test.ts` pins BOTH sides of the boundary so the bug
     * cannot be re-imported by copy-paste.
     */
    inviteNotifyThrottleHours: 24,
    /** An unaccepted ownership transfer stops being acceptable after this. */
    transferExpiryDays: 7,
  },

  autoLabel: {
    labelTypes: ['tag', 'caption'] as const,
  },

  // External URL for the article rating self-check guideline (hosted on education.civitai.com).
  // TODO(article-nsfw-dispute): finalize the slug; this is a placeholder.
  articleRatingGuidelineUrl: 'https://education.civitai.com/articles/article-rating-guidelines',
} as const;

export const maxOrchestratorImageFileSize = 24 * 1024 ** 2; // 24MB
export const maxImageFileSize = 50 * 1024 ** 2; // 50MB
export const maxVideoFileSize = 64 * 1024 ** 2; // 64MB
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

export const modelFileQuantTypes = constants.modelFileQuantTypes;
export const modelFileComponentTypes = constants.modelFileComponentTypes;

/** ModelFileType values that represent component files (not main model weights) */
export const componentFileTypes = [
  'VAE',
  'Text Encoder',
  'Vision Encoder',
  'UNet',
  'Diffusion Model',
  'CLIPVision',
  'ControlNet',
  'Upscaler',
  'Enhancement LoRA',
] as const;
export type ComponentFileType = (typeof componentFileTypes)[number];

export const POST_IMAGE_LIMIT = 20;
export const POST_TAG_LIMIT = 5;
// The scheduling window lives in @civitai/shared so the planner element and Creator Studio read the
// same numbers; re-exported here for the many existing importers.
export {
  POST_MAXIMUM_SCHEDULE_MONTHS,
  POST_MINIMUM_SCHEDULE_MINUTES,
} from '@civitai/shared/post-scheduling';
// Caps on resources a user can manually credit on a single uploaded/external image
// (`ImageResourceNew.detected = false`); auto-detected resources are not counted. This is an
// attribution action with no GPU cost, so it is intentionally decoupled from the per-tier
// generation resource limits (genStatus.limits), which are throttled during GPU crunches.
export const MAX_MANUAL_RESOURCES_PER_IMAGE = 10;
export const MAX_MANUAL_CHECKPOINTS_PER_IMAGE = 3;
export const CAROUSEL_LIMIT = 20;
export const DEFAULT_EDGE_IMAGE_WIDTH = 450;
export const MAX_ANIMATION_DURATION_SECONDS = 30;
export const MAX_POST_IMAGES_WIDTH = 800;

export const CYBERTIP_CONTACT_EMAIL = 'compliance@civitai.com';

export type BaseModelType = (typeof constants.baseModelTypes)[number];

type LicenseDetails = {
  url: string;
  name: string;
  notice?: string;
  poweredBy?: string;
  // Set only when the licence obliges us to name the model in the product's own
  // UI, and holds the exact string it demands. Distinct from `poweredBy`, which
  // several licences use for a liability disclaimer rather than an attribution.
  attribution?: string;
  restrictedNsfwLevels?: NsfwLevel[];
  // When true, mature content is restricted (auto-derives `restrictedNsfwLevels`
  // to MATURE_NSFW_LEVELS). Use this instead of hand-listing levels.
  disableMature?: boolean;
  // When true, the license forbids commercial use. Drives both the commercial-use
  // permission override (-> [None]) and the per-version monetization block. The set
  // of affected base models is derived from this flag (see nonCommercialBaseModels).
  nonCommercial?: boolean;
  // When true, the license requires derivatives to carry the same license, so the
  // creator's `allowDifferentLicense` cannot apply (see getEffectiveDifferentLicense).
  requiresSameLicense?: boolean;
};

// Levels considered "mature" — restricted whenever a license sets disableMature.
const MATURE_NSFW_LEVELS: NsfwLevel[] = [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX];
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
    url: 'https://huggingface.co/Lightricks/LTX-Video/blob/8984fa25007f376c1a299016d0957a37a2f797bb/LTX-Video-Open-Weights-License-0.X.txt',
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
    // Permalinked to the Jan 5 2026 revision these weights shipped under. Not
    // github.com/Lightricks/LTX-2, which serves a later rewrite scoped to 2.5+.
    url: 'https://huggingface.co/Lightricks/LTX-2.3/blob/6f3520585aa27248020550da2f453aa0c572398c/LICENSE',
    name: 'LTX-2 Community License Agreement',
  },
  ltxv25: {
    // Permalinked to the Aug 11 2026 revision. `blob/main` tracks the latest, so the next
    // rewrite Lightricks pushes there would silently relabel these weights — the same trap
    // baseLicenses.ltxv2 avoids.
    url: 'https://github.com/Lightricks/LTX-2/blob/2362161611a61154d342e02724fb8fe58efd455d/LICENSE.md',
    name: 'LTX-2.x Community License Agreement',
    // Section 3.6 permits only additive terms on derivatives, dropping the "or different"
    // that the Jan 2026 text (baseLicenses.ltxv2) still allows.
    requiresSameLicense: true,
    notice:
      'LTX Video 2.5 and its derivatives, including LoRAs and fine-tunes, are licensed by Lightricks Ltd. under the LTX-2.x Community License Agreement and must be redistributed under that same agreement, with a copy included. Use is subject to the use restrictions in its Attachment A. Entities with annual revenues of at least $10,000,000 must obtain a paid commercial license from Lightricks before any commercial use.',
  },
  anima: {
    url: 'https://huggingface.co/circlestone-labs/Anima/blob/main/LICENSE.md',
    name: 'Anima',
    notice:
      'The Anima Model is licensed by CircleStone Labs LLC. Copyright CircleStone Labs LLC. IN NO EVENT SHALL CIRCLESTONE LABS LLC BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH USE OF THIS MODEL.',
    poweredBy: 'Built on NVIDIA Cosmos',
  },
  kling: {
    url: 'https://klingai.com/terms-of-service',
    name: 'Kling',
  },
  vidu: {
    url: 'https://www.vidu.com/terms',
    name: 'Vidu Q1',
  },
  'ideogram nc': {
    // Public blob page — the nf4 `raw` URL is gated and 401s.
    url: 'https://huggingface.co/ideogram-ai/ideogram-4-nf4/blob/main/LICENSE.md',
    name: 'Ideogram Non-Commercial Model Agreement',
    // Section 3(iii) attribution wording; the URL lives on the linked license name
    // shown above the notice, so we omit the bare URL here.
    notice:
      'Ideogram 4 is provided under and subject to the Ideogram Non-Commercial Model Agreement. All rights reserved. Copyright © Ideogram, Inc.',
    // License AUP bars pornographic/obscene content. `disableMature` auto-derives
    // the restricted NSFW levels (see getRestrictedNsfwLevelsForBaseModel).
    disableMature: true,
    // Ideogram Non-Commercial Model Agreement forbids commercial use.
    nonCommercial: true,
  },
  'bfl tos': {
    url: 'https://bfl.ai/legal/terms-of-service',
    name: 'Black Forest Labs Terms of Service',
  },
  'ideogram tos': {
    url: 'https://ideogram.ai/legal/tos',
    name: 'Ideogram Terms of Service',
    // The ToS bars sexually explicit output.
    disableMature: true,
  },
  'qwen research': {
    url: 'https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE',
    name: 'Qwen Research License Agreement',
    notice:
      'Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c) 2026 Hangzhou Tongyi Laboratory Technology Co., Ltd. All Rights Reserved.',
    nonCommercial: true,
  },
  'minimax h3': {
    // Permalinked to the 2 Aug 2026 revision. The model page tracks the latest
    // commit, and section III.1 obliges us to hand over a stable copy.
    url: 'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE',
    name: 'MiniMax H3 Community License Agreement',
    notice:
      'Generation, training and LoRA distribution on Civitai are covered by Civitai’s own license agreement with MiniMax. If you download these weights and run them yourself, your use is instead governed by the MiniMax H3 Community License Agreement, whose grant excludes the European Union, the United Kingdom, the Republic of Korea and the United States of America.',
    // Section IV.2 wants "MiniMax H3" in the product UI. The generator's model
    // header and ecosystem label both render it, so no `attribution` line is
    // needed under the generate button. "Powered by MiniMax H3" is the separate,
    // merely encouraged notice in III.3(a).
    poweredBy: 'MiniMax H3',
  },
  'minimax music 3': {
    // Permalinked for the same reason as H3 above: section 5.2 lets MiniMax amend
    // the published text.
    url: 'https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/fbdf52fbaaca799592917417eb05f1899f1255ec/LICENSE',
    name: 'MiniMax-Music3 Community License',
    // Section 3.1 demands this exact string on the UI of a commercial product.
    // Unlike H3's licence this one has no Applicable Territory clause and no
    // encouraged "Powered by" form, so there is no notice and no poweredBy.
    attribution: 'MiniMax-Music3',
  },
  'krea 2 community': {
    // The licence link on the Hugging Face model cards, pinned to a commit.
    url: 'https://cdn.jsdelivr.net/gh/krea-ai/krea-2@db3984fbc6e13b34c0064990fc2d95ac64d00058/assets/hf_samples/LICENSE.pdf',
    name: 'Krea 2 Community License Agreement',
  },
  'flux kommunity': {
    // Permalinked: `blob/main` would silently relabel these weights on a rewrite.
    url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/55d9cc2b0d33255ccd4fe1c9724bc3754de0ae96/LICENSE.md',
    name: 'FLUX Kommunity License',
    // Section 3(b) Attribution Notice, split like the other BFL licences.
    notice:
      'This FLUX Model is licensed by Black Forest Labs Inc. under the FLUX Kommunity License. Copyright Black Forest Labs Inc.',
    poweredBy:
      'IN NO EVENT SHALL BLACK FOREST LABS INC. BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH USE OF THIS MODEL.',
    // Section 2(b): the model and its derivatives are non-commercial; only a Qualifying
    // User's outputs may be used commercially.
    nonCommercial: true,
    // Section 2(a) applies every restriction to derivatives, and 3(a) makes them carry it.
    requiresSameLicense: true,
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
  'Flux.3': baseLicenses['bfl tos'],
  'Flux.3 Klein': baseLicenses['flux kommunity'],
  'Flux.3 Klein-base': baseLicenses['flux kommunity'],
  'MOSS Image': baseLicenses['apache 2.0'],
  'Flux 3 Video': baseLicenses['bfl tos'],
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
  'LTXV 2.3': baseLicenses['ltxv2'],
  'LTXV 2.5': baseLicenses['ltxv25'],
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
  'Qwen 2.1': baseLicenses['qwen research'],
  Seedream: baseLicenses['seedream'],
  'Sora 2': baseLicenses['openai'],
  ZImageTurbo: baseLicenses['apache 2.0'],
  ZImageBase: baseLicenses['apache 2.0'],
  Anima: baseLicenses['anima'],
  Kling: baseLicenses['kling'],
  'Vidu Q1': baseLicenses['vidu'],
  Seedance: baseLicenses['seedream'],
  'Ideogram 4.0': baseLicenses['ideogram nc'],
  'Ideogram 4.5': baseLicenses['ideogram tos'],
  'MiniMax H3': baseLicenses['minimax h3'],
  'MiniMax Music 3': baseLicenses['minimax music 3'],
  'Krea 2': baseLicenses['krea 2 community'],
  'Krea 2 Turbo': baseLicenses['krea 2 community'],
};

type CivitaiLicenseAgreement = {
  partner: string;
  url?: string;
  // Shown in place of the public licence's notice, which is written for the case
  // the agreement now headlines.
  notice?: string;
};

// Base models Civitai uses under its own agreement with the rights holder. Display only:
// commercial-use, mature and same-license enforcement still come from baseModelLicenses.
export const civitaiLicenseAgreements: Partial<Record<BaseModel, CivitaiLicenseAgreement>> = {
  'MiniMax H3': {
    partner: 'MiniMax',
    notice:
      'The MiniMax H3 Community License Agreement’s grant excludes the European Union, the United Kingdom, the Republic of Korea and the United States of America.',
  },
};

export type LicenseLine = { label?: string; name: string; url?: string; suffix?: string };
export type DisplayedBaseModelLicense = {
  lines: LicenseLine[];
  notice?: string;
  poweredBy?: string;
};

export function getDisplayedBaseModelLicense(
  baseModel: string
): DisplayedBaseModelLicense | undefined {
  const license = baseModelLicenses[baseModel as BaseModel];
  const agreement = civitaiLicenseAgreements[baseModel as BaseModel];
  if (!agreement) {
    if (!license) return undefined;
    return {
      lines: [{ name: license.name, url: license.url }],
      notice: license.notice,
      poweredBy: license.poweredBy,
    };
  }

  // The agreement covers use on Civitai only. Downloaded weights stay under the public
  // licence, so the two scopes get equal billing rather than one demoting the other.
  const lines: LicenseLine[] = [
    {
      label: 'On Civitai (generation, training, sharing LoRAs):',
      name: `covered by Civitai’s agreement with ${agreement.partner}`,
      url: agreement.url,
    },
  ];
  if (license)
    lines.push({
      label: 'Downloaded weights:',
      name: license.name,
      url: license.url,
      suffix: 'applies',
    });

  return { lines, notice: agreement.notice, poweredBy: license?.poweredBy };
}

export type ModelFileType = (typeof constants.modelFileTypes)[number];
export type Sampler = (typeof constants.samplers)[number];

// Resolve the restricted NSFW levels for a license, deriving from `disableMature`
// when an explicit `restrictedNsfwLevels` array isn't provided.
function getLicenseRestrictedNsfwLevels(license: LicenseDetails | undefined): NsfwLevel[] {
  if (!license) return [];
  if (license.restrictedNsfwLevels && license.restrictedNsfwLevels.length > 0)
    return license.restrictedNsfwLevels;
  if (license.disableMature) return MATURE_NSFW_LEVELS;
  return [];
}

// Base models that use licenses with NSFW restrictions
export const nsfwRestrictedBaseModels: BaseModel[] = Object.entries(baseModelLicenses)
  .filter(([, license]) => getLicenseRestrictedNsfwLevels(license).length > 0)
  .map(([baseModel]) => baseModel as BaseModel);

export function getRestrictedNsfwLevelsForBaseModel(baseModel: string): NsfwLevel[] {
  return getLicenseRestrictedNsfwLevels(baseModelLicenses[baseModel as BaseModel]);
}

// Base models whose license forbids commercial use — derived from the `nonCommercial`
// license flag (single source of truth), mirroring nsfwRestrictedBaseModels.
export const nonCommercialBaseModels: BaseModel[] = Object.entries(baseModelLicenses)
  .filter(([, license]) => !!license?.nonCommercial)
  .map(([baseModel]) => baseModel as BaseModel);

export function isNonCommercialBaseModel(baseModel?: string | null): boolean {
  return !!baseModel && !!baseModelLicenses[baseModel as BaseModel]?.nonCommercial;
}

// Effective commercial-use permissions for a resource given its base model.
// Non-commercial base models override the stored creator permission to [None] — we
// derive this at read time rather than storing it, so it always reflects the current
// license config and needs no migration. Use wherever commercial-use is surfaced.
export function getEffectiveCommercialUse(
  allowCommercialUse: CommercialUse[],
  baseModel?: string | null
): CommercialUse[] {
  return isNonCommercialBaseModel(baseModel) ? [CommercialUse.None] : allowCommercialUse;
}

// Base models whose license requires derivatives to carry the same license.
export const sameLicenseBaseModels: BaseModel[] = Object.entries(baseModelLicenses)
  .filter(([, license]) => !!license?.requiresSameLicense)
  .map(([baseModel]) => baseModel as BaseModel);

export function requiresSameLicenseBaseModel(baseModel?: string | null): boolean {
  return !!baseModel && !!baseModelLicenses[baseModel as BaseModel]?.requiresSameLicense;
}

// Effective "different permissions on merges" for a resource given its base model.
// Mirrors getEffectiveCommercialUse: derived at read time so it tracks the license
// config, and because the permission is stored per-model while the base model that
// constrains it is per-version.
export function getEffectiveDifferentLicense(
  allowDifferentLicense: boolean,
  baseModel?: string | null
): boolean {
  return requiresSameLicenseBaseModel(baseModel) ? false : allowDifferentLicense;
}

// "Different permissions on merges" means nothing while merges are not allowed. The upsert form
// used to hide that box without clearing it, so ~111k models store merges off with it still on:
// every reader goes through this rather than the raw column, and those rows are left as stored.
export function allowsDifferentLicenseOnMerges(permissions: {
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
}): boolean {
  return permissions.allowDerivatives && permissions.allowDifferentLicense;
}

// The write-side half of the rule above. Only when the caller is writing permissions: a save that
// omits both fields leaves the stored pair alone. `storedAllowDerivatives` covers a save that sends
// only allowDifferentLicense to a model whose merges are already off.
export function normalizeMergePermissions(
  data: { allowDerivatives?: boolean; allowDifferentLicense?: boolean },
  storedAllowDerivatives?: boolean
) {
  if (data.allowDerivatives === undefined && data.allowDifferentLicense === undefined) return;
  if ((data.allowDerivatives ?? storedAllowDerivatives) === false)
    data.allowDifferentLicense = false;
}

// Whether a model's own terms add anything to the base license, which decides if Attachment B
// is offered. Returns true for every input: every element of a CommercialUse[] is in CommercialUse
// by construction, so the `.some` is `length > 0` and the `!length` arm covers the rest, and
// `throwBadRequestError('No additional permissions')` cannot fire. The literal list this replaced
// was equally unconditional, so this diff did not create the dead gate.
// Narrowing it changes which models are served Attachment B -- a licensing decision.
export function hasAdditionalLicensePermissions(permissions: {
  allowCommercialUse: CommercialUse[];
  allowNoCredit: boolean;
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
}): boolean {
  const { allowCommercialUse, allowNoCredit, allowDerivatives, allowDifferentLicense } =
    permissions;
  return (
    !allowCommercialUse.length ||
    allowCommercialUse.some((permission) =>
      (Object.values(CommercialUse) as string[]).includes(permission)
    ) ||
    !allowNoCredit ||
    !allowDerivatives ||
    allowDifferentLicense
  );
}

export function isNsfwLevelRestrictedForBaseModel(
  baseModel: string,
  nsfwLevel: NsfwLevel
): boolean {
  const restrictedLevels = getRestrictedNsfwLevelsForBaseModel(baseModel);
  return restrictedLevels.includes(nsfwLevel);
}

export const maxRandomSeed = 2147483647;
// Postgres INT4 (integer) column bounds — the ceiling any value written to an
// `integer` column (e.g. metric counts) must fit under.
export const PG_INT4_MAX = 2_147_483_647;
export const PG_INT4_MIN = -2_147_483_648;
export const maxUpscaleSize = 3840;
export const minDownscaleSize = 320;
export const minUploadSize = 300;

export const MODELS_SEARCH_INDEX = 'models_v9';
export const IMAGES_SEARCH_INDEX = 'images_v6';
export const ARTICLES_SEARCH_INDEX = 'articles_v5';
export const USERS_SEARCH_INDEX = 'users_v3';
export const COLLECTIONS_SEARCH_INDEX = 'collections_v3';
export const BOUNTIES_SEARCH_INDEX = 'bounties_v3';
export const TOOLS_SEARCH_INDEX = 'tools_v2';
export const COMICS_SEARCH_INDEX = 'comics_v1';
export const MODELS_3D_SEARCH_INDEX = 'models_3d_v1';

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
  'Pay for on-site image and video generation',
  'Purchase early access to models',
  'Support your favorite creators via tips',
  'Create bounties for models, images and more!',
  'Purchase profile cosmetics from our Cosmetic Shop!',
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

export const BUG_CLOSED_STATUSES = ['complete', 'closed', 'done', 'resolved'] as const;

export const isBugClosed = (status: string) =>
  (BUG_CLOSED_STATUSES as readonly string[]).includes(status.trim().toLowerCase());

export const BUG_STATUS_SUGGESTIONS = ['Open', 'In Progress', 'In Review', 'Complete'] as const;

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

/** Minor-safety bans always remove media: `toggleBan` ignores `removeMedia: false` for these. */
export const banReasonsAlwaysRemovingMedia: readonly BanReasonCode[] = [
  BanReasonCode.SexualMinor,
  BanReasonCode.SexualMinorGenerator,
  BanReasonCode.SexualMinorTraining,
];

export const banReasonDetails: Record<
  BanReasonCode,
  {
    code: BanReasonCode;
    publicBanReasonLabel?: string;
    privateBanReasonLabel: string;
    /** Set by its own flow, never picked by hand. */
    systemOnly?: true;
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
  [BanReasonCode.SpamBot]: {
    code: BanReasonCode.SpamBot,
    publicBanReasonLabel: 'Community Abuse',
    privateBanReasonLabel: 'Spambot or automated account',
  },
  [BanReasonCode.BotAccount]: {
    code: BanReasonCode.BotAccount,
    publicBanReasonLabel: 'Community Abuse',
    privateBanReasonLabel: 'Automated / bot account',
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
  [BanReasonCode.Chargeback]: {
    code: BanReasonCode.Chargeback,
    publicBanReasonLabel: 'Reversed payment',
    privateBanReasonLabel: 'Lost payment dispute (chargeback)',
    systemOnly: true,
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

// GenerationEcosystemConfig / Context + DEFAULT_GENERATION_ECOSYSTEM_CONFIG now
// derive from `generationEcosystemConfigSchema` in `~/server/schema/generation.schema`.

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
    // The maximum amount of days that can be set based off of score. The entry rung is set to the
    // same figure as MONETIZATION_MIN_CREATOR_SCORE, deliberately — but the two are separate
    // constants that nothing keeps in step, and clearing this rung is not the same permission as
    // clearing the pricing floor. Do not read the shared number as a shared rule.
    [10000, 3],
    [65000, 5],
    [90000, 7],
    [125000, 9],
    [200000, 12],
    [250000, 15],
    [({ features }: { features?: FeatureAccess }) => features?.thirtyDayEarlyAccess ?? false, 30],
  ],
  scoreQuantityUnlock: [
    // How many items can be marked EA at the same time based off of score. Entry rung matches
    // scoreTimeFrameUnlock's — see the note there.
    [10000, 1],
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
  MODEL_FILE_OPTIONS: 'modelFileOptions',
  CONTEST_SCORING: 'contestScoring',
  CREATOR_SHOP_FEES: 'creatorShopFees',
  USER_MENU_DEFAULT_PINS: 'userMenuDefaultPins',
} as const;

// Snapshot rows are one KeyValue per run: `contestSnapshot:<collectionId>:<takenAt ISO>`.
export const CONTEST_SNAPSHOT_KEY_PREFIX = 'contestSnapshot';

/**
 * Bumped whenever a change to contest scoring could move a ranking. Recorded in every
 * snapshot so a disputed result can be traced to the code that produced it, and read
 * by the results UI to mark a snapshot taken by an older scorer.
 *
 * It lives HERE rather than beside the scorer because the client reads it: a value
 * import from `contest-score.service` would pull `~/server/db/client` and `~/env/server`
 * into the browser bundle, and neither module can be tree-shaken away (both run side
 * effects at import). That failure only surfaces at `next build`.
 */
export const CONTEST_SCORE_CODE_VERSION = 5;

/** Scoring counted every version of a model before this. */
export const CONTEST_VERSION_SCOPING_CODE_VERSION = 3;
