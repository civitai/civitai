import { SessionUser } from 'next-auth';

/** 'dev' AND ('mod' OR 'public' OR etc...)  */
const featureAvailability = ['dev', 'mod', 'public', 'tier1'] as const;
type FeatureAvailability = typeof featureAvailability[number];

const createTypedDictionary = <T extends Record<string, FeatureAvailability[]>>(dictionary: T) =>
  dictionary as { [K in keyof T]: FeatureAvailability[] };

type FeatureFlagKey = keyof typeof featureFlags;
const featureFlags = createTypedDictionary({
  earlyAccessModel: ['dev'],
  memberBadges: ['dev'],
  apiKeys: ['dev'],
  ambientCard: ['public'],
});

const isDev = process.env.NODE_ENV === 'development';

export type FeatureFlags = Record<FeatureFlagKey, boolean>;
export const getFeatureFlags = ({ user }: { user?: SessionUser }) => {
  const keys = Object.keys(featureFlags) as FeatureFlagKey[];
  return keys.reduce<FeatureFlags>((acc, key) => {
    acc[key] = false; // set default

    const flags = featureFlags[key];
    const devRequirement = flags.includes('dev') ? isDev : flags.length > 0;
    const otherRequirement =
      flags.filter((x) => x !== 'dev').length > 0
        ? (flags.includes('mod') && user?.isModerator) || flags.includes('public')
        : true;

    acc[key] = devRequirement && otherRequirement;

    return acc;
  }, {} as FeatureFlags);
};
