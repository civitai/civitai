import type { RegionInfo } from '~/server/utils/region-blocking';

export const CONSENT_COOKIE = 'civitai-consent';
export const CONSENT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export type ConsentDecision = 'accepted' | 'rejected';

// Regions where third-party analytics/advertising scripts must be gated behind
// explicit user consent. Currently only California (CIPA). Adding a new region
// here is the only change needed to expand coverage.
const CONSENT_REQUIRED_REGIONS = new Set<string>(['US:CA']);

export function isConsentRequired(region: RegionInfo | null | undefined): boolean {
  if (!region?.fullLocationCode) return false;
  return CONSENT_REQUIRED_REGIONS.has(region.fullLocationCode);
}

/** Persists a decision, or clears it with `null`. */
export function writeConsentCookie(value: ConsentDecision | null) {
  if (typeof document === 'undefined') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    value === null
      ? `${CONSENT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
      : `${CONSENT_COOKIE}=${value}; Path=/; Max-Age=${CONSENT_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

export function parseConsentCookie(value: unknown): ConsentDecision | null {
  return value === 'accepted' || value === 'rejected' ? value : null;
}
