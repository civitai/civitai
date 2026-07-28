import type { ListingMetaSuggestion } from '~/server/utils/og-metadata';

/**
 * App Store Listings (W13) — PURE status/note derivation for the external-listing
 * autofill (shared by the create + edit wizards via `useListingAutofill`).
 *
 * The old copy conflated "the site exposed nothing" with "your fields are already
 * filled" ("Your site didn't expose an icon, cover or description to pull (or your
 * fields are already filled)") — misleading on a fresh CREATE where the fields were
 * empty and the SITE simply had nothing (the radio.civitai.com case). This splits
 * the outcome into four honest states + a reason, computed deterministically from
 * (a) what the SITE exposed and (b) what actually became ACTIONABLE given the current
 * form state (a suggestion for an already-filled slot is not actionable):
 *
 *   - `error`   — the fetch failed (no data).
 *   - `empty`   — nothing was applied. `siteExposedNothing` disambiguates the copy:
 *                 `true`  → the page's <head> genuinely exposed nothing;
 *                 `false` → it exposed something, but it's already filled in.
 *   - `partial` — something was applied/surfaced, but the page did NOT expose every
 *                 expected channel (`missing` lists which of description/cover/icon).
 *   - `applied` — something was applied AND the page exposed all expected channels.
 */

export type ListingAutofillStatus = 'applied' | 'partial' | 'empty' | 'error';

export type ListingAutofillResult = {
  status: ListingAutofillStatus;
  /** For `empty` only: did the site expose nothing at all (vs everything already filled)? */
  siteExposedNothing?: boolean;
  /** For `partial` only: expected channels the page did NOT expose. */
  missing?: Array<'description' | 'cover' | 'icon'>;
};

/** What a pull ACTUALLY changed, given current form state (computed by the caller). */
export type ListingAutofillActioned = {
  /** At least one empty text field (name/tagline/description) got filled by this pull. */
  filledText: boolean;
  /** At least one icon/cover suggestion is actionable (its slot is currently empty). */
  suggestedAsset: boolean;
};

/**
 * Which channels the SITE exposed (independent of form state) — an icon counts
 * whether it came as an https URL or an inline data URI.
 */
export function siteExposedChannels(data: ListingMetaSuggestion | undefined): {
  name: boolean;
  description: boolean;
  cover: boolean;
  icon: boolean;
} {
  return {
    name: !!data?.name,
    description: !!data?.description || !!data?.tagline,
    cover: !!data?.coverImageUrl,
    icon: !!data?.iconImageUrl || !!data?.iconDataUri,
  };
}

/**
 * Derive the four-state autofill outcome. `errored` short-circuits to `error`.
 * Otherwise: nothing exposed → `empty` (siteExposedNothing); exposed-but-nothing-
 * actionable → `empty` (already filled); actionable + every expected channel present
 * → `applied`; actionable but some expected channel absent → `partial` (+ `missing`).
 */
export function computeAutofillStatus(input: {
  errored: boolean;
  data: ListingMetaSuggestion | undefined;
  actioned: ListingAutofillActioned;
}): ListingAutofillResult {
  if (input.errored) return { status: 'error' };
  const site = siteExposedChannels(input.data);
  const anyExposed = site.name || site.description || site.cover || site.icon;
  if (!anyExposed) return { status: 'empty', siteExposedNothing: true };

  const anyActioned = input.actioned.filledText || input.actioned.suggestedAsset;
  if (!anyActioned) return { status: 'empty', siteExposedNothing: false };

  const missing: Array<'description' | 'cover' | 'icon'> = [];
  if (!site.description) missing.push('description');
  if (!site.cover) missing.push('cover');
  if (!site.icon) missing.push('icon');
  if (missing.length === 0) return { status: 'applied' };
  return { status: 'partial', missing };
}

/** Human phrase for the channels a `partial` pull did NOT expose (e.g. "a cover or an icon"). */
export function describeMissingChannels(
  missing: Array<'description' | 'cover' | 'icon'> | undefined
): string {
  const labels: Record<'description' | 'cover' | 'icon', string> = {
    description: 'a description',
    cover: 'a cover',
    icon: 'an icon',
  };
  const parts = (missing ?? []).map((m) => labels[m]);
  if (parts.length === 0) return 'some details';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
}
