import { describe, expect, it } from 'vitest';

import {
  assetSlotDrift,
  assetSlotDriftLabel,
  computeListingRevisionDrift,
  driftPanelState,
  identicalAssetsNotice,
  listingAssetSnapshot,
  revisionApplyScope,
  screenshotDriftSummary,
  uncomparedApplyFieldsSentence,
  OFFSITE_UNCOMPARED_APPLY_FIELDS,
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
  const merged = { iconId: 10, coverId: 20, screenshotImageIds: [30, 31], ...overrides };
  return {
    ...merged,
    // Captions default to "none", aligned 1:1 with whatever image set the test chose.
    screenshotCaptions: overrides.screenshotCaptions ?? merged.screenshotImageIds.map(() => null),
  };
}

/** An ONSITE revision — the only kind whose apply set is fully covered by an asset
 *  comparison, and therefore the only kind that may be called a no-op. */
const ONSITE = { applyScope: revisionApplyScope('onsite') };

describe('listingAssetSnapshot', () => {
  it('orders screenshots by `order` and drops rows whose Image was deleted', () => {
    const s = listingAssetSnapshot({
      iconId: 1,
      coverId: 2,
      screenshots: [
        { imageId: 33, order: 2, caption: 'last' },
        { imageId: null, order: 1, caption: 'gone' }, // Image deleted (SetNull) — displays nothing.
        { imageId: 31, order: 0, caption: 'first' },
      ],
    });
    expect(s).toEqual({
      iconId: 1,
      coverId: 2,
      screenshotImageIds: [31, 33],
      // Captions stay aligned with the SURVIVING rows — a deleted-Image row must not
      // shift them, or a caption comparison would report phantom drift.
      screenshotCaptions: ['first', 'last'],
    });
  });

  it('normalises an empty-string caption to null (they render identically)', () => {
    const s = listingAssetSnapshot({
      iconId: null,
      coverId: null,
      screenshots: [{ imageId: 31, order: 0, caption: '' }],
    });
    expect(s!.screenshotCaptions).toEqual([null]);
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
    expect(d.assetsChanged).toBe(false);
  });

  it('a DIFFERENT icon is flagged as drift', () => {
    const d = computeListingRevisionDrift(snap(), snap({ iconId: 999 }));
    expect(d.icon).toBe('changed');
    expect(d.cover).toBe('same');
    expect(d.assetsChanged).toBe(true);
  });

  it('a cover added onto an empty slot reads as `added`, not `changed`', () => {
    const d = computeListingRevisionDrift(snap({ coverId: null }), snap({ coverId: 21 }));
    expect(d.cover).toBe('added');
    expect(d.assetsChanged).toBe(true);
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
    expect(d.assetsChanged).toBe(true);
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
    expect(d.assetsChanged).toBe(false);
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
    expect(d.assetsChanged).toBe(true);
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

  it('a caption-only revision does NOT read as unchanged', () => {
    const d = computeListingRevisionDrift(
      snap({ screenshotImageIds: [30, 31], screenshotCaptions: [null, null] }),
      snap({ screenshotImageIds: [30, 31], screenshotCaptions: [null, 'now with words'] }),
      ONSITE
    );
    expect(screenshotDriftSummary(d.screenshots)).toBe('captions edited');
  });

  it('labels the slot verdicts', () => {
    expect(assetSlotDriftLabel('same')).toBe('unchanged');
    expect(assetSlotDriftLabel('added')).toBe('added');
    expect(assetSlotDriftLabel('removed')).toBe('removed');
    expect(assetSlotDriftLabel('changed')).toBe('replaced');
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE NO-OP CLAIM IS KIND-SCOPED.
//
// `applyApprovedRevision` is kind-aware. The ONSITE branch copies iconId/coverId
// (plus the screenshot reparent) and nothing else, so an asset comparison covers its
// whole apply set. The OFFSITE branch ALSO copies name / tagline / description /
// category / externalUrl / connectClientId / connectRequestedScopes /
// connectScopeJustifications. Reporting "IDENTICAL — approving changes nothing" off
// the asset comparison alone therefore told a moderator that a SCOPE-CHANGING
// off-site revision was a no-op: a false statement in the one surface that exists to
// stop one, and strictly worse than showing no panel at all.
// ---------------------------------------------------------------------------

describe('apply scope — what a "changes nothing" claim is allowed to mean', () => {
  it.each([
    ['onsite', 'assets-only'],
    ['offsite', 'assets-and-scalars'],
    [null, 'assets-and-scalars'],
    [undefined, 'assets-and-scalars'],
    ['something-new', 'assets-and-scalars'],
  ])('kind=%s → %s', (kind, expected) => {
    expect(revisionApplyScope(kind as string | null | undefined)).toBe(expected);
  });

  it('🔴 an ONSITE revision with identical assets IS a no-op — the claim is licensed', () => {
    const d = computeListingRevisionDrift(snap(), snap(), ONSITE);
    expect(d.assetsChanged).toBe(false);
    expect(d.noOpApproval).toBe(true);
    expect(d.uncomparedApplyFields).toEqual([]);
    expect(identicalAssetsNotice(d)).toMatch(/approving changes nothing/);
  });

  it('🔴 an OFFSITE revision with identical assets is NEVER reported as changing nothing', () => {
    // The concrete case: the owner revised ONLY `connectRequestedScopes` (asking for
    // broader OAuth access). Every asset id is byte-identical, so the asset comparison
    // sees nothing — and the approve copies the new scope set onto the LIVE listing.
    const d = computeListingRevisionDrift(snap(), snap(), {
      applyScope: revisionApplyScope('offsite'),
    });
    expect(d.assetsChanged).toBe(false);
    expect(d.noOpApproval).toBe(false);
    const notice = identicalAssetsNotice(d);
    expect(notice).not.toMatch(/changes nothing/);
    // It must NAME the requested OAuth scopes as uncompared, not merely hedge.
    expect(d.uncomparedApplyFields).toContain('requested OAuth scopes');
    expect(notice).toMatch(/requested OAuth scopes/);
    expect(notice).toMatch(/NOT compared here/);
  });

  it('🔴 an UNKNOWN kind fails safe — no no-op claim without knowing the apply set', () => {
    // `kind` is optional on the review row. A missing value must not be read as onsite.
    const d = computeListingRevisionDrift(snap(), snap());
    expect(d.applyScope).toBe('assets-and-scalars');
    expect(d.noOpApproval).toBe(false);
  });

  it('🔴 a CAPTION-only revision is not a no-op on either kind', () => {
    // Captions ride along on the screenshot reparent, so approving DOES change the
    // live listing. Comparing image ids alone reported this as "changes nothing".
    const live = snap({ screenshotImageIds: [30, 31], screenshotCaptions: ['a', 'b'] });
    const proposed = snap({ screenshotImageIds: [30, 31], screenshotCaptions: ['a', 'B!'] });
    const d = computeListingRevisionDrift(live, proposed, ONSITE);
    expect(d.screenshots.captionsChanged).toBe(true);
    expect(d.assetsChanged).toBe(true);
    expect(d.noOpApproval).toBe(false);
  });

  it('an identical caption set is not drift', () => {
    const live = snap({ screenshotImageIds: [30, 31], screenshotCaptions: ['a', null] });
    const proposed = snap({ screenshotImageIds: [30, 31], screenshotCaptions: ['a', null] });
    const d = computeListingRevisionDrift(live, proposed, ONSITE);
    expect(d.screenshots.captionsChanged).toBe(false);
    expect(d.noOpApproval).toBe(true);
  });

  it('a REORDER already reports itself — captionsChanged stays false', () => {
    // captionsChanged is only meaningful when the image sequence is identical; a
    // reorder shifts the caption array with it and must not double-report.
    const live = snap({ screenshotImageIds: [30, 31], screenshotCaptions: ['a', 'b'] });
    const proposed = snap({ screenshotImageIds: [31, 30], screenshotCaptions: ['b', 'a'] });
    const d = computeListingRevisionDrift(live, proposed, ONSITE);
    expect(d.screenshots.reordered).toBe(true);
    expect(d.screenshots.captionsChanged).toBe(false);
    expect(d.assetsChanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE PANEL MUST NOT SPIN FOREVER ON AN ERROR.
//
// Both drift queries run with `retry: false`, so a failure is TERMINAL and `drift`
// stays null. Branching on `drift == null` first left a moderator — sitting right
// next to the destructive-replace case — looking at an indefinite "Comparing with the
// live listing…" spinner, indistinguishable from "loading, no warning yet".
// ---------------------------------------------------------------------------

describe('driftPanelState', () => {
  it('🔴 an error OUTRANKS loading — a failed comparison never renders as a spinner', () => {
    expect(driftPanelState({ hasError: true, drift: null })).toBe('error');
  });

  it('an error wins even if a stale drift is present', () => {
    const d = computeListingRevisionDrift(snap(), snap(), ONSITE);
    expect(driftPanelState({ hasError: true, drift: d })).toBe('error');
  });

  it('no error + not loaded → loading', () => {
    expect(driftPanelState({ hasError: false, drift: null })).toBe('loading');
  });

  it('no error + both sides loaded → ready', () => {
    const d = computeListingRevisionDrift(snap(), snap(), ONSITE);
    expect(driftPanelState({ hasError: false, drift: d })).toBe('ready');
  });
});

describe('uncomparedApplyFieldsSentence', () => {
  it('🔴 names EVERY field an offsite approve copies — no hand-maintained second copy', () => {
    const sentence = uncomparedApplyFieldsSentence();
    // The review header used to hard-code its own list, and it had already drifted:
    // `scope justifications` was missing, so the panel implied the justifications were
    // not part of the apply. Deriving it makes that unrepresentable — this assertion
    // fails the moment a field is added to the constant and the prose is not derived.
    for (const field of OFFSITE_UNCOMPARED_APPLY_FIELDS) {
      expect(sentence).toContain(field);
    }
    expect(sentence).toContain('scope justifications');
  });

  it('reads as a list — the last field is joined with “and”, not a comma', () => {
    expect(uncomparedApplyFieldsSentence(['name', 'tagline', 'link'])).toContain(
      'name, tagline and link'
    );
  });

  it('degrades sanely for a one-field and an empty list', () => {
    expect(uncomparedApplyFieldsSentence(['name'])).toContain('revision’s name onto');
    expect(() => uncomparedApplyFieldsSentence([])).not.toThrow();
  });
});
