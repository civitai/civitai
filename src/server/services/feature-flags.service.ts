import { SessionUser } from 'next-auth';
import { env } from '~/env/server.mjs';

const featureAvailability = ['dev', 'mod', 'public', 'tier1'] as const;
type FeatureAvailability = typeof featureAvailability[number];

const createTypedDictionary = <T extends Record<string, FeatureAvailability[]>>(dictionary: T) =>
  dictionary as { [K in keyof T]: FeatureAvailability[] };

type FeatureFlagKey = keyof typeof featureFlags;
const featureFlags = createTypedDictionary({
  earlyAccessModel: ['dev'],
  memberBadges: ['dev'],
});

const isDev = env.NODE_ENV === 'development';

export type FeatureFlags = Record<FeatureFlagKey, boolean>;
export const getFeatureFlags = ({ user }: { user?: SessionUser }) => {
  const keys = Object.keys(featureFlags) as FeatureFlagKey[];
  return keys.reduce<FeatureFlags>((acc, key) => {
    acc[key] = false; // ensure a value

    const flags = featureFlags[key];
    if (flags.includes('dev') && !isDev) acc[key] = false;
    else {
      acc[key] = (flags.includes('mod') && user?.isModerator) || flags.includes('public');
    }

    return acc;
  }, {} as FeatureFlags);
};
