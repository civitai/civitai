import { camelCase } from 'lodash-es';
import { SessionUser } from 'next-auth';
import { isDev } from '~/env/other';
import { getDisplayName } from '~/utils/string-helpers';

// --------------------------
// Feature Availability
// --------------------------
const featureAvailability = ['dev', 'mod', 'public', 'user', 'founder', 'granted'] as const;
const featureFlags = createFeatureFlags({
  earlyAccessModel: ['dev'],
  apiKeys: ['public'],
  ambientCard: ['public'],
  gallery: ['mod', 'founder'],
  posts: ['mod', 'founder'],
  articles: ['public'],
  articleCreate: ['public'],
  adminTags: ['mod', 'granted'],
  civitaiLink: ['mod', 'founder'],
  stripe: ['mod'],
  imageTraining: ['dev', 'mod', 'founder'],
  imageGeneration: {
    toggleable: true,
    default: true,
    displayName: 'Image Generation (Preview)',
    description: `Generate images with any supported AI resource. This is still in tech preview, so please report any issues you find!`,
    availability: ['user'],
  },
  enhancedSearch: {
    toggleable: true,
    default: true,
    displayName: 'Quick Search (Beta)',
    description: `We're improving our search experience! Starting with a new quick search feature with more coming soon. This is a beta feature, so please report any issues you find!`,
    availability: ['public'],
  },
  alternateHome: {
    toggleable: true,
    default: true,
    displayName: 'New Home Page',
    description: `A new home page with a more modern design and more features. This is a beta feature, so please report any issues you find!`,
    availability: ['public'],
  },
  collections: ['public'],
  air: {
    toggleable: true,
    default: false,
    displayName: 'AI Resource Identifier',
    description: `Show the Civitai AIR on resources to make it easier to pull them into the Civitai Comfy Nodes.`,
    availability: ['user'],
  },
  modelCardV2: {
    toggleable: true,
    default: false,
    displayName: 'Model Card V2',
    description: `A fresh style for model cards with more information and a better layout.`,
    availability: ['user'],
  },
  profileCollections: ['mod', 'founder'],
});
export const featureFlagKeys = Object.keys(featureFlags);

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
    else if (user.tier && roles.includes(user.tier as FeatureAvailability)) roleAccess = true;
  }

  return (
    (availability.includes('dev') && isDev) || (devRequirement && (grantedAccess || roleAccess))
  );
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
  const features: { [K in keyof T]: FeatureFlag } = {} as any;
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
