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
 * Pure + separately unit-tested — the drift verdict must be checkable without
 * mounting the review page (same reasoning as `offsiteReviewChecklist`).
 */

/** How one single-valued asset slot (icon / cover) differs between live and proposed. */
export type AssetSlotDrift = 'same' | 'changed' | 'added' | 'removed';

/** The comparable asset state of ONE listing (live parent or shadow revision). */
export type ListingAssetSnapshot = {
  iconId: number | null;
  coverId: number | null;
  /** Backing `Image` ids of the screenshots, in `order`. Rows with a deleted Image
   *  (`imageId → null` via `onDelete: SetNull`) are excluded — they display nothing,
   *  so counting them would make a "destructive replace" read as a partial one. */
  screenshotImageIds: number[];
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
  /** True when approving this revision changes ANY asset on the live listing. */
  hasChanges: boolean;
};

/** The `getListingAssets` view shape this module can read (structurally typed so it
 *  accepts the tRPC result without importing the service). */
export type ListingAssetsLike = {
  iconId: number | null;
  coverId: number | null;
  screenshots: { imageId: number | null; order: number }[];
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
  return {
    iconId: view.iconId ?? null,
    coverId: view.coverId ?? null,
    screenshotImageIds: [...view.screenshots]
      .sort((a, b) => a.order - b.order)
      .map((s) => s.imageId)
      .filter((id): id is number => id != null),
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
 */
export function computeListingRevisionDrift(
  live: ListingAssetSnapshot,
  proposed: ListingAssetSnapshot
): ListingRevisionDrift {
  const addedImageIds = multisetDifference(proposed.screenshotImageIds, live.screenshotImageIds);
  const removedImageIds = multisetDifference(live.screenshotImageIds, proposed.screenshotImageIds);
  const reordered =
    addedImageIds.length === 0 &&
    removedImageIds.length === 0 &&
    live.screenshotImageIds.join(',') !== proposed.screenshotImageIds.join(',');

  const screenshots: ScreenshotDrift = {
    liveCount: live.screenshotImageIds.length,
    proposedCount: proposed.screenshotImageIds.length,
    addedImageIds,
    removedImageIds,
    reordered,
    destructiveReplace:
      live.screenshotImageIds.length > 0 && proposed.screenshotImageIds.length === 0,
  };

  const icon = assetSlotDrift(live.iconId, proposed.iconId);
  const cover = assetSlotDrift(live.coverId, proposed.coverId);

  return {
    icon,
    cover,
    screenshots,
    hasChanges:
      icon !== 'same' ||
      cover !== 'same' ||
      addedImageIds.length > 0 ||
      removedImageIds.length > 0 ||
      reordered,
  };
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
  if (parts.length === 0) return 'unchanged';
  return parts.join(', ');
}
