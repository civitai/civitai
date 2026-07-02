import { CosmeticType } from '@civitai/db-schema/enums';

export { CosmeticType };

// Humanize an enum value for display: 'ProfileDecoration' → 'Profile Decoration'.
export const humanizeCosmeticType = (t: string): string => t.replace(/([a-z])([A-Z])/g, '$1 $2');

export const cosmeticTypeFilters = Object.values(CosmeticType).map((value) => ({
  value,
  label: humanizeCosmeticType(value),
}));

// Only url-based cosmetics (badges, profile decorations/backgrounds) render a visual sample in the
// moderator grant tool; nameplates + content-decoration frames identify by name + type badge for v1.
export type CosmeticData = { url?: string | null } | null;
