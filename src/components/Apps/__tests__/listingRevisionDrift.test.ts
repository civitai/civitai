import { describe, expect, it } from 'vitest';

import {
  assetSlotDrift,
  assetSlotDriftLabel,
  computeListingRevisionDrift,
  listingAssetSnapshot,
  screenshotDriftSummary,
  type ListingAssetSnapshot,
} from '~/components/Apps/listingRevisionDrift';

/**
 * Listing-media revision DRIFT — the review surface's before/after verdict.
 *
 * 🔴 WHY. A mod reviewing a media revision saw the SHADOW's assets alone (both review
 * queries key on `request.appListingId`, which IS the shadow id), so a revision that
 * silently reverts or DELETES live media was indistinguishable from one that improves
 * it. `applyApprovedRevision` copies icon/cover unconditionally and does a destructive
 * FULL REPLACE of the screenshot set, so "approve" on a 0-screenshot revision deletes
 * every live screenshot — and the reachable path needs nobody to do anything unusual
 * (the mod-only `backfillListingAssets` adds screenshots to a parent; screenshots
 * aren't in the publish floor, so the owner can submit a revision without them).
 */

function snap(overrides: Partial<ListingAssetSnapshot> = {}): ListingAssetSnapshot {
  return { iconId: 10, coverId: 20, screenshotImageIds: [30, 31], ...overrides };
}

describe('listingAssetSnapshot', () => {
  it('orders screenshots by `order` and drops rows whose Image was deleted', () => {
    const s = listingAssetSnapshot({
      iconId: 1,
      coverId: 2,
      screenshots: [
        { imageId: 33, order: 2 },
        { imageId: null, order: 1 }, // Image deleted (onDelete: SetNull) — displays nothing.
        { imageId: 31, order: 0 },
      ],
    });
    expect(s).toEqual({ iconId: 1, coverId: 2, screenshotImageIds: [31, 33] });
  });

  it('🔴 returns null for an UNLOADED payload — "not loaded" must not read as "empty"', () => {
    // Treating a still-loading parent as empty would flag EVERY revision as a
    // destructive replace: the exact warning-fatigue failure that makes a drift
    // signal worthless.
    expect(listingAssetSnapshot(undefined)).toBeNull();
    expect(listingAssetSnapshot(null)).toBeNull();
  });
});

describe('assetSlotDrift', () => {
  it.each([
    [null, null, 'same'],
    [10, 10, 'same'],
    [null, 10, 'added'],
    [10, null, 'removed'],
    [10, 11, 'changed'],
  ])('live=%s proposed=%s → %s', (live, proposed, expected) => {
    expect(assetSlotDrift(live as number | null, proposed as number | null)).toBe(expected);
  });
});

describe('computeListingRevisionDrift', () => {
  it('shadow == parent → NO drift at all', () => {
    const d = computeListingRevisionDrift(snap(), snap());
    expect(d.icon).toBe('same');
    expect(d.cover).toBe('same');
    expect(d.screenshots).toMatchObject({
      addedImageIds: [],
      removedImageIds: [],
      reordered: false,
      destructiveReplace: false,
    });
    expect(d.hasChanges).toBe(false);
  });

  it('a DIFFERENT icon is flagged as drift', () => {
    const d = computeListingRevisionDrift(snap(), snap({ iconId: 999 }));
    expect(d.icon).toBe('changed');
    expect(d.cover).toBe('same');
    expect(d.hasChanges).toBe(true);
  });

  it('a cover added onto an empty slot reads as `added`, not `changed`', () => {
    const d = computeListingRevisionDrift(snap({ coverId: null }), snap({ coverId: 21 }));
    expect(d.cover).toBe('added');
    expect(d.hasChanges).toBe(true);
  });

  it('🔴 parent has N screenshots and the revision has 0 → DESTRUCTIVE replace', () => {
    const d = computeListingRevisionDrift(
      snap({ screenshotImageIds: [30, 31, 32] }),
      snap({ screenshotImageIds: [] })
    );
    // Approving runs `deleteMany({ appListingId: parentId })` and moves nothing back:
    // all three live screenshots are gone, and today the mod sees no sign of it.
    expect(d.screenshots.destructiveReplace).toBe(true);
    expect(d.screenshots.liveCount).toBe(3);
    expect(d.screenshots.proposedCount).toBe(0);
    expect(d.screenshots.removedImageIds).toEqual([30, 31, 32]);
    expect(d.hasChanges).toBe(true);
  });

  it('a revision that ADDS screenshots to an empty parent is NOT destructive', () => {
    const d = computeListingRevisionDrift(
      snap({ screenshotImageIds: [] }),
      snap({ screenshotImageIds: [40] })
    );
    expect(d.screenshots.destructiveReplace).toBe(false);
    expect(d.screenshots.addedImageIds).toEqual([40]);
    expect(d.screenshots.removedImageIds).toEqual([]);
  });

  it('both sides empty is not destructive (nothing to lose)', () => {
    const d = computeListingRevisionDrift(
      snap({ screenshotImageIds: [] }),
      snap({ screenshotImageIds: [] })
    );
    expect(d.screenshots.destructiveReplace).toBe(false);
    expect(d.hasChanges).toBe(false);
  });

  it('reports a partial screenshot swap as added + removed', () => {
    const d = computeListingRevisionDrift(
      snap({ screenshotImageIds: [30, 31] }),
      snap({ screenshotImageIds: [31, 32] })
    );
    expect(d.screenshots.addedImageIds).toEqual([32]);
    expect(d.screenshots.removedImageIds).toEqual([30]);
    expect(d.screenshots.reordered).toBe(false);
  });

  it('detects a pure REORDER (same set, different sequence)', () => {
    const d = computeListingRevisionDrift(
      snap({ screenshotImageIds: [30, 31, 32] }),
      snap({ screenshotImageIds: [32, 30, 31] })
    );
    expect(d.screenshots.reordered).toBe(true);
    expect(d.screenshots.addedImageIds).toEqual([]);
    expect(d.screenshots.removedImageIds).toEqual([]);
    expect(d.hasChanges).toBe(true);
  });

  it('counts DUPLICATE images as a multiset (removing one of two is one removal)', () => {
    const d = computeListingRevisionDrift(
      snap({ screenshotImageIds: [30, 30] }),
      snap({ screenshotImageIds: [30] })
    );
    expect(d.screenshots.removedImageIds).toEqual([30]);
    expect(d.screenshots.addedImageIds).toEqual([]);
    expect(d.screenshots.destructiveReplace).toBe(false);
  });
});

describe('summaries', () => {
  it('the destructive case says so in words, with the count', () => {
    const d = computeListingRevisionDrift(
      snap({ screenshotImageIds: [30, 31] }),
      snap({ screenshotImageIds: [] })
    );
    expect(screenshotDriftSummary(d.screenshots)).toMatch(/all 2 live screenshots will be DELETED/);
  });

  it('singularises a one-screenshot destructive replace', () => {
    const d = computeListingRevisionDrift(
      snap({ screenshotImageIds: [30] }),
      snap({ screenshotImageIds: [] })
    );
    expect(screenshotDriftSummary(d.screenshots)).toMatch(/all 1 live screenshot will be DELETED/);
  });

  it('an ordinary change reads plainly', () => {
    const d = computeListingRevisionDrift(
      snap({ screenshotImageIds: [30] }),
      snap({ screenshotImageIds: [30, 31] })
    );
    expect(screenshotDriftSummary(d.screenshots)).toBe('1 added');
    expect(screenshotDriftSummary(computeListingRevisionDrift(snap(), snap()).screenshots)).toBe(
      'unchanged'
    );
  });

  it('labels the slot verdicts', () => {
    expect(assetSlotDriftLabel('same')).toBe('unchanged');
    expect(assetSlotDriftLabel('added')).toBe('added');
    expect(assetSlotDriftLabel('removed')).toBe('removed');
    expect(assetSlotDriftLabel('changed')).toBe('replaced');
  });
});
