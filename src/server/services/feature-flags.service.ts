import { camelCase } from 'lodash-es';
import { SessionUser } from 'next-auth';
import { isDev } from '~/env/other';
import { env } from '~/env/server.mjs';
import { getDisplayName } from '~/utils/string-helpers';

// --------------------------
// Feature Availability
// --------------------------
const envAvailability = ['dev'] as const;
const serverAvailability = ['green', 'blue', 'red'] as const;
type ServerAvailability = (typeof serverAvailability)[number];
const roleAvailablity = ['public', 'user', 'mod', 'member', 'granted'] as const;
type RoleAvailability = (typeof roleAvailablity)[number];
const featureAvailability = [
  ...envAvailability,
  ...serverAvailability,
  ...roleAvailablity,
] as const;
const featureFlags = createFeatureFlags({
  earlyAccessModel: ['public'],
  apiKeys: ['public'],
  ambientCard: ['public'],
  gallery: ['mod', 'member'],
  posts: ['mod', 'member'],
  articles: ['public'],
  articleCreate: ['public'],
  adminTags: ['mod', 'granted'],
  civitaiLink: ['mod', 'member'],
  stripe: ['mod'],
  imageTraining: ['dev', 'mod', 'member'],
  imageTrainingResults: ['user'],
  sdxlGeneration: ['public'],
  questions: ['dev', 'mod'],
  imageGeneration: {
    toggleable: true,
    default: true,
    displayName: 'Image Generation',
    description: `Generate images with any supported AI resource.`,
    availability: ['public'],
  },
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
  imageSearch: ['dev'],
  buzz: ['public'],
  signal: ['user'],
  assistant: {
    toggleable: true,
    default: true,
    displayName: 'CivBot Assistant',
    description: `A helpful chat assistant that can answer questions about Stable Diffusion, Civitai, and more! We're still training it, so please report any issues you find!`,
    availability: ['mod', 'member'],
  },
  bounties: ['public'],
  newsroom: ['public'],
  safety: ['mod'],
  csamReports: ['granted'],
  reviewTrainingData: ['granted'],
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
  vault: ['mod'],
  draftMode: ['mod'],
  membershipsV2: ['mod'],
  cosmeticShop: ['public'],
  impersonation: ['granted'],
  donationGoals: ['public'],
  creatorComp: ['user'],
  experimentalGen: ['mod'],
  imageIndex: ['granted', 'mod'],
  imageIndexFeed: ['granted', 'mod'],
});
export const featureFlagKeys = Object.keys(featureFlags) as FeatureFlagKey[];

// --------------------------
// Logic
// --------------------------
const serverDomainMap: Record<ServerAvailability, string | undefined> = {
  green: env.SERVER_DOMAIN_GREEN,
  blue: env.SERVER_DOMAIN_BLUE,
  red: env.SERVER_DOMAIN_RED,
};

type FeatureAccessContext = { user?: SessionUser; req?: { url?: string } };
export const hasFeature = (key: FeatureFlagKey, { user, req }: FeatureAccessContext) => {
  const { availability } = featureFlags[key];

  // Check environment availability
  const envRequirement = availability.includes('dev') ? isDev : availability.length > 0;

  // Check server availability
  let serverRequirement = false;
  const availableServers = availability.filter((x) =>
    serverAvailability.includes(x as ServerAvailability)
  );
  if (!availableServers.length || !req?.url) serverRequirement = true;
  else {
    for (const server of availableServers) {
      const domain = serverDomainMap[server as ServerAvailability];
      if (!domain) continue;
      if (req.url.includes(domain)) {
        serverRequirement = true;
        break;
      }
    }
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
    else if (!!user.tier && user.tier != 'free' && roles.includes('member')) roleAccess = true; // Gives access to any tier
  }

  return envRequirement && serverRequirement && (grantedAccess || roleAccess);
};

export type FeatureAccess = Record<FeatureFlagKey, boolean>;
export const getFeatureFlags = (ctx: FeatureAccessContext) => {
  const keys = Object.keys(featureFlags) as FeatureFlagKey[];
  return keys.reduce<FeatureAccess>((acc, key) => {
    acc[key] = hasFeature(key, ctx);
    return acc;
  }, {} as FeatureAccess);
};

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
type FeatureFlag = {
  displayName: string;
  description?: string;
  availability: FeatureAvailability[];
  toggleable: boolean;
  default?: boolean;
};

function createFeatureFlags<T extends Record<string, FeatureFlag | FeatureAvailability[]>>(
  flags: T
) {
  const features = {} as { [K in keyof T]: FeatureFlag };
  const envOverrides = getEnvOverrides();

  for (const [key, value] of Object.entries(flags)) {
    if (Array.isArray(value))
      features[key as keyof T] = {
        availability: value,
        toggleable: false,
        displayName: getDisplayName(key),
      };
    else features[key as keyof T] = value;

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
