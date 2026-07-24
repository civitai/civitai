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
import {
  SCOPE_JUSTIFICATION_MAX_LENGTH,
  SENSITIVE_TOKEN_SCOPES,
  connectScopesSubsetOfCeiling,
  isSensitiveTokenScope,
  tokenScopeKeyByBit,
  tokenScopeMaskToList,
} from '~/shared/constants/token-scope.constants';

/**
 * App Store Listings (W13) — external-app submit form field/validation config
 * (PURE view-model). A CLIENT-SIDE mirror of `submitExternalListingSchema` (the
 * MERGED external+connect model — every external app links its own OAuth client)
 * so the `/apps/submit` form can surface inline errors BEFORE the round-trip — the
 * server stays the source of truth (the same `validateExternalUrl`, `SLUG_REGEX`,
 * `OFFSITE_*` bounds, category taxonomy and scope helpers are imported here, NOT
 * re-declared, so the client mirror can't drift from the server contract).
 *
 * Extracted (no JSX) so the field bounds, the scope-subset gating and the payload
 * shaping are unit-testable without mounting the form.
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
  justificationMax: SCOPE_JUSTIFICATION_MAX_LENGTH,
} as const;

export type OffsiteSubmitFormValues = {
  slug: string;
  name: string;
  /** OPTIONAL homepage / Visit link (may be blank in the merged model). */
  externalUrl: string;
  tagline: string;
  description: string;
  category: MarketplaceCategory | null;
  contentRating: OffsiteContentRating;
  changelog: string;
  /** REQUIRED: the id of the caller's own OAuth client (chosen in the picker). */
  connectClientId: string | null;
  /**
   * The requested-scope bitmask, AUTO-DERIVED from the selected client's
   * `allowedScopes` (no longer author-picked). Kept in the view-model so the
   * read-only display + justification inputs iterate it and the client mirror can
   * assert the (now trivial) subset invariant; the SERVER re-snapshots it from the
   * client's current `allowedScopes` at submit time (authoritative).
   */
  requestedScopes: number;
  /** enum-key → rationale (only derived scopes get an entry). */
  scopeJustifications: Record<string, string>;
};

export type OffsiteSubmitFormErrors = Partial<Record<keyof OffsiteSubmitFormValues, string>>;

/** Category `<Select>` data (value + human label). */
export const OFFSITE_CATEGORY_OPTIONS: Array<{ value: MarketplaceCategory; label: string }> =
  MARKETPLACE_CATEGORIES.map((c) => ({
    value: c,
    label: c.charAt(0).toUpperCase() + c.slice(1),
  }));

/** Content-rating `<Select>` data. */
export const OFFSITE_CONTENT_RATING_OPTIONS: Array<{ value: OffsiteContentRating; label: string }> =
  OFFSITE_CONTENT_RATINGS.map((r) => ({ value: r, label: r.toUpperCase() }));

/** The blank initial form state (SFW default, no category, no client / scopes). */
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
    connectClientId: null,
    requestedScopes: 0,
    scopeJustifications: {},
  };
}

/**
 * Validate the METADATA fields client-side, mirroring `submitExternalListingSchema`'s
 * display shape. Returns a per-field error map (empty = valid). Delegates the URL
 * shape to the shared `validateExternalUrl` (https-only, length-bounded) ONLY WHEN a
 * URL is provided (it's optional in the merged model), and the slug shape to
 * `SLUG_REGEX`, so a `http://` / bad-slug / over-long input is caught inline exactly
 * as the server would reject it. Does NOT check the OAuth-client / scope fields — the
 * CREATE form combines this with {@link validateConnectFields} (the edit wizard, which
 * edits metadata only, calls this alone).
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

  // externalUrl is OPTIONAL — only validate the https shape when one is provided.
  if (values.externalUrl.trim().length > 0) {
    const url = validateExternalUrl(values.externalUrl);
    if (!url.ok) errors.externalUrl = url.error;
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
 * Normalize a raw "Link URL" input into the canonical https URL that will be
 * STORED / submitted. PURE + unit-tested. Locked policy: *prepend https if the
 * scheme is missing, but REJECT an explicit `http://`* (don't silently upgrade —
 * make the user fix it so they're never surprised their http link became https).
 *
 * Rules (deterministic, pinned by the unit tests):
 *   - trim; empty → `{ url: '', error }` (as `validateExternalUrl` would).
 *   - starts with `http://` (case-insensitive) → `{ url: '', error }` with a
 *     "Use https://" message — NOT a silent upgrade.
 *   - contains NO scheme separator (`://`) → prepend `https://` (a bare domain
 *     `example.com/app`, or a `host:port` like `example.com:8443/app`, becomes
 *     `https://…`). A pseudo-scheme with no `://` (`javascript:…`, `data:…`) is
 *     also prepended, then rejected by `validateExternalUrl` when the resulting
 *     string fails to parse — the reject outcome is what matters.
 *   - already has a scheme (`https://…`, `ftp://…`, …) → passed through unchanged
 *     to `validateExternalUrl`, which accepts only https and rejects the rest.
 *   - then run the shared `validateExternalUrl` on the result → `{ url }` (the
 *     canonical https URL) on ok, else `{ url: '', error }`.
 *
 * The SERVER validation (`validateExternalUrl`, https-only) is unchanged; the
 * client just normalizes so the submitted `externalUrl` is already https.
 */
export function normalizeLinkUrl(raw: string): { url: string; error?: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { url: '', error: 'externalUrl must not be empty' };
  }
  // Explicit http:// → reject (do NOT silently upgrade to https).
  if (/^http:\/\//i.test(trimmed)) {
    return { url: '', error: 'Use https:// (or omit the scheme)' };
  }
  // No scheme separator → prepend https://. A scheme present (`ftp://`, `data:…`
  // once it parses, etc.) is left for `validateExternalUrl` to reject.
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  const result = validateExternalUrl(candidate);
  if (!result.ok) return { url: '', error: result.error };
  return { url: result.url };
}

/**
 * `isUrlStepComplete` — the OPTIONAL homepage URL is EITHER blank OR passes the
 * shared https validation. Used by the EDIT wizard's URL step (a listing may or may
 * not carry a homepage link). A blank URL is valid in the merged model.
 */
export function isUrlStepComplete(values: OffsiteSubmitFormValues): boolean {
  return values.externalUrl.trim().length === 0 || validateExternalUrl(values.externalUrl).ok;
}

/**
 * `isDetailsStepComplete` — the METADATA mirror validates (name/slug/category/rating
 * + the OPTIONAL URL when present). Used by the EDIT wizard. The CREATE form uses
 * {@link isCreateDetailsStepComplete} (which additionally requires the OAuth client).
 */
export function isDetailsStepComplete(values: OffsiteSubmitFormValues): boolean {
  return isOffsiteSubmitFormValid(values);
}

// ---------------------------------------------------------------------------
// OAuth-client link fields (the merged model — every external app links its own
// OAuth client). Client-side mirror of the SERVICE checks
// (`loadConnectClientForListing` / `assertConnectScopesValid`) so the CREATE form
// surfaces inline errors before the round-trip; the SERVER stays source of truth.
// ---------------------------------------------------------------------------

/** The enum-key for a scope bit (used as the justification-map key). */
export function scopeKeyForBit(bit: number): string {
  return tokenScopeKeyByBit(bit) ?? String(bit);
}

/** One expanded scope row from a mask: `{ bit, key, label }`. */
export type ScopeEntry = { bit: number; key: string; label: string };

/**
 * Split a requested-scope mask into SENSITIVE vs NON-SENSITIVE rows (each
 * `{ bit, key, label }`, sorted by bit). Sensitivity is the shared
 * `isSensitiveTokenScope` predicate (money / private data / cross-user writes) —
 * the SAME classification the server's approval gate (`assertConnectSensitiveScopes
 * Justified`) and the mod-review `ConnectScopesPanel` use, so the author sees
 * exactly the scopes that will require a justification before approval. PURE.
 */
export function partitionScopesBySensitivity(mask: number): {
  sensitive: ScopeEntry[];
  nonSensitive: ScopeEntry[];
} {
  const scopes = tokenScopeMaskToList(mask);
  return {
    sensitive: scopes.filter((s) => isSensitiveTokenScope(s.bit)),
    nonSensitive: scopes.filter((s) => !isSensitiveTokenScope(s.bit)),
  };
}

/**
 * The SENSITIVE scope keys in `mask` whose justification is blank (missing or
 * whitespace-only). Empty ⇒ every sensitive scope is justified. Non-sensitive
 * scopes are never required, so they never appear here. PURE.
 */
export function missingSensitiveJustifications(values: OffsiteSubmitFormValues): string[] {
  return partitionScopesBySensitivity(values.requestedScopes)
    .sensitive.map((s) => s.key)
    .filter((key) => (values.scopeJustifications[key] ?? '').trim().length === 0);
}

/**
 * Shape justifications for the SUBMIT/EDIT payload keeping ONLY sensitive scopes
 * (non-sensitive scopes have no author input and need no rationale — see
 * {@link shapeScopeJustifications}). Trims, drops empties, and prunes any key not
 * a currently-requested SENSITIVE scope. PURE — the single source both the create
 * payload and the edit scalar-diff use, so they stay byte-identical.
 */
export function shapeSensitiveJustifications(
  justifications: Record<string, string>,
  mask: number
): Record<string, string> {
  return shapeScopeJustifications(justifications, mask & SENSITIVE_TOKEN_SCOPES);
}

/**
 * Validate the per-scope justification map, mirroring the SENSITIVE-only model:
 *   - every value ≤ SCOPE_JUSTIFICATION_MAX_LENGTH (the shared server bound), and
 *   - every SENSITIVE requested scope carries a non-empty justification.
 * Non-sensitive scopes are never required. Returns a single error string (or
 * undefined). PURE — shared by the create validator + the edit save gate.
 */
export function scopeJustificationError(values: OffsiteSubmitFormValues): string | undefined {
  for (const text of Object.values(values.scopeJustifications)) {
    if (text.length > SCOPE_JUSTIFICATION_MAX_LENGTH) {
      return `Each justification must be at most ${SCOPE_JUSTIFICATION_MAX_LENGTH} characters.`;
    }
  }
  if (missingSensitiveJustifications(values).length > 0) {
    return 'Add a justification for each sensitive permission.';
  }
  return undefined;
}

/**
 * Drop every justification whose scope is NOT in `mask` (the derived requested set),
 * so the payload never carries a dangling rationale for a scope the app no longer
 * requests (which the server would reject). PURE.
 */
export function pruneJustificationsToMask(
  justifications: Record<string, string>,
  mask: number
): Record<string, string> {
  const keys = new Set(tokenScopeMaskToList(mask).map((s) => s.key));
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(justifications)) {
    if (keys.has(key)) out[key] = text;
  }
  return out;
}

/**
 * AUTO-DERIVE the requested scopes from the selected client's `allowedScopes`: the
 * listing requests EXACTLY the client's allowed set (no author picking), and any
 * justification for a scope no longer present is pruned. Called on selecting /
 * changing the OAuth client. PURE. (Replaces the removed `toggleScopeBit` — the
 * picker is gone; scopes are derived, not toggled.)
 */
export function deriveScopesFromClient(
  values: OffsiteSubmitFormValues,
  allowedScopes: number
): OffsiteSubmitFormValues {
  return {
    ...values,
    requestedScopes: allowedScopes,
    scopeJustifications: pruneJustificationsToMask(values.scopeJustifications, allowedScopes),
  };
}

/**
 * Shape a raw justification map into the SUBMIT/EDIT payload form: trim each value,
 * DROP empties, and keep only keys whose scope is in `mask` (the derived requested
 * set). PURE — the single source for both `toSubmitExternalInput` (create) and the
 * edit scalar-patch diff, so the two produce byte-identical justification payloads.
 */
export function shapeScopeJustifications(
  justifications: Record<string, string>,
  mask: number
): Record<string, string> {
  const keys = new Set(tokenScopeMaskToList(mask).map((s) => s.key));
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(justifications)) {
    const trimmed = text.trim();
    if (trimmed.length > 0 && keys.has(key)) out[key] = trimmed;
  }
  return out;
}

/**
 * Validate the OAuth-client / scope fields client-side, mirroring
 * `loadConnectClientForListing` + `assertConnectScopesValid`. `allowedScopes` is the
 * selected client's ceiling (0 when no client picked). Returns a per-field error map
 * (empty = valid) over the connect fields only.
 */
export function validateConnectFields(
  values: OffsiteSubmitFormValues,
  allowedScopes: number
): OffsiteSubmitFormErrors {
  const errors: OffsiteSubmitFormErrors = {};

  if (!values.connectClientId) {
    errors.connectClientId = 'Choose one of your OAuth apps.';
  }

  if (!connectScopesSubsetOfCeiling(values.requestedScopes, allowedScopes)) {
    errors.requestedScopes = 'A requested scope is not allowed by this OAuth app.';
  }

  // SENSITIVE-only justification model: sensitive scopes each REQUIRE a rationale
  // (mirrors the server approval gate); non-sensitive scopes are read-only, never
  // required. Also bounds any provided justification's length.
  const justificationError = scopeJustificationError(values);
  if (justificationError) errors.scopeJustifications = justificationError;

  return errors;
}

/**
 * The full CREATE-form validation: the metadata mirror + the OAuth-client / scope
 * mirror. `allowedScopes` is the selected client's ceiling. Returns a per-field error
 * map (empty = valid).
 */
export function validateExternalCreateForm(
  values: OffsiteSubmitFormValues,
  allowedScopes: number
): OffsiteSubmitFormErrors {
  return { ...validateOffsiteSubmitForm(values), ...validateConnectFields(values, allowedScopes) };
}

/**
 * The CREATE wizard App-URL step gate (now the FIRST step): the App URL is
 * REQUIRED — a non-blank, valid https URL. (Contrast {@link isUrlStepComplete},
 * the EDIT gate, which grandfathers a blank URL on a pre-existing listing.)
 */
export function isCreateUrlStepComplete(values: OffsiteSubmitFormValues): boolean {
  return values.externalUrl.trim().length > 0 && validateExternalUrl(values.externalUrl).ok;
}

/**
 * The CREATE wizard App & scopes gate: a client is chosen, the derived scopes are
 * a valid subset of the client's ceiling, and every SENSITIVE scope carries a
 * (bounded, non-empty) justification. The App URL is gated on its OWN first step
 * now, so it is no longer checked here.
 */
export function isClientStepComplete(
  values: OffsiteSubmitFormValues,
  allowedScopes: number
): boolean {
  return (
    !!values.connectClientId &&
    connectScopesSubsetOfCeiling(values.requestedScopes, allowedScopes) &&
    scopeJustificationError(values) === undefined
  );
}

/** The CREATE wizard Details-step gate: the whole create mirror validates. */
export function isCreateDetailsStepComplete(
  values: OffsiteSubmitFormValues,
  allowedScopes: number
): boolean {
  return Object.keys(validateExternalCreateForm(values, allowedScopes)).length === 0;
}

/**
 * Shape the form state into the `submitExternalListing` mutation input: trim the text
 * fields, coerce empty optionals to `undefined` (an omitted App URL is left OUT),
 * and reduce `scopeJustifications` to ONLY the requested SENSITIVE scopes with a
 * non-empty (trimmed) rationale. PURE + unit-tested. `connectClientId` MUST be set
 * (gated by the client step).
 */
export function toSubmitExternalInput(values: OffsiteSubmitFormValues): {
  slug: string;
  name: string;
  connectClientId: string;
  requestedScopes: number;
  scopeJustifications: Record<string, string>;
  externalUrl?: string;
  tagline?: string;
  description?: string;
  category?: MarketplaceCategory;
  contentRating: OffsiteContentRating;
  changelog?: string;
} {
  // Only SENSITIVE scopes carry a justification in the merged model; non-sensitive
  // keys are pruned so a stale/legacy rationale never rides along in the payload.
  const scopeJustifications = shapeSensitiveJustifications(
    values.scopeJustifications,
    values.requestedScopes
  );
  return {
    slug: values.slug.trim(),
    name: values.name.trim(),
    connectClientId: values.connectClientId ?? '',
    requestedScopes: values.requestedScopes,
    scopeJustifications,
    externalUrl: values.externalUrl.trim() || undefined,
    tagline: values.tagline.trim() || undefined,
    description: values.description.trim() || undefined,
    category: values.category ?? undefined,
    contentRating: values.contentRating,
    changelog: values.changelog.trim() || undefined,
  };
}
