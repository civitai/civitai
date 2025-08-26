import type { IncomingHttpHeaders } from 'http';
import { camelCase } from 'lodash-es';
import type { SessionUser } from 'next-auth';
import { env } from '~/env/client';
import { isDev } from '~/env/other';
import { getDisplayName } from '~/utils/string-helpers';
import type { RegionInfo } from '~/server/utils/region-blocking';
import { getRegion } from '~/server/utils/region-blocking';

// --------------------------
// Feature Availability
// --------------------------
const envAvailability = ['dev'] as const;
type ServerAvailability = keyof typeof serverDomainMap;
export const serverDomainMap = {
  green: env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN,
  blue: env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE,
  red: env.NEXT_PUBLIC_SERVER_DOMAIN_RED,
} as const;
const serverAvailability = Object.keys(serverDomainMap) as ServerAvailability[];
export const userTiers = ['free', 'founder', 'bronze', 'silver', 'gold'] as const;
const roleAvailablity = ['public', 'user', 'mod', 'member', 'granted', ...userTiers] as const;
type RoleAvailability = (typeof roleAvailablity)[number];
const featureAvailability = [
  ...envAvailability,
  ...serverAvailability,
  ...roleAvailablity,
] as const;
const featureFlags = createFeatureFlags({
  canWrite: ['public'],
  earlyAccessModel: ['public'],
  apiKeys: ['public'],
  ambientCard: ['public'],
  gallery: ['public'],
  posts: ['mod', 'member'],
  articles: ['blue', 'red', 'public'],
  articleCreate: ['public'],
  adminTags: ['mod', 'granted'],
  civitaiLink: ['mod', 'member'],
  stripe: ['mod'],
  imageTraining: ['user'],
  videoTraining: ['mod', 'bronze', 'silver', 'gold'],
  imageTrainingResults: ['user'],
  sdxlGeneration: ['public'],
  questions: ['dev', 'mod'],
  imageGeneration: ['public'],
  largerGenerationImages: {
    toggleable: true,
    default: false,
    displayName: 'Larger Images in Generator',
    description: `Images displayed in the generator will be larger on small screens`,
    availability: ['public'],
  },
  enhancedSearch: ['public'],
  alternateHome: ['public'],
  collections: ['public'],
  air: {
    toggleable: true,
    default: true,
    displayName: 'AI Resource Identifier',
    description: `Show the Civitai AIR on resources for easy use within the Civitai Services API or Civitai Comfy Nodes.`,
    availability: ['user'],
  },
  profileCollections: ['public'],
  imageSearch: ['public'],
  buzz: ['public'],
  recommenders: isDev ? ['granted', 'dev', 'mod'] : ['dev', 'mod'],
  assistant: {
    toggleable: true,
    default: true,
    displayName: 'CivBot Assistant',
    description: `A helpful chat assistant that can answer questions about Stable Diffusion, Civitai, and more! We're still training it, so please report any issues you find!`,
    availability: ['user'],
  },
  assistantPersonality: ['bronze', 'silver', 'gold'],
  bounties: ['public'],
  newsroom: ['public'],
  safety: ['public'],
  csamReports: isDev ? ['mod'] : ['granted'],
  appealReports: isDev ? ['mod'] : ['granted'],
  reviewTrainingData: isDev ? ['mod'] : ['granted'],
  clubs: ['mod'],
  createClubs: ['mod', 'granted'],
  moderateTags: ['granted'],
  chat: {
    toggleable: true,
    default: true,
    displayName: 'Chats',
    description: 'Send and receive DMs from users across the site.',
    availability: ['user'],
  },
  creatorsProgram: ['mod', 'granted'],
  buzzWithdrawalTransfer: ['granted'],
  vault: ['user'],
  draftMode: ['public'],
  membershipsV2: ['public'],
  cosmeticShop: ['public'],
  impersonation: ['granted'],
  donationGoals: ['public'],
  creatorComp: ['public'],
  experimentalGen: ['mod'],
  imageIndex: ['public'],
  imageIndexFeed: ['public'],
  // #region [Domain Specific Features]
  isGreen: ['public', 'green'],
  isBlue: ['public', 'blue'],
  isRed: ['public', 'red'],
  canViewNsfw: ['public', 'blue', 'red'],
  canBuyBuzz: ['public'],
  adsEnabled: ['public', 'blue'],
  // #endregion
  // Temporarily disabled until we change ads provider -Manuel
  paddleAdjustments: ['granted'],
  announcements: ['granted'],
  blocklists: ['granted'],
  toolSearch: ['public'],
  generationOnlyModels: ['mod', 'granted', 'gold'],
  appTour: ['public'],
  privateModels: ['mod', 'granted'],
  auctions: ['blue', 'red', 'public'],
  newOrderGame: ['blue', 'red', 'public'],
  newOrderReset: ['granted'],
  changelogEdit: ['granted'],
  annualMemberships: ['public'],
  disablePayments: ['public'],
  prepaidMemberships: ['granted'],
  coinbasePayments: ['public'],
  coinbaseOnramp: ['mod'],
  nowpaymentPayments: [],
  zkp2pPayments: {
    availability: ['public'],
    regions: {
      include: ['US'], // US-only initially
    },
  },
  thirtyDayEarlyAccess: ['granted'],
  kontextAds: ['mod', 'granted'],
  logicalReplica: ['public'],
  modelVersionPopularity: ['mod'],
});

export const featureFlagKeys = Object.keys(featureFlags) as FeatureFlagKey[];

// --------------------------
// Logic
// --------------------------
type FeatureAccessContext = {
  user?: SessionUser;
  host?: string;
  req?: {
    headers: IncomingHttpHeaders;
    // url?: string;
  };
};
const hasFeature = (
  key: FeatureFlagKey,
  { user, req, host = req?.headers.host }: FeatureAccessContext
) => {
  const feature = featureFlags[key];
  const { availability } = feature;

  // Check environment availability
  const envRequirement = availability.includes('dev') ? isDev : availability.length > 0;

  // Check server availability
  let serverMatch = true;
  const availableServers = availability.filter((x) =>
    serverAvailability.includes(x as ServerAvailability)
  );
  if (!availableServers.length || !host) serverMatch = true;
  else {
    const domains = Object.entries(serverDomainMap).filter(
      ([key, domain]) => domain && availableServers.includes(key as ServerAvailability)
    );

    serverMatch = domains.some(([color, domain]) => {
      if (
        color === 'blue' &&
        ['stage.civitai.com', 'stage-0.civitai.com', 'dev.civitai.com'].includes(host) &&
        // No reason to forcefully enable `isBlue` if we can avoid it. The app doesn't rely on it for the most part.
        key !== 'isBlue'
      )
        return true;
      return host === domain;
    });
    // if server doesn't match, return false regardless of other availability flags
    if (!serverMatch) return false;
  }

  // Check granted access
  const grantedAccess = availability.includes('granted')
    ? !!user?.permissions?.includes(key)
    : false;

  // Check role availability
  const roles = availability.filter((x) => roleAvailablity.includes(x as RoleAvailability));
  let roleAccess = roles.length === 0 || roles.includes('public');
  if (!roleAccess && roles.length !== 0 && !!user) {
    if (roles.includes('user')) roleAccess = true;
    else if (roles.includes('mod') && user.isModerator) roleAccess = true;
    else if (!!user.tier && user.tier != 'free') {
      if (roles.includes('member')) roleAccess = true; // Gives access to any tier
      else if (roles.includes(user.tier as RoleAvailability)) roleAccess = true; // Gives access to specific tier
    }
  }

  // Check basic access first
  const hasBasicAccess = envRequirement && serverMatch && (grantedAccess || roleAccess);
  if (!hasBasicAccess) return false;

  // Check region restrictions if they exist
  if (feature.regions) {
    // Try to get region from request
    let region: RegionInfo | undefined;
    if (req) {
      region = getRegion(req as any);
    }
    // If no region info available, deny access when geo restrictions are in place
    if (!region?.countryCode) {
      return false;
    }

    const { include, exclude } = feature.regions;
    const countryCode = region.countryCode?.toUpperCase();

    // Check include list (whitelist)
    if (include && include.length > 0) {
      if (!countryCode || !include.includes(countryCode)) {
        return false;
      }
    }

    // Check exclude list (blacklist)
    if (exclude && exclude.length > 0) {
      if (countryCode && exclude.includes(countryCode)) {
        return false;
      }
    }
  }

  return true;
};

export type FeatureAccess = Record<FeatureFlagKey, boolean>;
export const getFeatureFlags = (ctx: FeatureAccessContext) => {
  const keys = Object.keys(featureFlags) as FeatureFlagKey[];

  return keys.reduce<FeatureAccess>((acc, key) => {
    acc[key] = hasFeature(key, ctx);
    return acc;
  }, {} as FeatureAccess);
};

export function getFeatureFlagsLazy(ctx: FeatureAccessContext) {
  const obj = {} as FeatureAccess & { features: FeatureAccess };

  for (const key in featureFlags) {
    Object.defineProperty(obj, key, {
      get() {
        if (!obj.features) {
          obj.features = getFeatureFlags(ctx);
        }
        return obj.features[key as keyof FeatureAccess];
      },
    });
  }
  return obj as FeatureAccess;
}

export const toggleableFeatures = Object.entries(featureFlags)
  .filter(([, value]) => value.toggleable)
  .map(([key, value]) => ({
    key: key as FeatureFlagKey,
    displayName: value.displayName,
    description: value.description,
    default: value.default ?? true,
  }));

type FeatureAvailability = (typeof featureAvailability)[number];
export type FeatureFlagKey = keyof typeof featureFlags;

type GeoRestrictions = {
  include?: string[]; // Whitelist regions (country codes)
  exclude?: string[]; // Blacklist regions (country codes)
};

type FeatureFlag = {
  displayName: string;
  description?: string;
  availability: FeatureAvailability[];
  toggleable: boolean;
  default?: boolean;
  regions?: GeoRestrictions; // Optional geo restrictions
};

// Simplified: Support either simple arrays or objects with any FeatureFlag properties
type FeatureFlagInput =
  | FeatureAvailability[]  // Legacy format: ['public']
  | Partial<FeatureFlag> & { availability: FeatureAvailability[] };  // Object with at least availability

function createFeatureFlags<T extends Record<string, FeatureFlagInput>>(flags: T) {
  const features = {} as { [K in keyof T]: FeatureFlag };
  const envOverrides = getEnvOverrides();

  for (const [key, value] of Object.entries(flags)) {
    // Convert arrays to object format for consistency
    const flagData = Array.isArray(value) ? { availability: value } : value;
    
    // Build the feature flag with defaults for missing properties
    features[key as keyof T] = {
      displayName: getDisplayName(key),  // Default display name
      toggleable: false,                  // Default not toggleable
      ...flagData,                        // Spread all provided properties (overrides defaults)
    } as FeatureFlag;

    // Apply ENV overrides
    const override = envOverrides[key as FeatureFlagKey];
    if (override) features[key as keyof T].availability = override;
  }

  return features;
}

function getEnvOverrides() {
  const processFeatureAvailability: Partial<Record<FeatureFlagKey, FeatureAvailability[]>> = {};
  // Set flags from ENV
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('FEATURE_FLAG_')) continue;
    const featureKey = camelCase(key.replace('FEATURE_FLAG_', ''));
    const availability: FeatureAvailability[] = [];

    for (const x of value?.split(',') ?? []) {
      if (featureAvailability.includes(x as FeatureAvailability))
        availability.push(x as FeatureAvailability);
    }
    processFeatureAvailability[featureKey as FeatureFlagKey] = availability;
  }

  return processFeatureAvailability;
}
