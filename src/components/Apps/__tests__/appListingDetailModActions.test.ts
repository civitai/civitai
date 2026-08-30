import { describe, expect, it } from 'vitest';

import {
  DETAIL_SURFACE_MOD_ACTIONS,
  DETAIL_TAKEDOWN_ACTIONS,
  REVIEW_QUEUE_MANAGE_HREF,
  TAKEDOWN_TESTID_STEM,
  appListingDetailModActions,
  detailListingStatus,
  detailModActionLabel,
  isDetailTakedownAction,
  takedownConsequenceCopy,
  takedownSubmitLabel,
  takedownSuccessMessage,
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

/**
 * The first whitespace-delimited word of a label — the half a confirm button's verb is
 * supposed to reproduce.
 *
 * Throws on an empty or whitespace-only input rather than returning `''`, so a label that
 * disappears fails by name instead of making an equality comparison quietly pass against
 * an equally-empty verb.
 */
function openingWord(label: string): string {
  const first = label.trim().split(/\s+/)[0];
  if (!first) throw new Error('label has no opening word');
  return first;
}

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
      for (const action of appListingDetailModActions({
        isModerator: true,
        preview: false,
        kind,
      })) {
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

/**
 * 🔴 THE FOUR CONFIRM STRINGS AND THE REVIEW-QUEUE HREF, PINNED WHOLE, BOTH ARMS, IN THE
 * BLOCKING TIER — because every one of them was measured SURVIVING a mutant.
 *
 * These lived as module-private maps inside `ListingTakedownModal.tsx`, a `.tsx` no
 * blocking suite can import, so their only coverage was the report-only browser tier and
 * there only on the `hide` arm. An adversarial audit measured two mutants green on BOTH
 * tiers:
 *
 *   - swapping the two success messages, so a hide tells the moderator to approve a
 *     request that was never queued and a re-queue tells them to hit Relist;
 *   - the ONE-SIDED `takedownSubmitLabel('reset-to-pending') = 'Hide from store'`, which
 *     the browser assertion could not see because it reads the HIDE button.
 *
 * 🔴 AND THE ONE-SIDEDNESS IS THE REUSABLE LESSON, not the specific strings. A previous
 * round of this PR claimed the submit-label swap was killed; it was, but only by the arm
 * that happened to move the word `Unpublish` onto the button the test reads. A pin on ONE
 * arm of a two-arm map is not a pin on the map. Every case below asserts BOTH arms.
 */
describe('the confirm strings and the review-queue destination', () => {
  it('the review-queue link carries tab=manage — a bare /apps/review lands on PENDING', () => {
    // `/apps/review` resolves an absent `?tab=` to 'pending', and Relist is on the manage
    // tab, so the bare path sends a moderator to a queue that cannot do the thing the
    // consequence copy just promised. Pinned as the whole literal.
    expect(REVIEW_QUEUE_MANAGE_HREF).toBe('/apps/review?tab=manage');
  });

  it('the submit VERB, both arms', () => {
    expect(takedownSubmitLabel('reset-to-pending')).toBe('Unpublish');
    expect(takedownSubmitLabel('hide')).toBe('Hide');
  });

  it('the success message, both arms, whole', () => {
    expect(takedownSuccessMessage('reset-to-pending')).toBe(
      'App unpublished and re-queued for review. Approve the queued request in the review ' +
        'queue to put it back up.'
    );
    expect(takedownSuccessMessage('hide')).toBe(
      'App hidden from the store. Use Relist in the review queue to put it straight back.'
    );
  });

  /**
   * The PROPERTIES the literals protect, so a reword cannot keep the pins happy while
   * losing the meaning — and, unlike the literals, these fail on a SWAP specifically.
   */
  it('each success message names its OWN undo path and not the other one', () => {
    const reset = takedownSuccessMessage('reset-to-pending');
    const hide = takedownSuccessMessage('hide');
    expect(hide).toContain('Relist');
    expect(hide).not.toContain('Approve the queued request');
    expect(reset).toContain('Approve the queued request');
    expect(reset).not.toContain('Relist');
  });

  it('each submit verb IS the opening word of its own menu label, and of no other', () => {
    // The button is the last thing read before an action that cannot be undone from this
    // page, so it must agree with the item that was clicked.
    //
    // 🔴 STATED AS AN EQUALITY AGAINST A VALUE DERIVED FROM THE LABEL, and that is the fix
    // for a measured blind spot — the same one this file's pointer check had. This used to
    // be `expect(detailModActionLabel(action)).toContain(takedownSubmitLabel(action))`,
    // with the needle on the VERB side, so shortening the verb left a shorter needle the
    // unchanged label still contains. Measured: truncating
    // `takedownSubmitLabel('reset-to-pending')` to `'Unpub'` SURVIVED this assertion (it
    // died only on the whole-string pin two cases up), while the assertion's NAME claimed
    // it checked the verb-to-label relationship. A guard that reads as coverage while
    // providing none is worse than none, because it stops the next person looking.
    //
    // The relationship is now the other way round: the label's opening word is read OUT of
    // the label and compared for EQUALITY with the verb. A verb that shrinks fails, a verb
    // that grows fails, and the claim in the test's name is the claim the body makes.
    for (const action of DETAIL_TAKEDOWN_ACTIONS) {
      const other = DETAIL_TAKEDOWN_ACTIONS.find((a) => a !== action)!;
      expect(openingWord(detailModActionLabel(action))).toBe(takedownSubmitLabel(action));
      // Cross-arm: the verb must not also open the OTHER item's label, or the button would
      // be ambiguous about which menu entry it belongs to. Kept as `startsWith` because
      // this one is a NEGATIVE — the hazard is a verb that opens both, and a shortened
      // verb cannot create that without also failing the equality above.
      expect(detailModActionLabel(other).startsWith(takedownSubmitLabel(action))).toBe(false);
    }
  });

  it('every takedown string is defined and the two arms differ, for all four', () => {
    // A blanket sweep so a THIRD takedown added later cannot ship with an empty or
    // copy-pasted string in either map.
    for (const produce of [takedownSubmitLabel, takedownSuccessMessage]) {
      const values = DETAIL_TAKEDOWN_ACTIONS.map(produce);
      expect(values.every((v) => v.length > 0)).toBe(true);
      expect(new Set(values).size).toBe(values.length);
    }
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
    const [reset, hide] = [detailModActionLabel('reset-to-pending'), detailModActionLabel('hide')];
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

  /**
   * The double-quoted phrase a consequence sentence uses to point at the other action.
   * Throws rather than returning `''` when there is none, so a copy that stops quoting
   * anything fails by name instead of making every comparison below vacuously pass.
   */
  function quotedPointer(copy: string): string {
    const m = /"([^"]+)"/.exec(copy);
    if (!m) throw new Error('the consequence copy quotes no action name');
    return m[1];
  }

  it('each arm points at the OTHER action by its exact menu label', () => {
    // The contrast is only usable if the sentence names something the moderator can find
    // in the menu they just came from — so the pointer is compared against
    // `detailModActionLabel`, not against a hard-coded string.
    //
    // 🔴 COMPARED IN THE DIRECTION A PREFIX CANNOT SATISFY, and that is the fix for a
    // measured blind spot rather than a stylistic preference. This used to be
    // `expect(copy).toContain(detailModActionLabel(...))`, with the needle on the LABEL
    // side — so shortening the label to a prefix of itself ("Unpublish and send back to
    // review" → "Unpublish from the store" … or simply "Unpublish") left a shorter needle
    // that the copy's unchanged full literal still contains, and the assertion stayed
    // green while shipping exactly the dangling on-screen pointer its own comment promised
    // to catch. Measured: a TRUNCATING relabel survived here (a non-prefix relabel did
    // kill it, so it was reachable and specifically blind to truncation).
    //
    // The relationship is now stated the other way round — the phrase the copy quotes is
    // read out of the copy and matched against the label — so a label that shrinks fails,
    // a label that grows fails, and a copy that stops quoting anything throws.
    for (const kind of KINDS) {
      // The hide arm quotes the reset label IN FULL, so the pin is equality.
      expect(quotedPointer(takedownConsequenceCopy('hide', kind))).toBe(
        detailModActionLabel('reset-to-pending')
      );
      // The reset arm quotes only the hide label's distinctive STEM — the hide label
      // carries a parenthetical the prose deliberately does not repeat. `startsWith` is
      // the truncation-safe spelling of that: the quoted stem must open the real label, so
      // a label shortened below it fails, and only the parenthetical tail may differ.
      const stem = quotedPointer(takedownConsequenceCopy('reset-to-pending', kind));
      expect(detailModActionLabel('hide').startsWith(stem)).toBe(true);
      // …and the tail that is allowed to differ must be the parenthetical, not more words
      // of a longer name — otherwise `startsWith` would re-admit an arbitrary rename.
      expect(detailModActionLabel('hide').slice(stem.length).trim()).toMatch(/^\(.*\)$/);
    }
  });

  /**
   * 🔴 THE TRUNCATION CLASS, SWEPT RATHER THAN SPOT-CHECKED. The blind spot above was not
   * a one-off: any `toContain` whose needle is the value under test is satisfiable by
   * shortening that value. This drives the specific mutant — every proper prefix of each
   * menu label — through the pointer check, and asserts the check refuses all of them.
   * It fails if someone re-spells the assertion in the blind direction later.
   */
  it('a TRUNCATED menu label is rejected by the pointer check, at every prefix length', () => {
    const real = detailModActionLabel('reset-to-pending');
    const copy = takedownConsequenceCopy('hide', 'onsite');
    // Positive control: the real label passes, so the refusals below are about truncation.
    expect(quotedPointer(copy)).toBe(real);
    for (let n = 1; n < real.length; n++) {
      const truncated = real.slice(0, n);
      // The blind spelling — needle on the label side — would accept every one of these.
      expect(copy.includes(truncated)).toBe(true);
      // The spelling actually used refuses them all.
      expect(quotedPointer(copy)).not.toBe(truncated);
    }
  });

  /**
   * The SAME sweep over the other surface that had the same blind spelling: the confirm
   * button's verb against its menu label. Kept as a second case rather than folded into an
   * abstract table, because the two checks are genuinely different relationships — the
   * pointer is a quoted phrase inside prose, the verb is the label's opening word — and a
   * shared harness would have to encode both anyway.
   */
  it('a TRUNCATED submit verb is rejected by the opening-word check, at every prefix length', () => {
    for (const action of DETAIL_TAKEDOWN_ACTIONS) {
      const label = detailModActionLabel(action);
      const real = takedownSubmitLabel(action);
      // Positive control: the real verb passes, so the refusals below are about truncation
      // and not about a check that rejects everything.
      expect(openingWord(label)).toBe(real);
      for (let n = 1; n < real.length; n++) {
        const truncated = real.slice(0, n);
        // The blind spelling — `label.toContain(verb)`, needle on the VERB side — would
        // accept every one of these. This is the assertion that used to ship.
        expect(label.includes(truncated)).toBe(true);
        // `startsWith` in the tempting direction is ALSO blind here, which is why the fix
        // is an equality rather than a re-anchored prefix test.
        expect(label.startsWith(truncated)).toBe(true);
        // The spelling actually used refuses them all.
        expect(openingWord(label)).not.toBe(truncated);
      }
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

/**
 * 🔴 REGRESSION — this surface must never offer `purge`, and the guard is the RELATIONSHIP
 * between two independent facts, either of which could change alone.
 *
 * Why it exists: `listingModActions` gained an on-site orphan-draft `purge` branch (#4491)
 * while this file was being written in parallel (#4493). Both PRs were individually green and
 * their FILES were disjoint; together they broke `main`'s typecheck, because #4493 added a
 * second caller of a function whose required inputs #4491 had widened. A clean git merge is
 * not a clean merge.
 *
 * Two things independently keep `purge` off this surface — `detailListingStatus` never returns
 * `'draft'`, and `DETAIL_SURFACE_MOD_ACTIONS` omits `purge` — so a test that only checked the
 * output would still pass if ONE of them regressed. These check both, and the inputs the call
 * site pins are chosen so the fail-safe direction is withhold.
 */
describe('appListingDetailModActions — purge is unreachable from the detail surface', () => {
  it('never offers purge for a moderator on a live listing, either kind', () => {
    for (const kind of ['onsite', 'offsite']) {
      const actions = appListingDetailModActions({ isModerator: true, preview: false, kind });
      expect(actions, `kind=${kind}`).not.toContain('purge');
      // Positive control: the surface IS returning its real action set, not an empty array —
      // otherwise "does not contain purge" is vacuously true.
      expect(actions.length, `kind=${kind} returned nothing`).toBeGreaterThan(0);
    }
  });

  it('the surface subset itself excludes purge', () => {
    expect(DETAIL_SURFACE_MOD_ACTIONS).not.toContain('purge');
  });

  it('the surface status can never be the one the purge branch requires', () => {
    // `purge` needs `status === 'draft'`; this surface only ever produces 'approved' or null.
    expect(detailListingStatus({ preview: false })).toBe('approved');
    expect(detailListingStatus({ preview: true })).toBeNull();
  });
});
