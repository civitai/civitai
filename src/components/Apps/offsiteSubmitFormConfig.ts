import {
  MAX_EXTERNAL_URL_LENGTH,
  validateExternalUrl,
} from '~/server/schema/blocks/external-app.schema';
import {
  OFFSITE_CHANGELOG_MAX,
  OFFSITE_CONTENT_RATINGS,
  OFFSITE_DESCRIPTION_MAX,
  OFFSITE_NAME_MAX,
  OFFSITE_TAGLINE_MAX,
  type OffsiteContentRating,
} from '~/server/schema/blocks/offsite-listing.schema';
import { SLUG_REGEX } from '~/server/schema/blocks/publish-request.schema';
import {
  MARKETPLACE_CATEGORIES,
  isMarketplaceCategory,
  type MarketplaceCategory,
} from '~/server/services/blocks/marketplace-categories.constants';

/**
 * App Store Listings (W13) — P3a external-submit form field/validation config
 * (PURE view-model). A CLIENT-SIDE mirror of `submitExternalListingSchema` so the
 * `/apps/submit` External-link form can surface inline errors BEFORE the round-trip
 * — the server stays the source of truth (the same `validateExternalUrl`,
 * `SLUG_REGEX`, `OFFSITE_*` bounds and category taxonomy are imported here, NOT
 * re-declared, so the client mirror can't drift from the server contract).
 *
 * Extracted (no JSX) so the field bounds + the validation mapping are unit-testable
 * without mounting the form.
 */

/** Slug bounds (mirror `submitExternalListingSchema.slug`: min 3, max 40, SLUG_REGEX). */
export const OFFSITE_SLUG_MIN = 3;
export const OFFSITE_SLUG_MAX = 40;

/** The field bounds surfaced in the form (single source: the schema consts). */
export const OFFSITE_SUBMIT_LIMITS = {
  slugMin: OFFSITE_SLUG_MIN,
  slugMax: OFFSITE_SLUG_MAX,
  nameMax: OFFSITE_NAME_MAX,
  taglineMax: OFFSITE_TAGLINE_MAX,
  descriptionMax: OFFSITE_DESCRIPTION_MAX,
  changelogMax: OFFSITE_CHANGELOG_MAX,
  urlMax: MAX_EXTERNAL_URL_LENGTH,
} as const;

export type OffsiteSubmitFormValues = {
  slug: string;
  name: string;
  externalUrl: string;
  tagline: string;
  description: string;
  category: MarketplaceCategory | null;
  contentRating: OffsiteContentRating;
  changelog: string;
};

export type OffsiteSubmitFormErrors = Partial<
  Record<keyof OffsiteSubmitFormValues, string>
>;

/** Category `<Select>` data (value + human label). */
export const OFFSITE_CATEGORY_OPTIONS: Array<{ value: MarketplaceCategory; label: string }> =
  MARKETPLACE_CATEGORIES.map((c) => ({
    value: c,
    label: c.charAt(0).toUpperCase() + c.slice(1),
  }));

/** Content-rating `<Select>` data. */
export const OFFSITE_CONTENT_RATING_OPTIONS: Array<{ value: OffsiteContentRating; label: string }> =
  OFFSITE_CONTENT_RATINGS.map((r) => ({ value: r, label: r.toUpperCase() }));

/** The blank initial form state (SFW default, no category). */
export function emptyOffsiteSubmitForm(): OffsiteSubmitFormValues {
  return {
    slug: '',
    name: '',
    externalUrl: '',
    tagline: '',
    description: '',
    category: null,
    contentRating: 'g',
    changelog: '',
  };
}

/**
 * Validate the form client-side, mirroring `submitExternalListingSchema`. Returns a
 * per-field error map (empty = valid). Delegates the URL shape to the shared
 * `validateExternalUrl` (https-only, length-bounded) and the slug shape to
 * `SLUG_REGEX`, so a `http://` / bad-slug / over-long input is caught inline exactly
 * as the server would reject it.
 */
export function validateOffsiteSubmitForm(
  values: OffsiteSubmitFormValues
): OffsiteSubmitFormErrors {
  const errors: OffsiteSubmitFormErrors = {};

  const slug = values.slug.trim();
  if (slug.length < OFFSITE_SLUG_MIN || slug.length > OFFSITE_SLUG_MAX) {
    errors.slug = `Slug must be ${OFFSITE_SLUG_MIN}–${OFFSITE_SLUG_MAX} characters.`;
  } else if (!SLUG_REGEX.test(slug)) {
    errors.slug = 'Slug must be lowercase a–z / 0–9 / hyphens and start with a letter.';
  }

  const name = values.name.trim();
  if (name.length < 1) {
    errors.name = 'Name is required.';
  } else if (name.length > OFFSITE_NAME_MAX) {
    errors.name = `Name must be at most ${OFFSITE_NAME_MAX} characters.`;
  }

  const url = validateExternalUrl(values.externalUrl);
  if (!url.ok) errors.externalUrl = url.error;

  if (values.tagline.length > OFFSITE_TAGLINE_MAX) {
    errors.tagline = `Tagline must be at most ${OFFSITE_TAGLINE_MAX} characters.`;
  }
  if (values.description.length > OFFSITE_DESCRIPTION_MAX) {
    errors.description = `Description must be at most ${OFFSITE_DESCRIPTION_MAX} characters.`;
  }
  if (values.changelog.length > OFFSITE_CHANGELOG_MAX) {
    errors.changelog = `Changelog must be at most ${OFFSITE_CHANGELOG_MAX} characters.`;
  }

  if (values.category != null && !isMarketplaceCategory(values.category)) {
    errors.category = 'Unknown category.';
  }

  if (!(OFFSITE_CONTENT_RATINGS as readonly string[]).includes(values.contentRating)) {
    errors.contentRating = 'Unknown content rating.';
  }

  return errors;
}

/** True when the form has no field errors (Submit-enabled gate). */
export function isOffsiteSubmitFormValid(values: OffsiteSubmitFormValues): boolean {
  return Object.keys(validateOffsiteSubmitForm(values)).length === 0;
}
