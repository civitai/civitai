import type { PrivacySettingsSchema } from '~/server/schema/user-profile.schema';

/** Whether the owner lets this badge show on their profile. A null id is checked against showBadges only. */
export function isBadgeShownOnProfile(
  privacy: PrivacySettingsSchema | null | undefined,
  cosmeticId: number | null
) {
  if (privacy?.showBadges === false) return false;
  return cosmeticId == null || !privacy?.hiddenBadgeIds?.includes(cosmeticId);
}
