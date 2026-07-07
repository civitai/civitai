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

/**
 * Derive a suggested `name` + `slug` from a candidate external URL, for the
 * External-link submit wizard's Step 1 → Step 2 prefill. PURE + deterministic so
 * it is unit-testable without the form.
 *
 * Rules (chosen + pinned by the unit tests):
 *   - The URL must pass the shared `validateExternalUrl` (absolute, https-only,
 *     has a host). An invalid / `http:` / empty / unparseable URL yields
 *     `{ name: '', slug: '' }` and NEVER throws — the wizard then just shows the
 *     existing inline https validation error and prefills nothing.
 *   - Take the hostname (already lowercased by the URL parser), strip a leading
 *     `www.`, and use the FIRST dot-label as the base
 *     (`vitrine.civitai.com` → `vitrine`; `www.my-app.io` → `my-app`).
 *   - `name`  = the base, hyphen-word title-cased: each `-`-separated word gets
 *     its first char upper-cased and the remainder lower-cased, rejoined with
 *     `-` (`vitrine` → `Vitrine`; `my-app` → `My-App`; `example` → `Example`).
 *   - `slug`  = the base kebab-cased + SLUG_REGEX-sanitized: lower-cased, every
 *     run of non `[a-z0-9]` chars collapsed to a single `-`, leading/trailing `-`
 *     trimmed, and any leading non-letters dropped (SLUG_REGEX requires a leading
 *     letter). If the sanitized result can't satisfy SLUG_REGEX (e.g. a
 *     single-char host like `x.com`) OR falls outside the server's
 *     `OFFSITE_SLUG_MIN`–`OFFSITE_SLUG_MAX` length bound (e.g. `ab.com` → len 2,
 *     or a ≥41-char DNS label), `slug` is `''` (name may still be set) — the
 *     prefill never seeds a value the client validator would reject.
 */
export function deriveListingFromUrl(url: string): { name: string; slug: string } {
  const validation = validateExternalUrl(url);
  if (!validation.ok) return { name: '', slug: '' };

  let hostname: string;
  try {
    hostname = new URL(validation.url).hostname;
  } catch {
    return { name: '', slug: '' };
  }

  const base = hostname.replace(/^www\./i, '').split('.')[0] ?? '';
  if (base.length === 0) return { name: '', slug: '' };

  const name = base
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('-');

  const slugCandidate = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '');
  const slug =
    SLUG_REGEX.test(slugCandidate) &&
    slugCandidate.length >= OFFSITE_SLUG_MIN &&
    slugCandidate.length <= OFFSITE_SLUG_MAX
      ? slugCandidate
      : '';

  return { name, slug };
}

/**
 * Wizard step-gating (PURE, unit-tested). The External-link submit wizard is:
 *   Step 0 (URL) → Step 1 (Details) → Step 2 (Assets).
 *
 * `isUrlStepComplete`     — the URL passes the shared https validation, so the
 *                           Details step is reachable.
 * `isDetailsStepComplete` — the whole client mirror validates (name/slug/category/
 *                           rating + the still-required URL), so the draft can be
 *                           created and the Assets step entered.
 *
 * The Assets step itself is only reachable AFTER the server creates the draft
 * (`submitExternalListing` succeeds); that transition is owned by the component,
 * not this pure gate.
 */
export function isUrlStepComplete(values: OffsiteSubmitFormValues): boolean {
  return validateExternalUrl(values.externalUrl).ok;
}

export function isDetailsStepComplete(values: OffsiteSubmitFormValues): boolean {
  return isOffsiteSubmitFormValid(values);
}
