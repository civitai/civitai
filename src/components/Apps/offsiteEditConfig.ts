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
  /**
   * The listing's KIND.
   *
   * 🔴 OPTIONAL, and absent means OFF-SITE — this form began life as the off-site submit
   * wizard's edit mode, so every pre-existing context and fixture predates the field and
   * must keep its exact behaviour. See {@link isOnsiteEdit}.
   */
  kind?: 'onsite' | 'offsite';
  status: string;
  /**
   * The CALLER's role on this listing — `owner`, or `editor` for an accepted seat.
   *
   * 🔴 OPTIONAL, AND ABSENT IS TREATED AS "ROLE UNKNOWN" RATHER THAN AS "OWNER". Optional
   * for the same reason `kind` is: every pre-existing fixture predates the field. But the
   * fail-safe here runs the OTHER way from a normal narrowing — an unknown role must not
   * be told "you unpublished it" or "republish it from the Publishing tab", because those
   * are false for an editor and there is no way to tell from absence. So
   * {@link materialEditBlockedReason} emits ROLE-NEUTRAL wording when this is absent,
   * which is true for both, and the owner-specific phrasing only on a positive `'owner'`.
   * See {@link isOwnerEdit}.
   */
  role?: 'owner' | 'editor';
  hasPendingRevision: boolean;
  shadowId: string | null;
  scalars: {
    name: string;
    tagline: string | null;
    description: string | null;
    category: string | null;
    contentRating: string | null;
    externalUrl: string | null;
    /**
     * The public source-repository link. OPTIONAL on this type so every pre-existing
     * edit context + fixture (all of which predate the field) still type-checks, and
     * absent reads exactly like "not set" — see {@link editContextToForm}.
     */
    sourceRepoUrl?: string | null;
    /**
     * The author's beta declaration. OPTIONAL on this type so every pre-existing edit
     * context + fixture (all of which predate the field) still type-checks, and absent reads
     * exactly like "not in beta" — see {@link editContextToForm}.
     */
    isBeta?: boolean;
    betaMessage?: string | null;
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
 * True for an edit context whose live parent is UNPUBLISHED — the owner-repair state.
 * PURE.
 *
 * 🔴 `status === 'removed'` IS SUFFICIENT *HERE*, AND ONLY BECAUSE OF WHERE THIS CONTEXT
 * COMES FROM. `ListingEditContext` is `getMyListingForEdit`'s result, and that proc's
 * `removed` branch reads the last STATUS-CHANGING moderation action on the PRIMARY and
 * throws `FORBIDDEN` unless it is the owner's own `owner-unpublish`
 * (`app-listing-owner-unpublish`). So a moderator takedown never produces a context at all
 * — the form is not reached, `AppsListingDetailsEditor` renders its error alert instead.
 * A `removed` context that EXISTS is therefore owner-unpublished by construction.
 *
 * 🔴 AND THE FAILURE DIRECTION IS SAFE IF THAT EVER STOPS BEING TRUE. Should a mod-removed
 * listing somehow reach this form, this predicate still returns `true`, the material inputs
 * are still disabled, and the author is still told the truth — the server would refuse
 * every one of those edits anyway. The mistake this CANNOT make is enabling an input the
 * server refuses, which is the whole point.
 */
export function isUnpublishedEdit(ctx: Pick<ListingEditContext, 'status'>): boolean {
  return ctx.status === 'removed';
}

/**
 * Why this listing's MATERIAL scalar fields cannot be edited right now, or `null` when they
 * can. PURE.
 *
 * 🔴 THIS MIRRORS A REFUSAL THAT ALREADY EXISTS SERVER-SIDE; it does not invent a rule.
 * `updateListing`'s `removed` branch throws `MATERIAL_CHANGE_BLOCKED` (→ `BAD_REQUEST`) for
 * any change to a field in `MATERIAL_LISTING_PATCH_FIELDS`, and it does so AFTER the author
 * has typed the change and pressed Save. Until the editor tabs opened on this state that
 * was unreachable; opening them without this makes it four inputs an author can fill and
 * can never save, which is strictly worse than not offering the field at all. The PREFILL
 * being wider than the write is deliberate — an author must be able to READ their current
 * name and URL — and that is a different thing from offering an EDIT.
 *
 * 🔴 THE COPY NAMES THE WAY OUT, because the server's message does and an author who is
 * only told "no" has nowhere to go: republish, then edit, and the edit is staged for
 * review.
 *
 * Kind-aware for the same reason the header is (`listingEditHeaderCopy`): an on-site
 * listing has no App URL and is rendered no step that could change one, so naming it here
 * would describe a field that is not on screen.
 */
export function materialEditBlockedReason(
  ctx: Pick<
    ListingEditContext,
    | 'status'
    | 'kind'
    | 'role'
    | 'connectClientId'
    | 'connectAllowedScopes'
    | 'connectRequestedScopes'
  >
): string | null {
  if (!isUnpublishedEdit(ctx)) return null;
  const fields = isOnsiteEdit(ctx)
    ? 'name, source repository and content rating'
    : 'name, App URL, source repository and content rating';

  // 🔴 ROLE-AWARE, AND THE DEFAULT IS THE NEUTRAL ONE — see `ListingEditContext.role`.
  // `loadOwnedEditableListing` admits an accepted editor seat, so this copy is read by
  // people who did NOT unpublish the app and who cannot see the Publishing tab
  // (`editorTabsFor` makes `publishing` owner-only). Naming that tab at an editor is an
  // instruction they cannot follow, so they are pointed at the person who can.
  const wayOut = isOwnerEdit(ctx)
    ? `Republish the app from the Publishing tab first, then edit those fields — the ` +
      `edit is staged for review.`
    : `The app's owner has to republish it before those fields can be edited — the ` +
      `Publishing tab that does it is theirs, not yours.`;

  // 🔴 THE SCOPE-DRIFT ARM, AND IT EXISTS BECAUSE THE OLD LAST SENTENCE WAS FALSE IN
  // EXACTLY THE STATE `scopeDisclosureLockedForEdit` EXISTS FOR.
  //
  // It ended "Tagline, description and category can be edited now." When the connect
  // client's `allowedScopes` have DRIFTED from the stored snapshot, that is untrue and the
  // screen is a hard dead end:
  //
  //   - `buildScalarPatch` emits the drifted `requestedScopes` on EVERY save, so even a
  //     tagline-only edit carries a material change and the server refuses it; and
  //   - `handleSave` runs `scopeJustificationError(values)` for any connect listing, and a
  //     newly-added sensitive scope has no prefilled justification (`editContextToForm`
  //     prunes justifications to the DERIVED mask), so the save aborts CLIENT-side first
  //     and steers the author to Details — where `scopeDisclosureLockedForEdit` has
  //     disabled the very boxes that would clear the error.
  //
  // So the author was invited to edit three fields, and could not save any of them, with
  // the copy insisting otherwise. The outcome is honest (the server would refuse too); the
  // sentence was not. Say the true thing instead — nothing here can be saved until the
  // scopes are re-reviewed — rather than describing an edit that cannot land.
  if (scopeDisclosureLockedForEdit(ctx)) {
    const scopeWayOut = isOwnerEdit(ctx)
      ? `republish the app from the Publishing tab`
      : `ask the app's owner to republish it`;
    return (
      `This app is unpublished, so its ${fields} are locked — and your OAuth app's ` +
      `permissions have changed since this listing was last reviewed. That changed ` +
      `permission set rides along on every save, so while the app stays unpublished ` +
      `NOTHING on this screen can be saved — not the tagline, description or category ` +
      `either. To edit anything, ${scopeWayOut}; the new permissions are then reviewed ` +
      `along with your changes.`
    );
  }

  return (
    `This app is unpublished, so its ${fields} are locked. Changing any of them needs ` +
    `moderator review, and an unpublished listing has no way to reach it. ${wayOut} ` +
    `Tagline, description and category can be edited now.`
  );
}

/**
 * Is the caller the listing's OWNER? PURE.
 *
 * 🔴 FAIL-SAFE DEFAULT IS `false`, i.e. "not proven to be the owner" — and that direction is
 * the opposite of what a narrowing usually wants, so it is worth stating why. This predicate
 * does not gate a capability; it only picks which SENTENCE the author reads. The owner
 * phrasing asserts two things an editor would find false ("you unpublished it", "republish
 * it from the Publishing tab" — a tab `editorTabsFor` withholds from an editor). The
 * role-neutral phrasing is true for BOTH. So an absent role must resolve to the neutral
 * copy, never to the owner copy.
 */
export function isOwnerEdit(ctx: Pick<ListingEditContext, 'role'>): boolean {
  return ctx.role === 'owner';
}

/**
 * Does the OAuth scope disclosure ALSO have to be locked in the repair state? PURE.
 *
 * 🔴 A JUSTIFICATION EDIT IS NORMALLY TRIVIAL, SO THIS IS NOT "LOCK IT WHEN UNPUBLISHED".
 * `buildScalarPatch` emits `requestedScopes` when the justifications changed OR when the
 * connect client's CURRENT `allowedScopes` has DRIFTED from the stored snapshot, and
 * `materialPatchChanges` counts that key as material only when the two masks actually
 * differ. So while they agree, a justification edit is trivial and saves fine here.
 *
 * 🔴 WHEN THEY HAVE DRIFTED, EVERY SAVE IS REFUSED — including a tagline-only one, because
 * the drifted mask rides along on the patch. Leaving the justification boxes live in that
 * state is the same defect as the material inputs, one field further out, so they are
 * disabled and the reason says so. Detectable client-side because both masks are on the
 * edit context; absent values read as `0` exactly as the server's `?? 0` does.
 */
export function scopeDisclosureLockedForEdit(
  ctx: Pick<
    ListingEditContext,
    'status' | 'kind' | 'connectClientId' | 'connectAllowedScopes' | 'connectRequestedScopes'
  >
): boolean {
  // 🔴 `isUnpublishedEdit`, NOT `materialEditBlockedReason` — AND THE TWO ARE EQUIVALENT
  // HERE BY CONSTRUCTION, so this is not a weakening. `materialEditBlockedReason` returns
  // non-null IFF `isUnpublishedEdit(ctx)` is true; its first line IS that check. This used
  // to call it and read the result for null, which was fine until
  // `materialEditBlockedReason` grew a scope-drift arm that calls THIS function — a cycle
  // (`materialEditBlockedReason` → `scopeDisclosureLockedForEdit` → `materialEditBlocked-
  // Reason` → …). Depending on the narrower predicate breaks it and states the real
  // precondition directly: the lock applies in the unpublished state.
  if (!isUnpublishedEdit(ctx)) return false;
  if (ctx.connectClientId == null) return false;
  return (ctx.connectAllowedScopes ?? 0) !== (ctx.connectRequestedScopes ?? 0);
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
    sourceRepoUrl: s.sourceRepoUrl ?? '',
    isBeta: s.isBeta === true,
    // 🔴 `s.isBeta === true &&`, not just `?? ''`. A row can carry a stale note from an
    // author who turned beta OFF (the server clears the note only on the next write), and
    // prefilling it would silently re-publish that note the moment they tick the box again.
    // The server projections apply the same rule; this mirrors it so the form's baseline
    // and the wire value agree — otherwise `buildScalarPatch` would diff against a note the
    // author cannot see and emit a spurious clear.
    betaMessage: s.isBeta === true ? s.betaMessage ?? '' : '',
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

/**
 * Is this edit context an ON-SITE listing? PURE.
 *
 * 🔴 WHY THIS PREDICATE EXISTS AT ALL. This form is the off-site submit wizard in edit
 * mode, and until the canonical authoring page defaulted to its DETAILS tab, an on-site
 * owner never reached it — the block-keyed editor opened on the manifest tab. Changing
 * the default changed the POPULATION, not the form, and the form is not kind-aware: it
 * offers an "App URL" step and an OAuth-scope disclosure that mean nothing for a listing
 * whose CTA is its own hosted page.
 *
 * 🔴 FAIL-SAFE DEFAULT: anything that is not the literal `'onsite'` — including an absent
 * kind — reads as off-site, i.e. as today's behaviour. The narrowing only ever applies to
 * a context that positively declares itself on-site, so it cannot silently strip the URL
 * field from the listings that need it.
 */
export function isOnsiteEdit(ctx: Pick<ListingEditContext, 'kind'>): boolean {
  return ctx.kind === 'onsite';
}

/**
 * The edit form's HEADER copy, by kind. PURE.
 *
 * 🔴 THIS FINISHES A PATTERN THAT WAS ALREADY HERE, it does not start one. The wizard
 * SHAPE went kind-aware — an on-site listing gets no App URL step and no scope
 * disclosure, and `buildScalarPatch` refuses to emit `externalUrl` for it — but the
 * header alert was left behind, hardcoded to the off-site case. So the canonical editor
 * for an ON-SITE listing rendered an external-link icon over the sentence "Update your
 * external-link app. Change the link, details, or assets…", about an app that has no
 * link and no external anything. Observed in production, not inferred.
 *
 * 🔴 KEYED ON THE SAME BOOLEAN THE WIZARD SHAPE USES (`showUrlStep`, i.e.
 * `!isOnsiteEdit(edit)`), deliberately, rather than taking its own look at `ctx.kind`. A
 * second kind check is a second thing to get wrong: the header could then promise a step
 * the wizard does not render, which is the exact class of defect this is fixing. One
 * predicate decides whether the URL step exists AND whether the header may mention a
 * link, so the two cannot disagree.
 *
 * The fail-safe default rides along for free: `isOnsiteEdit` reads an absent kind as
 * off-site, so a context that predates the field keeps today's copy verbatim.
 *
 * The `testId` is what makes this assertable as STATE rather than as a substring — the
 * two branches render DIFFERENT elements, so a test can pin which one exists instead of
 * grepping the page for a word that some other feature might also spell.
 */
export type ListingEditHeaderCopy = {
  kind: 'onsite' | 'offsite';
  testId: string;
  blurb: string;
};

export function listingEditHeaderCopy(showUrlStep: boolean): ListingEditHeaderCopy {
  return showUrlStep
    ? {
        kind: 'offsite',
        testId: 'apps-listing-edit-header-offsite',
        // UNCHANGED, character for character — an off-site listing really does have a
        // link, and the URL step really is one of "the steps below".
        blurb:
          'Update your external-link app. Change the link, details, or assets across the ' +
          'steps below, then save.',
      }
    : {
        kind: 'onsite',
        testId: 'apps-listing-edit-header-onsite',
        // 🔴 MUST NOT SAY "the link". An on-site listing has no external URL, and the
        // wizard renders it no step that could change one.
        blurb:
          'Update your app’s listing. Change the details or assets across the steps below, ' +
          'then save.',
      };
}

/** True iff two string→string maps have identical keys + values. PURE. */
function shallowEqualStringMap(a: Record<string, string>, b: Record<string, string>): boolean {
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

  // 🔴 NEVER patch `externalUrl` on an ON-SITE listing. Its CTA is its hosted page; an
  // external URL is not a field it has, and the edit form must not be able to write one
  // through a step it should not even be showing.
  if (!isOnsiteEdit(ctx)) {
    const url = current.externalUrl.trim();
    if (url !== original.externalUrl.trim()) patch.externalUrl = url;
  }

  // Source repository. Emitted ONLY when the author actually changed the text, which
  // is what keeps the column out of every unrelated patch — load-bearing while the
  // manual-apply migration is outstanding, since a write naming a missing column would
  // fail the whole save. Cleared with an explicit `null`, like tagline/description.
  //
  // 🔴 A RAW STRING COMPARISON IS CORRECT HERE, and only because the server does the
  // canonical one. This diff answers "did the author retype the box?"; whether the two
  // values MEAN the same repository is `patchHasMaterialChange`'s question, and it
  // compares normalised forms. So re-saving `.../a/b` as `.../a/b/` does send a patch,
  // and the server correctly classifies it as no material change — an in-place no-op
  // write rather than a needless mod re-review.
  const sourceRepoUrl = current.sourceRepoUrl.trim();
  const originalSourceRepoUrl = original.sourceRepoUrl.trim();
  if (sourceRepoUrl !== originalSourceRepoUrl) {
    patch.sourceRepoUrl = sourceRepoUrl.length > 0 ? sourceRepoUrl : null;
  }

  // Beta status + note. Emitted ONLY when the author actually changed them, which is what
  // keeps the two columns out of every unrelated patch — load-bearing while the manual-apply
  // migration is outstanding, since a write naming a missing column would fail the whole
  // save with a PRECONDITION_FAILED the author did not ask for.
  if (current.isBeta !== original.isBeta) patch.isBeta = current.isBeta;
  const betaMessage = current.betaMessage.trim();
  const originalBetaMessage = original.betaMessage.trim();
  if (betaMessage !== originalBetaMessage) {
    patch.betaMessage = betaMessage.length > 0 ? betaMessage : null;
  }

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
