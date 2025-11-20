import { env } from '~/env/client';
import { ArticleSort, CollectionSort, ImageSort, PostSort, QuestionSort } from '~/server/common/enums';
import { MetricTimeframe, Currency, BountyType } from '~/shared/utils/prisma/enums';
import { increaseDate } from '~/utils/date-helpers';
import { BanReasonCode } from '~/server/common/enums';
import type { NsfwLevel } from '~/server/common/enums';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

export const lipsum = `
Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.
`;

export const questionFilterDefaults = {
  sort: QuestionSort.MostLiked,
  period: MetricTimeframe.AllTime,
  limit: 50,
};

export const galleryFilterDefaults = {
  sort: ImageSort.MostReactions,
  period: MetricTimeframe.AllTime,
  limit: 50,
};

export const postFilterDefaults = {
  sort: PostSort.MostReactions,
  period: MetricTimeframe.AllTime,
  limit: 50,
};

export const articleFilterDefaults = {
  sort: ArticleSort.Newest,
  period: MetricTimeframe.AllTime,
  limit: 50,
};

export const collectionFilterDefaults = {
  sort: CollectionSort.Newest,
  limit: 50,
};

export const tagFilterDefaults = {
  trendingTagsLimit: 20,
};

export const reportingFilterDefaults = {
  limit: 50,
};

export const cardSizes = {
  model: 320,
  image: 320,
  articles: 320,
  bounty: 320,
  club: 320,
};

export const cacheTime = {
  postCategories: 60 * 60 * 1,
};

export const timeCutOffs = {
  updatedModel: 2 * 60 * 60 * 1000,
};

export const tagVoting = {
  voteDuration: 1000 * 60 * 60 * 24,
  upvoteThreshold: 3,
};

export const mediaUpload = {
  maxOrchestratorImageFileSize: 60 * 1024 ** 2, // 16MB
  maxImageFileSize: 50 * 1024 ** 2, // 50MB
  maxVideoFileSize: 750 * 1024 ** 2, // 750MB
  maxVideoDimension: 3840,
  maxVideoDurationSeconds: 245,
};

export const bounties = {
  engagementTypes: ['active', 'favorite', 'tracking', 'supporter', 'awarded'],
  minCreateAmount: 500,
  maxCreateAmount: 100000000,
  supportedBountyToModels: [BountyType.ModelCreation, BountyType.LoraCreation],
};

export const defaultCurrency = Currency.BUZZ;

export const referrals = {
  referralCodeMinLength: 6,
  referralCodeMaxCount: 3,
};

export const leaderboard = {
  legendScoring: {
    diamond: 10,
    gold: 8,
    silver: 6,
    bronze: 4,
  },
};

export const buzz = {
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
};

export const profile = {
  coverImageAspectRatio: 1 / 4,
  mobileCoverImageAspectRatio: 1 / 4,
  coverImageHeight: 400,
  coverImageWidth: 1600,
  showcaseItemsLimit: 32,
  bioMaxLength: 400,
  messageMaxLength: 1200,
  locationMaxLength: 30,
};

export const clubs = {
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
};

export const article = {
  coverImageHeight: 400,
  coverImageWidth: 850,
};

export const profanity = {
  thresholds: {
    shortContentWordLimit: 100,
    shortContentMatchThreshold: 5,
    longContentDensityThreshold: 0.02, // 2%
    diversityThreshold: 10,
  },
};

export const comments = {
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
};

export const altTruncateLength = 125;

export const system = {
  user: { id: -1, username: 'civitai' },
};

export const creatorsProgram = {
  rewards: {
    earlyAccessUniqueDownload: 10,
    generatedImageWithResource: 10 / 1000, // 10 buzz for every 1000 images.
  },
};

export const purchasableRewards = {
  coverImageAspectRatio: 1 / 2,
  coverImageWidth: 180,
};

export const vault = {
  keys: {
    details: ':modelVersionId/:userId/details.pdf',
    images: ':modelVersionId/:userId/images.zip',
    cover: ':modelVersionId/:userId/cover.jpg',
  },
};

export const supporterBadge = '514e9489-a734-4ea9-b223-ff9833abb3fd';

export const memberships = {
  tierOrder: ['free', 'founder', 'bronze', 'silver', 'gold'],
  badges: {
    free: '514e9489-a734-4ea9-b223-ff9833abb3fd',
    founder: '514e9489-a734-4ea9-b223-ff9833abb3fd',
    bronze: '514e9489-a734-4ea9-b223-ff9833abb3fd',
    silver: '9dec8ea0-1cde-4c6c-ac5f-0f97c5b448e4',
    gold: 'b98074e1-883f-46d9-a290-812bb19ec706',
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
};

export const cosmeticShop = {
  sectionImageAspectRatio: 250 / 1288,
  sectionImageHeight: 250,
  sectionImageWidth: 1288,
};

export const cosmetics = {
  frame: {
    padding: 6,
  },
};

export const chat = {
  airRegex: /^civitai:(?<mId>\d+)@(?<mvId>\d+)$/i,
  // TODO disable just "image.civitai.com" with nothing else
  civRegex: new RegExp(
    `^(?:https?://)?(?:image\\.)?(?:${(env.NEXT_PUBLIC_BASE_URL ?? 'civitai.com')
      .replace(/^https?:\/\//, '')
      .replace(/\./g, '\\.')}|civitai\\.com)`
  ),
  externalRegex: /^(?:https?:\/\/)?(?:www\.)?(github\.com|twitter\.com|x\.com)/,
};

export const entityCollaborators = {
  maxCollaborators: 15,
};

export const autoLabel = {
  labelTypes: ['tag', 'caption'] as const,
};

export const POST_IMAGE_LIMIT = 20;
export const POST_TAG_LIMIT = 5;
export const POST_MINIMUM_SCHEDULE_MINUTES = 60;
export const CAROUSEL_LIMIT = 20;
export const DEFAULT_EDGE_IMAGE_WIDTH = 450;
export const MAX_ANIMATION_DURATION_SECONDS = 30;
export const MAX_POST_IMAGES_WIDTH = 800;

export const MODELS_SEARCH_INDEX = 'models_v9';
export const IMAGES_SEARCH_INDEX = 'images_v6';
export const ARTICLES_SEARCH_INDEX = 'articles_v5';
export const USERS_SEARCH_INDEX = 'users_v3';
export const COLLECTIONS_SEARCH_INDEX = 'collections_v3';
export const BOUNTIES_SEARCH_INDEX = 'bounties_v3';
export const TOOLS_SEARCH_INDEX = 'tools_v2';

// Metrics:
export const METRICS_IMAGES_SEARCH_INDEX = 'metrics_images_v1';

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
};

export const DEFAULT_LIVE_FEATURE_FLAGS = {
  buzzGiftCards: false,
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

export const modelVersionMonetizationTypeOptions = {
  PaidAccess: 'Paid access',
  PaidEarlyAccess: 'Paid early access',
  CivitaiClubOnly: 'Exclusive to Civitai Club members',
  MySubscribersOnly: 'Exclusive to my subscribers',
  Sponsored: 'Sponsorships',
  PaidGeneration: 'Paid on-site generation',
};

export const modelVersionSponsorshipSettingsTypeOptions = {
  FixedPrice: 'Fixed Price',
  Bidding: 'Bidding',
};
