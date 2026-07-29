import {
  emptyOffsiteSubmitForm,
  pruneJustificationsToMask,
  shapeSensitiveJustifications,
  type OffsiteSubmitFormValues,
} from '~/components/Apps/offsiteSubmitFormConfig';
import { SENSITIVE_TOKEN_SCOPES } from '~/shared/constants/token-scope.constants';
import type { UpdateListingPatch } from '~/server/schema/blocks/offsite-listing.schema';
import type { MarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import type { OffsiteContentRating } from '~/server/schema/blocks/offsite-listing.schema';

/**
 * App Store Listings (W13) — dual-mode edit wizard config (PURE view-model).
 *
 * The `/apps/submit?edit=<listingId>` flow reuses `ExternalSubmitForm` in EDIT
 * mode. This module holds the PURE, unit-testable glue: the prefill payload shape
 * (mirrors the `appListings.getMyListingForEdit` proc result), the mapping of that
 * payload into the wizard's `OffsiteSubmitFormValues`, and the scalar-diff that
 * produces the minimal `UpdateListingPatch` for the save (never `slug` — it is the
 * immutable identity — and only the fields that actually changed).
 */

/** One prefill asset (icon/cover) — its imageId + an edge-resolved preview URL. */
export type EditAsset = { imageId: number | null; url: string | null };

/** One prefill screenshot — its row id + imageId + edge-resolved preview URL. */
export type EditScreenshot = {
  id: string;
  imageId: number | null;
  url: string | null;
  caption: string | null;
  order: number;
};

/**
 * The edit prefill payload (mirrors `GetMyListingForEditResult`). `parentId` is the
 * live listing id (the edit-target identity); `slug`/`status` describe the live
 * parent; `shadowId` hints the prefill came from an in-progress shadow.
 */
export type ListingEditContext = {
  parentId: string;
  slug: string;
  status: string;
  hasPendingRevision: boolean;
  shadowId: string | null;
  scalars: {
    name: string;
    tagline: string | null;
    description: string | null;
    category: string | null;
    contentRating: string | null;
    externalUrl: string | null;
  };
  assets: {
    icon: EditAsset;
    cover: EditAsset;
    screenshots: EditScreenshot[];
  };
  /**
   * OAuth-connect scope disclosure (present for the merged external-app model;
   * OPTIONAL so pre-existing non-connect edit contexts + tests still type-check):
   *   - `connectClientId`            — the linked client (null → no scope section).
   *   - `connectAllowedScopes`       — the client's CURRENT allowedScopes = the
   *     DERIVED requested set the form shows read-only + submits.
   *   - `connectRequestedScopes`     — the STORED snapshot (for drift detection).
   *   - `connectScopeJustifications` — the STORED per-scope rationale (prefill).
   */
  connectClientId?: string | null;
  connectAllowedScopes?: number | null;
  connectRequestedScopes?: number | null;
  connectScopeJustifications?: Record<string, string> | null;
};

/** True for an edit context whose live parent is APPROVED (→ shadow-revision path). */
export function isApprovedEdit(ctx: ListingEditContext): boolean {
  return ctx.status === 'approved';
}

/**
 * Map the edit prefill payload → the wizard form values. `slug` is filled from the
 * parent (shown read-only in edit mode); `changelog` starts blank (an edit note is
 * optional). A null tagline/description becomes '' (the form's blank), and a
 * null/unknown contentRating clamps to the SFW `'g'` default.
 */
export function editContextToForm(ctx: ListingEditContext): OffsiteSubmitFormValues {
  const base = emptyOffsiteSubmitForm();
  const s = ctx.scalars;
  // The requested scopes are DERIVED from the client's CURRENT allowedScopes (read-
  // only in the form; the server re-snapshots them on save). Prefilled justifications
  // are pruned to that derived set so a scope the client no longer has doesn't seed a
  // dangling rationale.
  const derivedScopes = ctx.connectAllowedScopes ?? 0;
  return {
    ...base,
    slug: ctx.slug,
    name: s.name ?? '',
    externalUrl: s.externalUrl ?? '',
    tagline: s.tagline ?? '',
    description: s.description ?? '',
    category: (s.category as MarketplaceCategory | null) ?? null,
    contentRating: (s.contentRating as OffsiteContentRating | null) ?? 'g',
    changelog: '',
    connectClientId: ctx.connectClientId ?? null,
    requestedScopes: derivedScopes,
    // SENSITIVE-only justification model: only sensitive scopes get an author
    // input, so the prefill keeps justifications for sensitive-derived scopes and
    // drops any non-sensitive (or no-longer-allowed) key — no dangling rationale.
    scopeJustifications: pruneJustificationsToMask(
      ctx.connectScopeJustifications ?? {},
      derivedScopes & SENSITIVE_TOKEN_SCOPES
    ),
  };
}

/** True iff two string→string maps have identical keys + values. PURE. */
function shallowEqualStringMap(
  a: Record<string, string>,
  b: Record<string, string>
): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/**
 * Build the minimal scalar patch from the original prefill → the current form
 * values, mirroring `updateListingPatchSchema` (PURE). Only CHANGED fields are
 * included; `slug` is NEVER patched (immutable identity). An empty tagline /
 * description is sent as `null` (clears the nullable column); a blank category is
 * `null`. Returns `{}` when nothing changed (the caller then skips the mutation).
 */
export function buildScalarPatch(
  ctx: ListingEditContext,
  current: OffsiteSubmitFormValues
): UpdateListingPatch {
  const original = editContextToForm(ctx);
  const patch: UpdateListingPatch = {};

  const name = current.name.trim();
  if (name !== original.name.trim()) patch.name = name;

  const url = current.externalUrl.trim();
  if (url !== original.externalUrl.trim()) patch.externalUrl = url;

  const tagline = current.tagline.trim();
  const originalTagline = original.tagline.trim();
  if (tagline !== originalTagline) patch.tagline = tagline.length > 0 ? tagline : null;

  const description = current.description.trim();
  const originalDescription = original.description.trim();
  if (description !== originalDescription)
    patch.description = description.length > 0 ? description : null;

  if ((current.category ?? null) !== (original.category ?? null)) {
    patch.category = current.category ?? null;
  }

  if (current.contentRating !== original.contentRating) {
    patch.contentRating = current.contentRating;
  }

  // OAuth-connect scope disclosure: the server re-snapshots `requestedScopes` from
  // the client's CURRENT allowedScopes whenever the patch touches scopes, so we send
  // the (derived) mask + shaped justifications when EITHER the justifications changed
  // OR the client's allowedScopes drifted from the stored snapshot. Both re-enter mod
  // review on an approved listing (a scope change is material). No client → no scope
  // section, nothing to diff.
  if (ctx.connectClientId != null) {
    const derived = ctx.connectAllowedScopes ?? 0;
    const storedSnapshot = ctx.connectRequestedScopes ?? 0;
    // Both sides shaped SENSITIVE-only so a legacy non-sensitive stored rationale
    // (which the form no longer surfaces) never registers as a spurious diff.
    const storedJust = shapeSensitiveJustifications(
      ctx.connectScopeJustifications ?? {},
      storedSnapshot
    );
    const currentJust = shapeSensitiveJustifications(current.scopeJustifications, derived);
    const drifted = derived !== storedSnapshot;
    if (drifted || !shallowEqualStringMap(currentJust, storedJust)) {
      patch.requestedScopes = derived;
      patch.scopeJustifications = currentJust;
    }
  }

  return patch;
}

/** True when the scalar patch has at least one changed field (a save is needed). */
export function hasScalarChanges(patch: UpdateListingPatch): boolean {
  return Object.keys(patch).length > 0;
}
