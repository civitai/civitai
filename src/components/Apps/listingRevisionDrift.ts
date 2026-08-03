/**
 * App Store Listings — listing-media REVISION DRIFT (PURE view-model).
 *
 * A moderator reviewing a listing-media revision was shown the SHADOW's assets and
 * nothing else. Both review queries key on `request.appListingId`, which IS the
 * shadow id, so the modal rendered "an icon" — never "the icon is going backwards".
 * There was no parent fetch anywhere in the review surface, so "a mod would catch a
 * silent revert" was simply false.
 *
 * That matters because `applyApprovedRevision` is unconditional in both directions:
 * it copies the shadow's `iconId`/`coverId` over the parent's, and for screenshots it
 * does a DESTRUCTIVE FULL REPLACE — `deleteMany({ appListingId: parentId })` and then
 * moves the shadow's rows across. So a revision that carries zero screenshots DELETES
 * every screenshot the live listing has, and nothing in the flow says so out loud.
 * The reachable path needs no unusual behaviour from anyone: the moderator-only
 * `backfillListingAssets` migrates bundle screenshots onto a parent that has none,
 * screenshots are NOT in the publish floor, so an owner can submit a 0-screenshot
 * revision and the approve wipes them.
 *
 * This module computes what CHANGES between the live listing and the proposed
 * revision, so the review surface can show a before/after instead of an after.
 *
 * 🔴 IT COMPARES ASSETS, AND SAYS SO. `applyApprovedRevision` is KIND-AWARE: the
 * onsite branch copies icon/cover (+ the screenshot reparent) and nothing else, so an
 * asset comparison covers its whole apply set. The OFFSITE branch ALSO copies
 * `name`/`tagline`/`description`/`category`/`externalUrl`/`connectClientId`/
 * `connectRequestedScopes`/`connectScopeJustifications`. Reporting "identical —
 * approving changes nothing" off an asset comparison alone therefore told a moderator
 * that a SCOPE-CHANGING off-site revision was a no-op — a false statement in the exact
 * safety surface this panel exists to provide, worse than showing nothing. Hence
 * {@link RevisionApplyScope}: `noOpApproval` (the only field that licenses that claim)
 * can only be true when the compared set IS the apply set.
 *
 * Pure + separately unit-tested — the drift verdict must be checkable without
 * mounting the review page (same reasoning as `offsiteReviewChecklist`).
 */

/** How one single-valued asset slot (icon / cover) differs between live and proposed. */
export type AssetSlotDrift = 'same' | 'changed' | 'added' | 'removed';

/**
 * What `applyApprovedRevision` COPIES from the shadow onto the live parent, which is
 * KIND-DEPENDENT (`offsite-listing.service.ts`, the `parent.kind === 'onsite'` branch):
 *
 *   - `'assets-only'`   — ONSITE. Copies `iconId`/`coverId` only (+ the screenshot
 *     reparent). Every manifest-governed scalar is deliberately left alone, so the
 *     asset comparison below covers the WHOLE apply set.
 *   - `'assets-and-scalars'` — OFFSITE. ALSO copies `name`, `tagline`, `description`,
 *     `category`, `externalUrl`, `connectClientId`, **`connectRequestedScopes`** and
 *     `connectScopeJustifications`. The asset comparison covers only PART of the
 *     apply set.
 */
export type RevisionApplyScope = 'assets-only' | 'assets-and-scalars';

/**
 * The listing fields an OFFSITE approve copies that this module does NOT compare.
 *
 * 🔴 WHY NOT COMPARE THEM. Both sides' `name` / `tagline` / `description` /
 * `category` / `externalUrl` are reachable from the two `getListingPreviewForReview`
 * projections, but `connectRequestedScopes` / `connectScopeJustifications` are NOT
 * exposed for the PARENT by any mod-gated read — the only projection that carries
 * them is the OWNER's `getMyListingForEdit`. Surfacing them would mean widening the
 * PUBLIC `ListingDetail` DTO (served by `getAppDetail`) to carry OAuth-scope data, a
 * far larger blast radius than a review panel warrants.
 *
 * And a PARTIAL scalar comparison would not fix the problem — it would only move the
 * lie: "identical" while the requested OAuth scopes changed underneath is exactly the
 * failure this list exists to prevent. So the honest contract is: compare the assets,
 * and NAME the fields that were not compared instead of implying they were.
 */
export const OFFSITE_UNCOMPARED_APPLY_FIELDS = [
  'name',
  'tagline',
  'description',
  'category',
  'link',
  'requested OAuth scopes',
  'scope justifications',
] as const;

/**
 * The review panel's HEADER sentence naming what an offsite approve also copies.
 *
 * 🔴 DERIVED from {@link OFFSITE_UNCOMPARED_APPLY_FIELDS} rather than written out.
 * The header used to hard-code its own copy of the list, which had already drifted:
 * it omitted `scope justifications`. A moderator reading "name, tagline, description,
 * category, link and requested OAuth scopes" would conclude the justifications were
 * NOT part of the apply — in the one surface whose whole job is to not imply that.
 * Single-sourcing it makes the drift unrepresentable instead of merely fixed.
 */
export function uncomparedApplyFieldsSentence(
  fields: readonly string[] = OFFSITE_UNCOMPARED_APPLY_FIELDS
): string {
  const last = fields[fields.length - 1] ?? '';
  const list = fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${last}` : last;
  return ` Approving ALSO copies this revision’s ${list} onto the live listing; those are not compared here.`;
}

/**
 * The apply scope for a review row's listing kind.
 *
 * 🔴 UNKNOWN kind → `'assets-and-scalars'`, the CONSERVATIVE answer. `kind` is
 * optional on the review row (`listPendingRequests` defaults it to off-site), and a
 * missing value must never license a "changes nothing" claim.
 */
export function revisionApplyScope(kind: string | null | undefined): RevisionApplyScope {
  return kind === 'onsite' ? 'assets-only' : 'assets-and-scalars';
}

/** The comparable asset state of ONE listing (live parent or shadow revision). */
export type ListingAssetSnapshot = {
  iconId: number | null;
  coverId: number | null;
  /** Backing `Image` ids of the screenshots, in `order`. Rows with a deleted Image
   *  (`imageId → null` via `onDelete: SetNull`) are excluded — they display nothing,
   *  so counting them would make a "destructive replace" read as a partial one. */
  screenshotImageIds: number[];
  /**
   * Captions aligned 1:1 with {@link screenshotImageIds} (same filter, same order).
   * A caption is part of what the screenshot reparent carries onto the live listing,
   * so a caption-ONLY revision is a real change — without this it read as "identical
   * — approving changes nothing". Empty string is normalised to `null` (they render
   * the same, so flipping between them is not a change).
   */
  screenshotCaptions: (string | null)[];
};

export type ScreenshotDrift = {
  liveCount: number;
  proposedCount: number;
  /** Images the revision ADDS (present in proposed, not in live). */
  addedImageIds: number[];
  /** Images the revision DROPS (present in live, not in proposed) — these rows are
   *  DELETED from the live listing on approve. */
  removedImageIds: number[];
  /** Same set of images, different order. */
  reordered: boolean;
  /**
   * Same images in the same order, but at least one CAPTION differs. Captions ride
   * along on the reparent, so this is a real change to the live listing — and it is
   * the one screenshot change that is invisible in every other field here.
   * Only meaningful when the image sequence is identical; any add / remove / reorder
   * already reports itself and sets `assetsChanged`.
   */
  captionsChanged: boolean;
  /**
   * 🔴 The live listing has screenshots and the revision has NONE. Approving deletes
   * all of them and puts nothing back. Called out separately from `removedImageIds`
   * because it is the total-loss case and it can be reached without anyone
   * deliberately removing anything (a shadow cloned BEFORE a backfill added them).
   */
  destructiveReplace: boolean;
};

export type ListingRevisionDrift = {
  icon: AssetSlotDrift;
  cover: AssetSlotDrift;
  screenshots: ScreenshotDrift;
  /**
   * True when approving this revision changes any asset COMPARED HERE (icon, cover,
   * screenshot set / order / captions).
   *
   * 🔴 `assetsChanged === false` does NOT mean "approving changes nothing" — see
   * {@link noOpApproval}. It was called `hasChanges` and read as exactly that, which
   * is how an off-site revision that changed only `connectRequestedScopes` was
   * reported to a moderator as a no-op.
   */
  assetsChanged: boolean;
  /** What `applyApprovedRevision` will copy for this revision's kind. */
  applyScope: RevisionApplyScope;
  /** Fields the apply copies that this comparison did NOT read (empty for onsite). */
  uncomparedApplyFields: readonly string[];
  /**
   * 🔴 The ONLY field that licenses an "approving changes nothing" statement: every
   * field the apply copies for this kind was compared AND is identical. Necessarily
   * `false` for an off-site revision, whose apply also copies the listing scalars
   * (including the requested OAuth scopes) that this module cannot see.
   */
  noOpApproval: boolean;
};

/** The `getListingAssets` view shape this module can read (structurally typed so it
 *  accepts the tRPC result without importing the service). */
export type ListingAssetsLike = {
  iconId: number | null;
  coverId: number | null;
  screenshots: { imageId: number | null; order: number; caption?: string | null }[];
};

/**
 * Normalise a `getListingAssets` payload into a comparable snapshot. Returns `null`
 * for a missing payload so callers can distinguish "not loaded yet" from "no assets"
 * — reporting an unloaded parent as empty would flag every revision as a destructive
 * replace, which is precisely the warning-fatigue failure this must avoid.
 */
export function listingAssetSnapshot(
  view: ListingAssetsLike | null | undefined
): ListingAssetSnapshot | null {
  if (!view) return null;
  const rows = [...view.screenshots]
    .sort((a, b) => a.order - b.order)
    .filter(
      (s): s is { imageId: number; order: number; caption?: string | null } => s.imageId != null
    );
  return {
    iconId: view.iconId ?? null,
    coverId: view.coverId ?? null,
    screenshotImageIds: rows.map((s) => s.imageId),
    // '' and null render identically — normalise so flipping between them is not a
    // reported change.
    screenshotCaptions: rows.map((s) => (s.caption == null || s.caption === '' ? null : s.caption)),
  };
}

/** Slot-level comparison: null↔null is `same`, null→value is `added`, value→null is
 *  `removed`, and a different non-null value is `changed`. */
export function assetSlotDrift(live: number | null, proposed: number | null): AssetSlotDrift {
  if (live === proposed) return 'same';
  if (live == null) return 'added';
  if (proposed == null) return 'removed';
  return 'changed';
}

/** Multiset difference `a \ b` preserving `a`'s order (an image attached twice is two
 *  entries, so removing one of them reports exactly one removal). */
function multisetDifference(a: number[], b: number[]): number[] {
  const remaining = [...b];
  const out: number[] = [];
  for (const id of a) {
    const i = remaining.indexOf(id);
    if (i >= 0) remaining.splice(i, 1);
    else out.push(id);
  }
  return out;
}

/**
 * Compare the LIVE listing's current assets against the revision's proposed assets.
 *
 * The comparison is deliberately "what will approving this CHANGE on the live
 * listing", not "did the parent move since the shadow was cloned". Distinguishing
 * those two needs a clone-time baseline, which needs a schema migration; this is the
 * decision-useful half a moderator actually needs and it costs nothing. An ordinary
 * icon swap therefore reads as `changed` — informative, not alarming — while the
 * total-loss case gets its own flag.
 *
 * 🔴 `applyScope` decides whether a "changes nothing" claim is even ALLOWED. It
 * defaults to the conservative `'assets-and-scalars'`: a caller that does not thread
 * the listing kind gets `noOpApproval === false`, never a false all-clear.
 */
export function computeListingRevisionDrift(
  live: ListingAssetSnapshot,
  proposed: ListingAssetSnapshot,
  opts: { applyScope?: RevisionApplyScope } = {}
): ListingRevisionDrift {
  const applyScope = opts.applyScope ?? 'assets-and-scalars';
  const addedImageIds = multisetDifference(proposed.screenshotImageIds, live.screenshotImageIds);
  const removedImageIds = multisetDifference(live.screenshotImageIds, proposed.screenshotImageIds);
  const sameSequence = live.screenshotImageIds.join(',') === proposed.screenshotImageIds.join(',');
  const reordered = addedImageIds.length === 0 && removedImageIds.length === 0 && !sameSequence;
  const captionsChanged =
    sameSequence &&
    JSON.stringify(live.screenshotCaptions) !== JSON.stringify(proposed.screenshotCaptions);

  const screenshots: ScreenshotDrift = {
    liveCount: live.screenshotImageIds.length,
    proposedCount: proposed.screenshotImageIds.length,
    addedImageIds,
    removedImageIds,
    reordered,
    captionsChanged,
    destructiveReplace:
      live.screenshotImageIds.length > 0 && proposed.screenshotImageIds.length === 0,
  };

  const icon = assetSlotDrift(live.iconId, proposed.iconId);
  const cover = assetSlotDrift(live.coverId, proposed.coverId);

  const assetsChanged =
    icon !== 'same' ||
    cover !== 'same' ||
    addedImageIds.length > 0 ||
    removedImageIds.length > 0 ||
    reordered ||
    captionsChanged;

  return {
    icon,
    cover,
    screenshots,
    assetsChanged,
    applyScope,
    uncomparedApplyFields: applyScope === 'assets-only' ? [] : OFFSITE_UNCOMPARED_APPLY_FIELDS,
    noOpApproval: !assetsChanged && applyScope === 'assets-only',
  };
}

/**
 * What the drift panel should RENDER. Pure so the one rule that matters is pinned in
 * the blocking unit project rather than left to a browser test.
 *
 * 🔴 `'error'` OUTRANKS `'loading'`. Both queries run with `retry: false`, so a failure
 * is TERMINAL — `drift` stays `null` forever. Branching on `drift == null` first left a
 * moderator staring at an indefinite "Comparing with the live listing…" spinner right
 * next to the destructive-replace case: indistinguishable from "still loading, no
 * warning yet", when the truth is "the live listing could not be read at all".
 */
export type DriftPanelState = 'error' | 'loading' | 'ready';

export function driftPanelState(args: {
  hasError: boolean;
  drift: ListingRevisionDrift | null;
}): DriftPanelState {
  if (args.hasError) return 'error';
  return args.drift == null ? 'loading' : 'ready';
}

/** Human label for a slot verdict (shared by the badge + its tests). */
export function assetSlotDriftLabel(drift: AssetSlotDrift): string {
  switch (drift) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'changed':
      return 'replaced';
    default:
      return 'unchanged';
  }
}

/** One-line summary of the screenshot change, for the review surface. */
export function screenshotDriftSummary(drift: ScreenshotDrift): string {
  if (drift.destructiveReplace) {
    return `all ${drift.liveCount} live screenshot${
      drift.liveCount === 1 ? '' : 's'
    } will be DELETED — this revision has none`;
  }
  const parts: string[] = [];
  if (drift.addedImageIds.length > 0) parts.push(`${drift.addedImageIds.length} added`);
  if (drift.removedImageIds.length > 0) parts.push(`${drift.removedImageIds.length} removed`);
  if (parts.length === 0 && drift.reordered) parts.push('reordered');
  // Captions ride along on the reparent; a caption-only revision has nothing else to
  // report, so without this it reads as 'unchanged'.
  if (drift.captionsChanged) parts.push('captions edited');
  if (parts.length === 0) return 'unchanged';
  return parts.join(', ');
}

/**
 * The honest one-liner for "the media is identical" — kind-aware.
 *
 * 🔴 For an OFFSITE revision the media being identical says nothing about what
 * approving does: the apply also copies the listing scalars, including
 * `connectRequestedScopes`. Stating "approving changes nothing" there is a FALSE
 * statement in the one surface that exists to prevent one.
 */
export function identicalAssetsNotice(drift: ListingRevisionDrift): string {
  if (drift.noOpApproval) {
    return 'This revision’s media is IDENTICAL to what is live — approving changes nothing.';
  }
  return `This revision’s MEDIA is identical to what is live. Approving still copies this revision’s ${drift.uncomparedApplyFields.join(
    ', '
  )} onto the live listing — those are NOT compared here, so review them above before approving.`;
}
