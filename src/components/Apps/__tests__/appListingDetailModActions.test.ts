import { describe, expect, it } from 'vitest';

import {
  DETAIL_SURFACE_MOD_ACTIONS,
  DETAIL_TAKEDOWN_ACTIONS,
  TAKEDOWN_TESTID_STEM,
  appListingDetailModActions,
  detailListingStatus,
  detailModActionLabel,
  isDetailTakedownAction,
  takedownConsequenceCopy,
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
    it(`a moderator on a live ${kind} listing gets Contact owner + both takedowns, in canonical order`, () => {
      expect(appListingDetailModActions({ isModerator: true, preview: false, kind })).toEqual([
        'message-owner',
        'reset-to-pending',
        'hide',
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
   * 🔴 `hide` IS OFFERED ONLY BECAUSE THE STATE MACHINE ADMITS IT ON AN APPROVED LISTING.
   * The surface subset is a filter, never a source: adding a member to
   * {@link DETAIL_SURFACE_MOD_ACTIONS} that the machine does not admit here must still
   * produce nothing. `relist` is the live proof of that below.
   */
  it('offers hide for an approved listing of either kind — the state machine admits it', () => {
    for (const kind of KINDS) {
      expect(listingModActions({ status: 'approved', kind, hasPendingRequest: false })).toContain(
        'hide'
      );
      expect(appListingDetailModActions({ isModerator: true, preview: false, kind })).toContain(
        'hide'
      );
    }
  });

  /**
   * 🔴 `relist` IS UNREACHABLE FROM THIS SURFACE, and that is the design answer this
   * module exists to record — not an omission somebody should "fix" by adding a button.
   *
   * It acts on a `removed` listing; `getAppDetail` is approved-only, so a removed listing
   * 404s before this body mounts. The check is on the STATE (the action is absent from
   * every set this function can produce), not on the word appearing in a menu.
   *
   * 🔴 IT IS ALSO THE CONTROL ON THE SUBSET FILTER now that `hide` has joined it. `hide`
   * and `relist` are the two halves of the same dual-kind pair; if the filter were the
   * SOURCE of the menu rather than an intersection, adding one would have brought the
   * other. It did not, because the machine does not admit `relist` on `approved`.
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

describe('the takedown pair', () => {
  it('is exactly the state-changing subset — message-owner is not a takedown', () => {
    // `message-owner` changes no listing state and routes to its own composer with its
    // own two fields; routing it to the reason-gated confirm would offer a moderator a
    // `reason` box for a proc that takes a subject and a body.
    expect([...DETAIL_TAKEDOWN_ACTIONS].sort()).toEqual(['hide', 'reset-to-pending']);
    expect(DETAIL_TAKEDOWN_ACTIONS).not.toContain('message-owner');
    for (const action of DETAIL_TAKEDOWN_ACTIONS) {
      expect(DETAIL_SURFACE_MOD_ACTIONS).toContain(action);
    }
  });

  it('isDetailTakedownAction narrows the pair and refuses everything else', () => {
    for (const action of DETAIL_TAKEDOWN_ACTIONS) expect(isDetailTakedownAction(action)).toBe(true);
    // Every OTHER member of the vocabulary must be refused — enumerated from the shared
    // union rather than sampled, so a member added there is covered without editing this.
    for (const action of ALL_LISTING_MOD_ACTIONS) {
      if ((DETAIL_TAKEDOWN_ACTIONS as readonly string[]).includes(action)) continue;
      expect(isDetailTakedownAction(action)).toBe(false);
    }
    expect(isDetailTakedownAction('')).toBe(false);
  });

  it('each takedown owns a DISTINCT testid stem', () => {
    // The two confirms are one component parameterised by action, so a shared or
    // duplicated stem would let a test open one and assert against the other's modal —
    // and pass, because both render the same shell.
    const stems = DETAIL_TAKEDOWN_ACTIONS.map((a) => TAKEDOWN_TESTID_STEM[a]);
    expect(stems.every((s) => s.length > 0)).toBe(true);
    expect(new Set(stems).size).toBe(stems.length);
  });
});

describe('detailModActionLabel', () => {
  it('every member of the surface subset has a label, and they are distinct', () => {
    const labels = DETAIL_SURFACE_MOD_ACTIONS.map(detailModActionLabel);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('the reset label names BOTH halves of what the proc does', () => {
    // The action takes the app off the store AND re-queues it for review. A label that
    // says only one of those misdescribes it, in one direction or the other.
    const label = detailModActionLabel('reset-to-pending');
    expect(label).toContain('Unpublish');
    expect(label.toLowerCase()).toContain('review');
  });

  it('the hide label carries the UNDO cost and claims no re-review', () => {
    // 🔴 The two takedowns sit adjacent in the menu and have the SAME immediate effect.
    // The only thing that lets a moderator choose is what it costs to undo, so the label
    // must say it — and must not borrow the other one's "review" wording, which would
    // describe a re-queue that `delistListing` does not perform.
    const label = detailModActionLabel('hide');
    expect(label.toLowerCase()).toContain('reversible');
    expect(label.toLowerCase()).not.toContain('review');
  });

  it('the two takedown labels are not confusable with each other', () => {
    const [reset, hide] = [
      detailModActionLabel('reset-to-pending'),
      detailModActionLabel('hide'),
    ];
    expect(reset).not.toBe(hide);
    // Neither may be a prefix of the other: in a narrow dropdown a truncated label is
    // what the moderator actually reads, and two items truncating to the same string is
    // the same defect as giving them the same name.
    expect(reset.startsWith(hide)).toBe(false);
    expect(hide.startsWith(reset)).toBe(false);
  });
});

describe('takedownConsequenceCopy', () => {
  /**
   * 🔴 THE WHOLE NORMALISED STRING, per action × per kind, because this is a claim about
   * what the platform is about to do to somebody's live app — and a guard on WORDS is
   * walkable by rewording. A deliberate copy change fails these and is meant to: updating
   * a machine-readable pin is the cheap half of changing a statement of consequences.
   */
  const TAIL =
    ' The owner is notified with the reason you give below, and it is recorded in this ' +
    'listing’s moderation history. Neither action can be undone from this page — the ' +
    'store detail is approved-only, so this listing will 404 here as soon as you confirm.';

  it('hide + on-site — names the runtime stop and the one-click way back', () => {
    expect(takedownConsequenceCopy('hide', 'onsite')).toBe(
      'The app stops serving immediately and its listing leaves the store. Nothing is ' +
        're-queued and nothing is re-reviewed: a moderator puts it back exactly as it is, ' +
        'in one click, with Relist in the review queue. Choose "Unpublish and send back to ' +
        'review" instead if the app has to CHANGE before it returns.' +
        TAIL
    );
  });

  it('hide + off-site — same undo story, and NO runtime-stop claim', () => {
    expect(takedownConsequenceCopy('hide', 'offsite')).toBe(
      'The listing leaves the store. Nothing is re-queued and nothing is re-reviewed: a ' +
        'moderator puts it back exactly as it is, in one click, with Relist in the review ' +
        'queue. Choose "Unpublish and send back to review" instead if the app has to CHANGE ' +
        'before it returns.' +
        TAIL
    );
  });

  it('reset + on-site — names the runtime stop and the re-approval requirement', () => {
    expect(takedownConsequenceCopy('reset-to-pending', 'onsite')).toBe(
      'The app stops serving immediately and its listing leaves the store. A fresh review ' +
        'request is queued with the current version — the owner resubmits nothing — and it ' +
        'goes back up only when a moderator approves that request. Choose "Hide from store" ' +
        'instead if you expect to put it back unchanged.' +
        TAIL
    );
  });

  it('reset + off-site — same re-approval story, and NO runtime-stop claim', () => {
    expect(takedownConsequenceCopy('reset-to-pending', 'offsite')).toBe(
      'The listing leaves the store. A fresh review request is queued with the current ' +
        'version — the owner resubmits nothing — and it goes back up only when a moderator ' +
        'approves that request. Choose "Hide from store" instead if you expect to put it ' +
        'back unchanged.' +
        TAIL
    );
  });

  /**
   * 🔴 THE PROPERTIES THE FOUR LITERALS ABOVE EXIST TO PROTECT, stated as properties so a
   * future reword cannot satisfy the pins by accident while losing the meaning. Each is a
   * claim about a DIFFERENCE, so it cannot be passed by a copy that says the same thing
   * in all four cells.
   */
  it('only the on-site arms claim a runtime stop', () => {
    for (const action of DETAIL_TAKEDOWN_ACTIONS) {
      expect(takedownConsequenceCopy(action, 'onsite')).toContain('stops serving');
      expect(takedownConsequenceCopy(action, 'offsite')).not.toContain('stops serving');
    }
  });

  it('only the reset arms claim a re-review; only the hide arms deny one', () => {
    for (const kind of KINDS) {
      const hide = takedownConsequenceCopy('hide', kind);
      const reset = takedownConsequenceCopy('reset-to-pending', kind);
      expect(reset).toContain('approves that request');
      expect(hide).not.toContain('approves that request');
      expect(hide).toContain('nothing is re-reviewed');
      expect(reset).not.toContain('nothing is re-reviewed');
    }
  });

  it('each arm points at the OTHER action by its exact menu label', () => {
    // The contrast is only usable if the sentence names something the moderator can find
    // in the menu they just came from. Derived from `detailModActionLabel` so a relabel
    // that forgets the copy fails here rather than shipping a pointer to a name that no
    // longer exists on screen.
    for (const kind of KINDS) {
      expect(takedownConsequenceCopy('hide', kind)).toContain(
        detailModActionLabel('reset-to-pending')
      );
      // The hide label carries a parenthetical the prose does not repeat verbatim, so the
      // reset arm points at its distinctive stem rather than the whole chip.
      expect(takedownConsequenceCopy('reset-to-pending', kind)).toContain('Hide from store');
      expect(detailModActionLabel('hide')).toContain('Hide from store');
    }
  });

  it('an unrecognised kind gets the off-site (weaker) claim, never the on-site one', () => {
    // Only an ON-SITE listing has a backing block to suspend. Telling a moderator "the app
    // stops serving" for a kind we cannot identify would assert a consequence the proc
    // they are about to call does not have.
    for (const action of DETAIL_TAKEDOWN_ACTIONS) {
      expect(takedownConsequenceCopy(action, 'something-else')).toBe(
        takedownConsequenceCopy(action, 'offsite')
      );
      expect(takedownConsequenceCopy(action, 'something-else')).not.toContain('stops serving');
    }
  });
});
