/** Shared color / style constants for the Dynamic Prize Pool card sections. */

export const SECTION_COLORS = {
  teal: { dark: 'rgba(52,211,153,0.30)', light: 'rgba(16,185,129,0.40)' },
  yellow: { dark: 'rgba(250,176,5,0.30)', light: 'rgba(250,176,5,0.40)' },
  gray: { dark: 'rgba(128,128,128,0.25)', light: 'rgba(128,128,128,0.30)' },
} as const;

export const SECTION_GLOWS = {
  teal: 'rgba(52,211,153,0.5)',
  yellow: 'rgba(250,176,5,0.5)',
  gray: 'rgba(128,128,128,0.4)',
} as const;

export const SECTION_BACKGROUNDS = {
  teal: {
    dark: 'linear-gradient(135deg, rgba(16,185,129,0.14) 0%, rgba(52,211,153,0.05) 100%)',
    light: 'linear-gradient(135deg, rgba(16,185,129,0.18) 0%, rgba(52,211,153,0.06) 100%)',
  },
  yellow: {
    dark: 'linear-gradient(135deg, rgba(250,176,5,0.10) 0%, rgba(250,176,5,0.03) 100%)',
    light: 'linear-gradient(135deg, rgba(250,176,5,0.12) 0%, rgba(250,176,5,0.04) 100%)',
  },
  neutral: {
    dark: 'rgba(26,27,30,0.6)',
    light: 'rgba(241,243,245,0.6)',
  },
} as const;

export const INSET_SHADOWS = {
  large: {
    dark: 'inset 0 6px 12px -4px rgba(0,0,0,0.5)',
    light: 'inset 0 6px 12px -4px rgba(0,0,0,0.1)',
  },
  small: {
    dark: 'inset 0 2px 4px rgba(0,0,0,0.4)',
    light: 'inset 0 2px 4px rgba(0,0,0,0.15)',
  },
} as const;

type ColorScheme = 'dark' | 'light';
type ColorVariant = keyof typeof SECTION_COLORS;

export function getBorderColor(scheme: ColorScheme, variant: ColorVariant) {
  return SECTION_COLORS[variant][scheme];
}

export function getBorder(scheme: ColorScheme, variant: ColorVariant) {
  return `1px solid ${getBorderColor(scheme, variant)}`;
}

export function getGlowGradient(variant: ColorVariant) {
  return `radial-gradient(200px circle at var(--spotlight-x) 0px, ${SECTION_GLOWS[variant]}, transparent 70%)`;
}

export function getBackground(scheme: ColorScheme, variant: keyof typeof SECTION_BACKGROUNDS) {
  return SECTION_BACKGROUNDS[variant][scheme];
}

export function getShadow(scheme: ColorScheme, size: keyof typeof INSET_SHADOWS) {
  return INSET_SHADOWS[size][scheme];
}

/** Preview state data for mod-only toggle. */
export const PREVIEW_STATES = {
  0: { reviewedCount: 0, unreviewedCount: 0, totalEntries: 0, userEntryCount: 0, hasFlatRatePurchase: false },
  1: { reviewedCount: 2, unreviewedCount: 3, totalEntries: 5, userEntryCount: 5, hasFlatRatePurchase: false },
  2: { reviewedCount: 5, unreviewedCount: 0, totalEntries: 5, userEntryCount: 5, hasFlatRatePurchase: true },
} as const;
