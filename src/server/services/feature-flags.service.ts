import { camelCase } from 'lodash-es';
import { SessionUser } from 'next-auth';
import { isDev } from '~/env/other';
import { getDisplayName } from '~/utils/string-helpers';

// --------------------------
// Feature Availability
// --------------------------
const featureAvailability = ['dev', 'mod', 'public', 'user', 'member', 'granted'] as const;
const featureFlags = createFeatureFlags({
  earlyAccessModel: ['dev'],
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
    displayName: 'Image Generation (Beta)',
    description: `Generate images with any supported AI resource. This is a beta feature, so please report any issues you find!`,
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
  modelCardV2: {
    toggleable: true,
    default: true,
    displayName: 'Model Card V2',
    description: `A fresh style for model cards with more information and a better layout.`,
    availability: ['public'],
  },
  profileCollections: ['public'],
  imageSearch: ['dev'],
  buzz: ['public'],
  signal: ['user'],
  assistant: {
    toggleable: true,
    default: true,
    displayName: 'CivBot Assistant (Alpha)',
    description: `A helpful chat assistant that can answer questions about Stable Diffusion, Civitai, and more! We're still training it, so please report any issues you find!`,
    availability: ['mod', 'member'],
  },
  bounties: ['public'],
  newsroom: ['public'],
  safety: ['mod'],
  profileOverhaul: {
    toggleable: true,
    default: true,
    displayName: 'Profile v2 (Beta)',
    description: `An improved user profile experience to boast around.`,
    availability: ['public'],
  },
  csamReports: ['granted'],
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
});
export const featureFlagKeys = Object.keys(featureFlags) as FeatureFlagKey[];

// --------------------------
// Logic
// --------------------------
export const hasFeature = (key: FeatureFlagKey, user?: SessionUser) => {
  const { availability } = featureFlags[key];
  const devRequirement = availability.includes('dev') ? isDev : availability.length > 0;
  const grantedAccess = availability.includes('granted')
    ? !!user?.permissions?.includes(key)
    : false;

  const roles = availability.filter((x) => x !== 'dev');
  let roleAccess = roles.length === 0 || roles.includes('public');
  if (!roleAccess && roles.length !== 0 && !!user) {
    if (roles.includes('user')) roleAccess = true;
    else if (roles.includes('mod') && user.isModerator) roleAccess = true;
    else if (!!user.tier && user.tier != 'free' && roles.includes('member'))
      roleAccess = true; // Gives access to any tier
    else if (user.tier && roles.includes(user.tier as FeatureAvailability)) roleAccess = true;
  }

  return devRequirement && (grantedAccess || roleAccess);
};

export type FeatureAccess = Record<FeatureFlagKey, boolean>;
export const getFeatureFlags = ({ user }: { user?: SessionUser }) => {
  const keys = Object.keys(featureFlags) as FeatureFlagKey[];
  return keys.reduce<FeatureAccess>((acc, key) => {
    acc[key] = hasFeature(key, user);
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
