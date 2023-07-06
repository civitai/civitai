import { camelCase } from 'lodash-es';
import { SessionUser } from 'next-auth';
import { isDev } from '~/env/other';

/** 'dev' AND ('mod' OR 'public' OR etc...)  */
const featureAvailability = ['dev', 'mod', 'public', 'user', 'founder', 'granted'] as const;
type FeatureAvailability = (typeof featureAvailability)[number];

const createTypedDictionary = <T extends Record<string, FeatureAvailability[]>>(dictionary: T) =>
  dictionary as { [K in keyof T]: FeatureAvailability[] };

type FeatureFlagKey = keyof typeof featureFlags;
const featureFlags = createTypedDictionary({
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
  imageGeneration: ['user'],
});

// Set flags from ENV
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith('FEATURE_FLAG_')) continue;
  const featureKey = camelCase(key.replace('FEATURE_FLAG_', ''));
  if (featureKey in featureFlags) {
    const availability: FeatureAvailability[] = [];

    for (const x of value?.split(',') ?? []) {
      if (featureAvailability.includes(x as FeatureAvailability))
        availability.push(x as FeatureAvailability);
    }

    featureFlags[featureKey as FeatureFlagKey] = availability;
  }
}

export type FeatureFlags = Record<FeatureFlagKey, boolean>;
export const getFeatureFlags = ({ user }: { user?: SessionUser }) => {
  const keys = Object.keys(featureFlags) as FeatureFlagKey[];
  return keys.reduce<FeatureFlags>((acc, key) => {
    acc[key] = false; // set default

    const flags = featureFlags[key];
    const devRequirement = flags.includes('dev') ? isDev : flags.length > 0;
    const grantedAccess = flags.includes('granted') ? !!user?.permissions?.includes(key) : false;

    const roles = flags.filter((x) => x !== 'dev');
    let roleAccess = roles.length === 0 || roles.includes('public');
    if (!roleAccess && roles.length !== 0 && !!user) {
      if (roles.includes('user')) roleAccess = true;
      else if (roles.includes('mod') && user.isModerator) roleAccess = true;
      else if (user.tier && roles.includes(user.tier as FeatureAvailability)) roleAccess = true;
    }

    acc[key] = devRequirement && (grantedAccess || roleAccess);

    return acc;
  }, {} as FeatureFlags);
};
