import { describe, expect, it } from 'vitest';

import {
  DETAIL_SURFACE_MOD_ACTIONS,
  appListingDetailModActions,
  detailListingStatus,
  detailModActionLabel,
  unpublishConsequenceCopy,
} from '~/components/Apps/appListingDetailModActions';
import {
  ALL_LISTING_MOD_ACTIONS,
  listingModActions,
} from '~/components/Apps/appListingModerationTableView';

/**
 * The moderator action set for the store listing DETAIL body's `⋮` menu.
 *
 * BLOCKING tier (node `unit`) — `AppListingDetailBody.browser.test.tsx` is report-only,
 * so the correctness of the derivation lives here and only the DOM wiring lives there.
 */

const KINDS = ['onsite', 'offsite'] as const;

describe('detailListingStatus — what this surface can honestly claim', () => {
  it('the live arm is approved by construction (the read is approved-only)', () => {
    expect(detailListingStatus({ preview: false })).toBe('approved');
  });

  it('preview claims NO status — the shadow/fallback detail is not approved', () => {
    expect(detailListingStatus({ preview: true })).toBeNull();
  });
});

describe('appListingDetailModActions', () => {
  for (const kind of KINDS) {
    it(`a moderator on a live ${kind} listing gets Contact owner + Unpublish, in that order`, () => {
      expect(appListingDetailModActions({ isModerator: true, preview: false, kind })).toEqual([
        'message-owner',
        'reset-to-pending',
      ]);
    });

    it(`a NON-moderator on a live ${kind} listing gets nothing`, () => {
      // The negative arm is the point of the gate. Its positive control is the case
      // directly above: same kind, same posture, moderator true → a NON-empty set.
      expect(appListingDetailModActions({ isModerator: false, preview: false, kind })).toEqual([]);
    });

    it(`a moderator in PREVIEW on a ${kind} listing gets nothing`, () => {
      // `detail.id` in preview can be a publish-REQUEST id (the fallback builder sets
      // `id: row.appListingId ?? row.id`), so every proc keyed on it could NOT_FOUND.
      expect(appListingDetailModActions({ isModerator: true, preview: true, kind })).toEqual([]);
    });
  }

  /**
   * 🔴 THE SEAM. This module does not decide which actions an approved listing admits —
   * `listingModActions` does, and the mgmt table depends on the same answer. The property
   * that must hold is a RELATIONSHIP: what this surface renders is exactly the part of
   * that answer it has implemented, never more.
   *
   * Asserted as a subset relation rather than by restating the expected list, so a change
   * to the shared state machine cannot leave this file agreeing with a stale copy of it.
   */
  it('is exactly the intersection of the shared state machine with this surface subset', () => {
    for (const kind of KINDS) {
      const admitted = listingModActions({ status: 'approved', kind, hasPendingRequest: false });
      const rendered = appListingDetailModActions({ isModerator: true, preview: false, kind });
      // Positive control on both sides: neither set is empty, so the comparison below is
      // a real one and not two empty arrays agreeing.
      expect(admitted.length).toBeGreaterThan(0);
      expect(rendered.length).toBeGreaterThan(0);
      expect(rendered).toEqual(
        admitted.filter((a) => (DETAIL_SURFACE_MOD_ACTIONS as readonly string[]).includes(a))
      );
      // And nothing the state machine does NOT admit can appear.
      for (const action of rendered) expect(admitted).toContain(action);
    }
  });

  /**
   * 🔴 `relist` IS UNREACHABLE FROM THIS SURFACE, and that is the design answer this
   * module exists to record — not an omission somebody should "fix" by adding a button.
   *
   * It acts on a `removed` listing; `getAppDetail` is approved-only, so a removed listing
   * 404s before this body mounts. The check is on the STATE (the action is absent from
   * every set this function can produce), not on the word appearing in a menu.
   */
  it('never offers relist, in any combination of inputs it can be called with', () => {
    for (const kind of KINDS) {
      for (const isModerator of [true, false]) {
        for (const preview of [true, false]) {
          expect(appListingDetailModActions({ isModerator, preview, kind })).not.toContain(
            'relist'
          );
        }
      }
    }
    // Positive control on the assertion's reachability: `relist` IS a real member of the
    // vocabulary and IS offered by the shared state machine for a removed listing, so the
    // absence above is a fact about this surface rather than about a dead identifier.
    expect(ALL_LISTING_MOD_ACTIONS).toContain('relist');
    expect(
      listingModActions({ status: 'removed', kind: 'offsite', hasPendingRequest: false })
    ).toContain('relist');
  });

  it('never offers an action outside the declared surface subset', () => {
    for (const kind of KINDS) {
      for (const action of appListingDetailModActions({ isModerator: true, preview: false, kind })) {
        expect(DETAIL_SURFACE_MOD_ACTIONS).toContain(action);
      }
    }
  });
});

describe('detailModActionLabel', () => {
  it('every member of the surface subset has a label, and they are distinct', () => {
    const labels = DETAIL_SURFACE_MOD_ACTIONS.map(detailModActionLabel);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('the unpublish label names BOTH halves of what the proc does', () => {
    // The action takes the app off the store AND re-queues it for review. A label that
    // says only one of those misdescribes it, in one direction or the other.
    const label = detailModActionLabel('reset-to-pending');
    expect(label).toContain('Unpublish');
    expect(label.toLowerCase()).toContain('review');
  });
});

describe('unpublishConsequenceCopy', () => {
  /**
   * 🔴 THE WHOLE NORMALISED STRING, per kind, because this is a claim about what the
   * platform is about to do to somebody's live app — and a guard on WORDS is walkable by
   * rewording. A deliberate copy change fails this and is meant to: updating a
   * machine-readable pin is the cheap half of changing a statement of consequences.
   */
  it('the on-site copy is exactly this sentence — it names the runtime stop', () => {
    expect(unpublishConsequenceCopy('onsite')).toBe(
      'The app stops serving immediately and its listing leaves the store. A fresh review ' +
        'request is queued with the current version — the owner does not resubmit anything — ' +
        'and they are notified, with the reason you give below. It goes back up when a ' +
        'moderator approves that request; it cannot be restored from this page.'
    );
  });

  it('the off-site copy is exactly this sentence — it claims NO runtime stop', () => {
    expect(unpublishConsequenceCopy('offsite')).toBe(
      'The listing leaves the store. A fresh review request is queued with the current ' +
        'version — the owner does not resubmit anything — and they are notified, with the ' +
        'reason you give below. It goes back up when a moderator approves that request; it ' +
        'cannot be restored from this page.'
    );
  });

  it('an unrecognised kind gets the off-site (weaker) claim, never the on-site one', () => {
    // Only `resetOnsiteListingToPending` suspends a block, and only an `onsite` listing
    // routes there. Telling a moderator "the app stops serving" for a kind we cannot
    // identify would be asserting a consequence the proc they are about to call does not
    // have.
    expect(unpublishConsequenceCopy('something-else')).toBe(unpublishConsequenceCopy('offsite'));
    expect(unpublishConsequenceCopy('something-else')).not.toContain('stops serving');
  });
});
