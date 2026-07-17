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
import {
  SCOPE_JUSTIFICATION_MAX_LENGTH,
  connectScopesSubsetOfCeiling,
  tokenScopeKeyByBit,
  tokenScopeMaskToList,
} from '~/shared/constants/token-scope.constants';
import { OFFSITE_SLUG_MAX, OFFSITE_SLUG_MIN } from '~/components/Apps/offsiteSubmitFormConfig';
import { Flags } from '~/shared/utils/flags';

/**
 * App Store Listings (W13) — OAuth-CONNECT submit form field/validation config
 * (PURE view-model). CLIENT-SIDE mirror of `submitConnectListingSchema` +
 * `connectScopesSubsetOfCeiling` / `validateConnectScopeJustifications` so the
 * `/apps/submit` "Connect an app" form surfaces inline errors BEFORE the round-trip.
 * The SERVER stays the source of truth — the same `SLUG_REGEX`, `OFFSITE_*` bounds,
 * category taxonomy and scope helpers are imported here (NOT re-declared) so this
 * mirror can't drift from the contract.
 *
 * Extracted (no JSX) so the field bounds, the scope-subset gating and the payload
 * shaping are unit-testable without mounting the form.
 */

export const CONNECT_SUBMIT_LIMITS = {
  slugMin: OFFSITE_SLUG_MIN,
  slugMax: OFFSITE_SLUG_MAX,
  nameMax: OFFSITE_NAME_MAX,
  taglineMax: OFFSITE_TAGLINE_MAX,
  descriptionMax: OFFSITE_DESCRIPTION_MAX,
  changelogMax: OFFSITE_CHANGELOG_MAX,
  justificationMax: SCOPE_JUSTIFICATION_MAX_LENGTH,
} as const;

export type ConnectSubmitFormValues = {
  /** The id of the caller's own OAuth client (chosen in the picker). */
  connectClientId: string | null;
  /** The disclosed requested-scope bitmask (⊆ the selected client's allowedScopes). */
  requestedScopes: number;
  /** enum-key → rationale (only checked scopes get an entry). */
  scopeJustifications: Record<string, string>;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category: MarketplaceCategory | null;
  contentRating: OffsiteContentRating;
  changelog: string;
};

export type ConnectSubmitFormErrors = Partial<
  Record<keyof ConnectSubmitFormValues, string>
>;

/** Category `<Select>` data (value + human label). */
export const CONNECT_CATEGORY_OPTIONS: Array<{ value: MarketplaceCategory; label: string }> =
  MARKETPLACE_CATEGORIES.map((c) => ({
    value: c,
    label: c.charAt(0).toUpperCase() + c.slice(1),
  }));

/** Content-rating `<Select>` data. */
export const CONNECT_CONTENT_RATING_OPTIONS: Array<{
  value: OffsiteContentRating;
  label: string;
}> = OFFSITE_CONTENT_RATINGS.map((r) => ({ value: r, label: r.toUpperCase() }));

/** Blank initial state — NO client, NO scopes checked (explicit opt-in from empty). */
export function emptyConnectSubmitForm(): ConnectSubmitFormValues {
  return {
    connectClientId: null,
    requestedScopes: 0,
    scopeJustifications: {},
    slug: '',
    name: '',
    tagline: '',
    description: '',
    category: null,
    contentRating: 'g',
    changelog: '',
  };
}

/**
 * Toggle a single scope bit in `requestedScopes`, pruning any justification whose
 * scope is no longer requested (so the payload never carries a dangling rationale
 * the server would reject). PURE.
 */
export function toggleScopeBit(
  values: ConnectSubmitFormValues,
  bit: number
): ConnectSubmitFormValues {
  const requestedScopes = Flags.hasFlag(values.requestedScopes, bit)
    ? values.requestedScopes & ~bit
    : values.requestedScopes | bit;
  // Prune justifications for scopes no longer requested.
  const requestedKeys = new Set(tokenScopeMaskToList(requestedScopes).map((s) => s.key));
  const scopeJustifications: Record<string, string> = {};
  for (const [key, text] of Object.entries(values.scopeJustifications)) {
    if (requestedKeys.has(key)) scopeJustifications[key] = text;
  }
  return { ...values, requestedScopes, scopeJustifications };
}

/**
 * Validate the form client-side, mirroring `submitConnectListingSchema` +
 * `connectScopesSubsetOfCeiling`. `allowedScopes` is the selected client's ceiling
 * (0 when no client picked). Returns a per-field error map (empty = valid).
 */
export function validateConnectSubmitForm(
  values: ConnectSubmitFormValues,
  allowedScopes: number
): ConnectSubmitFormErrors {
  const errors: ConnectSubmitFormErrors = {};

  if (!values.connectClientId) {
    errors.connectClientId = 'Choose one of your OAuth apps.';
  }

  if (!connectScopesSubsetOfCeiling(values.requestedScopes, allowedScopes)) {
    errors.requestedScopes = 'A requested scope is not allowed by this OAuth app.';
  }

  for (const [, text] of Object.entries(values.scopeJustifications)) {
    if (text.length > SCOPE_JUSTIFICATION_MAX_LENGTH) {
      errors.scopeJustifications = `Each justification must be at most ${SCOPE_JUSTIFICATION_MAX_LENGTH} characters.`;
      break;
    }
  }

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

/** The Step-0 (client + scopes) gate: a client is chosen and the subset is valid. */
export function isConnectClientStepComplete(
  values: ConnectSubmitFormValues,
  allowedScopes: number
): boolean {
  return (
    !!values.connectClientId &&
    connectScopesSubsetOfCeiling(values.requestedScopes, allowedScopes) &&
    Object.values(values.scopeJustifications).every(
      (t) => t.length <= SCOPE_JUSTIFICATION_MAX_LENGTH
    )
  );
}

/** The Details-step gate: the whole client mirror validates. */
export function isConnectDetailsStepComplete(
  values: ConnectSubmitFormValues,
  allowedScopes: number
): boolean {
  return Object.keys(validateConnectSubmitForm(values, allowedScopes)).length === 0;
}

/**
 * Shape the form state into the `submitConnectListing` mutation input: trim the text
 * fields, coerce empty optionals to `undefined`, and reduce `scopeJustifications` to
 * ONLY the requested scopes with a non-empty (trimmed) rationale — so an unfilled
 * textarea is omitted (the server accepts an empty map) and no dangling key is sent.
 * PURE + unit-tested. `connectClientId` MUST be set (gated by the client step).
 */
export function toSubmitConnectInput(values: ConnectSubmitFormValues): {
  slug: string;
  name: string;
  connectClientId: string;
  requestedScopes: number;
  scopeJustifications: Record<string, string>;
  tagline?: string;
  description?: string;
  category?: MarketplaceCategory;
  contentRating: OffsiteContentRating;
  changelog?: string;
} {
  const requestedKeys = new Set(tokenScopeMaskToList(values.requestedScopes).map((s) => s.key));
  const scopeJustifications: Record<string, string> = {};
  for (const [key, text] of Object.entries(values.scopeJustifications)) {
    const trimmed = text.trim();
    if (trimmed.length > 0 && requestedKeys.has(key)) scopeJustifications[key] = trimmed;
  }
  return {
    slug: values.slug.trim(),
    name: values.name.trim(),
    connectClientId: values.connectClientId ?? '',
    requestedScopes: values.requestedScopes,
    scopeJustifications,
    tagline: values.tagline.trim() || undefined,
    description: values.description.trim() || undefined,
    category: values.category ?? undefined,
    contentRating: values.contentRating,
    changelog: values.changelog.trim() || undefined,
  };
}

/** The enum-key for a scope bit (re-export for the form's justification map keys). */
export function scopeKeyForBit(bit: number): string {
  return tokenScopeKeyByBit(bit) ?? String(bit);
}
