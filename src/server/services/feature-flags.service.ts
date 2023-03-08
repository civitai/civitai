import { camelCase } from 'lodash';
import { SessionUser } from 'next-auth';
import { isDev } from '~/env/other';

/** 'dev' AND ('mod' OR 'public' OR etc...)  */
const featureAvailability = ['dev', 'mod', 'public', 'founder'] as const;
type FeatureAvailability = (typeof featureAvailability)[number];

const createTypedDictionary = <T extends Record<string, FeatureAvailability[]>>(dictionary: T) =>
  dictionary as { [K in keyof T]: FeatureAvailability[] };

type FeatureFlagKey = keyof typeof featureFlags;
const featureFlags = createTypedDictionary({
  earlyAccessModel: ['dev'],
  apiKeys: ['public'],
  ambientCard: ['public'],
  gallery: ['mod', 'founder'],
  civitaiLink: ['mod'],
  stripe: ['mod'],
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
    const otherRequirement =
      flags.filter((x) => x !== 'dev').length > 0
        ? (flags.includes('mod') && user?.isModerator) ||
          flags.includes('public') ||
          (!!user?.tier && flags.includes(user.tier as FeatureAvailability))
        : true;

    acc[key] = devRequirement && otherRequirement;

    return acc;
  }, {} as FeatureFlags);
};
