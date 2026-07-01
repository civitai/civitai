import { appRoles } from '@civitai/auth';
import type { SessionUser } from '@civitai/auth';

// Roles (`moderator:<role>`) are owned by the auth hub; this app maps them to the features they unlock.
export const APP = 'moderator';

type FeatureKind = 'feature' | 'page';
type FeatureDef = { label: string; description: string; kind: FeatureKind };

export const FEATURES = {
  reports: { label: 'Reports', description: 'The reports moderation queue.', kind: 'page' },
  images: { label: 'Images', description: 'Image moderation.', kind: 'page' },
  users: { label: 'Users', description: 'User moderation.', kind: 'page' },
} satisfies Record<string, FeatureDef>;

export type FeatureKey = keyof typeof FEATURES;

export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export const ROLE_FEATURES = {
  volunteer: ['reports'],
  lead: ['reports', 'images', 'users'],
} satisfies Record<string, FeatureKey[]>;

export function featuresForUser(user: Pick<SessionUser, 'roles'> | null | undefined): Set<FeatureKey> {
  const features = new Set<FeatureKey>();
  for (const role of appRoles(user, APP)) {
    for (const feature of ROLE_FEATURES[role as keyof typeof ROLE_FEATURES] ?? []) features.add(feature);
  }
  return features;
}

export function userHasFeature(
  user: Pick<SessionUser, 'roles'> | null | undefined,
  feature: FeatureKey
): boolean {
  return featuresForUser(user).has(feature);
}
