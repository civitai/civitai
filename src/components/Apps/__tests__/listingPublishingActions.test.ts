import { describe, expect, it } from 'vitest';

import {
  EDITOR_ACTIONS,
  listingOwnerState,
  listingPublishingActions,
  OWNER_ACTIONS_BY_STATE,
  ownerVisibilityLoadState,
  PUBLISHING_PANEL_ACTIONS,
  republishSuccessMessage,
  withdrawSuccessMessage,
  showModRemovedNotice,
  showRepublish,
  showUnpublish,
  showVisibility,
  sortPublishingActions,
  type PublishingActionRow,
} from '~/components/Apps/listingPublishingActions';
import { OWNER_UNPUBLISH_ACTION } from '~/components/Apps/offsiteOwnerControls';

/**
 * The PURE half of the owner PUBLISHING ledger. The DOM half — the one that actually
 * catches a dropped button — lives in `ListingPublishingPanel.browser.test.tsx` and
 * compares the rendered controls against the same table.
 *
 * 🔴 THE SURFACE MOVED, THE LEDGER DID NOT DIE. These controls used to live on an
 * `/apps/mine` row and now live on the authoring page's Publishing tab. `history` left the
 * vocabulary in that move — it became a TAB, and is pinned by `appListingEditorTabs.test.ts`
 * rather than by a set comparison over buttons.
 *
 * 🔴 WHAT THIS FILE CAN AND CANNOT PROVE, stated up front. It runs in the **`unit`**
 * project, which is the tier that BLOCKS; the browser-mode `component` project is
 * report-only. So the routing rules are pinned here where a red is enforceable, and the
 * rendering is pinned there where it is observable. Neither is sufficient alone: this file
 * would pass with the buttons deleted from the page, and the browser file's ledger is only
 * as good as the table this file pins.
 *
 * 🔴 FIXTURES ARE PAIRWISE DISTINCT AND NON-DEFAULT. `status`, `lastModerationAction` and
 * `role` never share a value across the cases that separate them, and no fixture's fields
 * can produce an expected value by coincidence — a mutant that hardcodes `'live'`, `'owner'`
 * or an empty action list has to be visible in at least one case.
 */

function row(over: Partial<PublishingActionRow> = {}): PublishingActionRow {
  return { status: 'approved', lastModerationAction: null, role: 'owner', ...over };
}

/** The four states, each reached by the field combination that is the ONLY route to it. */
const LIVE = row({ status: 'approved', lastModerationAction: null });
const OWNER_HIDDEN = row({ status: 'removed', lastModerationAction: OWNER_UNPUBLISH_ACTION });
// `other` is what the SERVER now sends for every non-owner action — the projection
// normalises `delist`/`purge`/`claim`/… to one value so a seated editor never receives the
// moderator's verb (`app-access.my-app-listings-moderation.test.ts`). The routing must key on
// "not owner-unpublish", so a raw verb is also exercised below to prove it still does.
const MOD_REMOVED = row({ status: 'removed', lastModerationAction: 'other' });
const INACTIVE = row({ status: 'draft', lastModerationAction: null });
/**
 * 🔴 THE DISCRIMINATING FIXTURE FOR `visibility`, AND WITHOUT IT THE PREDICATE IS UNTESTED.
 * `rejected` also classifies as {@link OwnerListingState} `inactive` — the same cell as
 * `INACTIVE` above — but it is NOT level-eligible, so it is the only fixture here that can
 * separate `showVisibility` from the constant `true`. Every other status in this file is
 * either eligible (`approved`, `draft`) or already yields `[]` for an unrelated reason
 * (`removed`). A sweep built only from the four original fixtures scores a `() => true`
 * mutant as SURVIVED.
 */
const REJECTED = row({ status: 'rejected', lastModerationAction: null });

describe('the ledger table itself', () => {
  it('declares an entry for every owner state, drawn from the declared action vocabulary', () => {
    // 🔴 SET EQUALITY ON THE KEYS, not `toBeDefined` per key. A state added to
    // `OwnerListingState` without an entry here would leave the component with
    // `OWNER_ACTIONS_BY_STATE[state] === undefined` and render nothing at all — which is
    // exactly the silent-drop shape this ledger exists to make loud.
    expect(Object.keys(OWNER_ACTIONS_BY_STATE).sort()).toEqual(
      ['inactive', 'live', 'mod-removed', 'owner-hidden'].sort()
    );
    for (const [state, actions] of Object.entries(OWNER_ACTIONS_BY_STATE)) {
      for (const a of actions) {
        expect(PUBLISHING_PANEL_ACTIONS, `${state} declares unknown action ${a}`).toContain(a);
      }
      // No duplicates — a repeated entry would make a set comparison against the DOM
      // (which cannot repeat an action) fail for a reason that is not a missing control.
      expect(new Set(actions).size).toBe(actions.length);
    }
  });

  it('pins the exact per-state sets, as literals', () => {
    // 🔴 LITERAL EXPECTED VALUES, never derived from the implementation. These four lines
    // are the whole contract: the state that offers Unpublish, the state that offers
    // Republish, and the two that offer neither.
    expect(OWNER_ACTIONS_BY_STATE.live).toEqual(['unpublish']);
    expect(OWNER_ACTIONS_BY_STATE['owner-hidden']).toEqual(['republish']);
    expect(OWNER_ACTIONS_BY_STATE['mod-removed']).toEqual([]);
    expect(OWNER_ACTIONS_BY_STATE.inactive).toEqual([]);
    expect(EDITOR_ACTIONS).toEqual([]);
  });

  it('never offers Unpublish and Republish on the same row', () => {
    // They are mutually exclusive by construction (one moves `approved → removed`, the
    // other the reverse), and a row offering both would be offering one guaranteed 403.
    for (const actions of Object.values(OWNER_ACTIONS_BY_STATE)) {
      expect(actions.includes('unpublish') && actions.includes('republish')).toBe(false);
    }
  });

  it('offers exactly ONE state a way back — the owner-unpublished one', () => {
    // 🔴 THE POINT OF THE PAIR. If no state carried `republish`, an owner unpublish would be
    // a one-way door (only a moderator `relistListing` reopens it); if more than one did, the
    // client would be offering a restore the server's last-event guard refuses.
    const withRepublish = Object.entries(OWNER_ACTIONS_BY_STATE)
      .filter(([, actions]) => actions.includes('republish'))
      .map(([state]) => state);
    expect(withRepublish).toEqual(['owner-hidden']);
  });
});

describe('listingOwnerState — the routing the ledger is keyed on', () => {
  it('maps each field combination to its own state', () => {
    expect(listingOwnerState(LIVE)).toBe('live');
    expect(listingOwnerState(OWNER_HIDDEN)).toBe('owner-hidden');
    expect(listingOwnerState(MOD_REMOVED)).toBe('mod-removed');
    expect(listingOwnerState(INACTIVE)).toBe('inactive');
  });

  it('treats a removed listing with NO recorded event as a moderator removal', () => {
    // 🔴 THE SAFE DIRECTION, and it is a real production shape: a listing removed before the
    // moderation-event table existed has no last event. Guessing "owner" there would offer a
    // Republish the server refuses; guessing "moderator" withholds a button the owner may
    // genuinely be entitled to, which is recoverable by asking a moderator.
    expect(listingOwnerState(row({ status: 'removed', lastModerationAction: null }))).toBe(
      'mod-removed'
    );
    expect(listingOwnerState(row({ status: 'removed', lastModerationAction: undefined }))).toBe(
      'mod-removed'
    );
  });

  it('routes on "not owner-unpublish", so a RAW verb lands in the same state as `other`', () => {
    // 🔴 The client must not depend on the server's normalisation having happened. A cached
    // payload from before that projection shipped, or any future caller that hands over a raw
    // action, still has to reach `mod-removed` — the predicate is an equality test against ONE
    // value, and everything else is the safe side of it. Four pairwise-distinct real verbs.
    for (const verb of ['delist', 'purge', 'claim', 'report-dismiss']) {
      expect(listingOwnerState(row({ status: 'removed', lastModerationAction: verb }))).toBe(
        'mod-removed'
      );
    }
  });

  it('does not read the moderation action on a non-removed listing', () => {
    // A stale `owner-unpublish` on a listing that is approved again must not re-open
    // Republish next to a live app.
    expect(
      listingOwnerState(row({ status: 'approved', lastModerationAction: 'owner-unpublish' }))
    ).toBe('live');
  });
});

describe('listingPublishingActions', () => {
  it('returns the ledger entry for the row state, COMPOSED with the level control', () => {
    // 🔴 TWO KEYS, NOT ONE. The takedown pair is role+`OwnerListingState`; `visibility` is
    // status-only. `approved` and `draft` are level-eligible, the two `removed` states are
    // not — so the level control appears in exactly two of these four rows, and it is the
    // ONLY member that can appear beside `unpublish` or alone.
    expect(listingPublishingActions(LIVE)).toEqual(['unpublish', 'visibility']);
    expect(listingPublishingActions(OWNER_HIDDEN)).toEqual(['republish']);
    expect(listingPublishingActions(MOD_REMOVED)).toEqual([]);
    expect(listingPublishingActions(INACTIVE)).toEqual(['visibility']);
  });

  it('withholds the level control from a seat on EVERY status', () => {
    // The role term, driven at every fixture rather than only the live one, so a mutant that
    // gates on the STATUS instead of the role fails on at least one.
    for (const base of [LIVE, OWNER_HIDDEN, MOD_REMOVED, INACTIVE, REJECTED]) {
      expect(showVisibility({ ...base, role: 'editor' })).toBe(false);
    }
    // Positive control: the owner DOES get it on the two eligible fixtures, so the sweep
    // above is about the role and not about the control being gone entirely.
    expect(showVisibility(LIVE)).toBe(true);
    expect(showVisibility(INACTIVE)).toBe(true);
  });

  it('withholds the level control on `rejected`, which shares the `inactive` cell', () => {
    // 🔴 THE CONTROL THAT MAKES THE ROW ABOVE MEAN SOMETHING. `REJECTED` and `INACTIVE` are
    // the SAME `OwnerListingState`, so a state-keyed implementation would give them the same
    // answer; they differ here only because the predicate reads the STATUS. This is also the
    // case that kills a `showVisibility = () => true` mutant — nothing else in this file can.
    expect(listingOwnerState(REJECTED)).toBe(listingOwnerState(INACTIVE));
    expect(listingPublishingActions(REJECTED)).toEqual([]);
    expect(showVisibility(REJECTED)).toBe(false);
    expect(showVisibility(INACTIVE)).toBe(true);
  });

  it('gives a seated EDITOR no TAKEDOWN control, in every state', () => {
    // 🔴 Both takedown procs are owner-scoped server-side. This loop is the reachability
    // proof for the role branch: it is exercised at all four states, not just the live one,
    // so a mutant that gates on the state instead of the role fails on at least one.
    //
    // 🔴 AND IT IS WEAKER THAN IT WAS, WHICH IS WHY IT IS NOT THE ONLY ROLE GUARD. `[]` is
    // now the right answer for TWO of the four owner states as well, so this assertion can
    // no longer separate "the role branch fired" from "the state branch happened to agree"
    // on `mod-removed` and `inactive`. The `LIVE` and `OWNER_HIDDEN` iterations still can —
    // they are the two whose owner answer is non-empty — and the seam test below drives the
    // predicates directly at every state × role. `editorTabsFor`'s own editor cases are the
    // other half.
    // 🔴 NARROWED FROM "nothing" TO "no takedown control", because `visibility` is
    // role-agnostic server-side and an editor legitimately gets it. Asserting `[]` here
    // would have encoded a refusal the server does not make. The takedown pair is what this
    // loop is about, so it is asserted DIRECTLY rather than via the composed list — which
    // keeps the assertion exactly as strong as it was before the level control existed.
    for (const base of [LIVE, OWNER_HIDDEN, MOD_REMOVED, INACTIVE, REJECTED]) {
      const asEditor = { ...base, role: 'editor' as const };
      expect(showUnpublish(asEditor)).toBe(false);
      expect(showRepublish(asEditor)).toBe(false);
      expect(listingPublishingActions(asEditor)).not.toContain('unpublish');
      expect(listingPublishingActions(asEditor)).not.toContain('republish');
    }
    // The two that are load-bearing, restated so the weakening above is explicit rather
    // than absorbed: the owner answer differs, the editor answer does not.
    expect(listingPublishingActions(LIVE)).toContain('unpublish');
    expect(listingPublishingActions(OWNER_HIDDEN)).toContain('republish');
    // 🔴 AND AN EDITOR GETS THE LEVEL CONTROL EITHER, WHICH THIS FILE ONCE ASSERTED THE
    // OPPOSITE OF. The server's level proc DOES admit an accepted seat, so role-agnostic was
    // a true claim about the proc — and an unreachable one about the product, because
    // `editorTabsFor` withholds the Publishing tab from an editor entirely. The assertion
    // that an editor "renders exactly one control" pinned a configuration nothing can mount.
    // Operator's call (2026-10-03): widen the tab's STATUS term, leave `role` alone. To
    // re-enable the seat, widen `editorTabsFor`'s role term FIRST — then change this line.
    expect(listingPublishingActions({ ...LIVE, role: 'editor' })).toEqual([]);
    expect(listingPublishingActions({ ...INACTIVE, role: 'editor' })).toEqual([]);
  });

  it('agrees with the per-control predicates the component calls', () => {
    // 🔴 THE COMPONENT USES `showUnpublish`/`showRepublish`, and the ledger test compares the
    // DOM against `OWNER_ACTIONS_BY_STATE`. If those two ever disagreed, the ledger would be
    // pinning itself rather than the page. This is the seam that forbids it.
    for (const base of [LIVE, OWNER_HIDDEN, MOD_REMOVED, INACTIVE, REJECTED]) {
      for (const role of ['owner', 'editor'] as const) {
        const r = { ...base, role };
        const declared = listingPublishingActions(r);
        expect(showUnpublish(r)).toBe(declared.includes('unpublish'));
        expect(showRepublish(r)).toBe(declared.includes('republish'));
        // 🔴 The level control joins the seam on the same terms. Without this line the
        // panel could render it from `showVisibility` while the ledger's list omitted it,
        // and the browser set-comparison would be measuring the DOM against a table the
        // DOM is not forced to follow — the self-pinning this whole test exists to forbid.
        expect(showVisibility(r)).toBe(declared.includes('visibility'));
      }
    }
  });
});

describe('showModRemovedNotice', () => {
  it('fires only on a moderator takedown, for owners AND collaborators alike', () => {
    expect(showModRemovedNotice(MOD_REMOVED)).toBe(true);
    expect(showModRemovedNotice({ ...MOD_REMOVED, role: 'editor' })).toBe(true);
    expect(showModRemovedNotice(LIVE)).toBe(false);
    expect(showModRemovedNotice(OWNER_HIDDEN)).toBe(false);
    expect(showModRemovedNotice(INACTIVE)).toBe(false);
  });

  it('is a STATEMENT, not an action — absent from the action vocabulary', () => {
    expect(PUBLISHING_PANEL_ACTIONS).not.toContain('mod-removed');
  });
});

describe('sortPublishingActions', () => {
  it('imposes the canonical order regardless of input order', () => {
    expect(sortPublishingActions(['republish', 'unpublish'])).toEqual(['unpublish', 'republish']);
    expect(sortPublishingActions(['unpublish', 'republish'])).toEqual(['unpublish', 'republish']);
  });

  it('keeps an UNKNOWN action last and visible rather than dropping it', () => {
    // 🔴 A comparison helper that silently discarded an unrecognised entry would turn the
    // ledger's GROWTH arm off: a new, unregistered control would sort away and the sets would
    // match. `zz-new` is deliberately not a prefix or suffix of any real action.
    expect(sortPublishingActions(['zz-new', 'republish', 'unpublish'])).toEqual([
      'unpublish',
      'republish',
      'zz-new',
    ]);
  });
});

describe('republishSuccessMessage — 🔴 the UI must not claim "live" when it went to review', () => {
  it('says the listing is LIVE when the server approved it', () => {
    expect(republishSuccessMessage({ status: 'approved' }, 'onsite')).toContain('live');
    expect(republishSuccessMessage({ status: 'approved' }, 'offsite')).toContain(
      'live in the store'
    );
  });

  it('🔴 says REVIEW when the server routed it to pending — for BOTH kinds', () => {
    // The wording is asserted on the PENDING arm for each kind separately: a mutant that
    // branched on `kind` before `status` would still satisfy a single-kind assertion.
    for (const kind of ['onsite', 'offsite'] as const) {
      const message = republishSuccessMessage(
        { status: 'pending', reviewReason: 'assets-changed' },
        kind
      );
      expect(message).toContain('review');
      // 🔴 The load-bearing ABSENCE: the old hardcoded copy said "it is live again", which
      // is a lie on this arm. Pin that the word cannot come back.
      expect(message).not.toContain('live');
    }
  });

  it('the two arms produce DIFFERENT text (a mutant returning one constant cannot pass)', () => {
    expect(republishSuccessMessage({ status: 'pending' }, 'offsite')).not.toBe(
      republishSuccessMessage({ status: 'approved' }, 'offsite')
    );
  });

  it('🔴 only `assets-changed` claims the images changed', () => {
    // The reason exists on the wire; using one sentence for every reason told an owner
    // their images had changed on a path where nothing about their images necessarily
    // did. Asserted as an EXCLUSIVE pair, so a mutant that returns the specific sentence
    // unconditionally fails on the second half.
    expect(
      republishSuccessMessage({ status: 'pending', reviewReason: 'assets-changed' })
    ).toContain('images changed');
    expect(
      republishSuccessMessage({ status: 'pending', reviewReason: 'unreadable-baseline' })
    ).not.toContain('images changed');
  });

  it('🔴 an UNRECOGNISED reason falls back to the NEUTRAL wording, never the specific one', () => {
    // A reason added server-side must not silently inherit a factual claim about the
    // owner's actions that it does not support. `undefined` (an older client, or a server
    // that omitted the field) takes the same safe branch.
    for (const reviewReason of ['some-future-reason', undefined, null]) {
      const message = republishSuccessMessage({ status: 'pending', reviewReason });
      expect(message).toContain('review');
      expect(message).not.toContain('images changed');
    }
  });
});

describe('withdrawSuccessMessage — 🔴 a one-way close must SAY it is one-way', () => {
  it('🔴 a `removed` close tells the owner a moderator has to restore it', () => {
    const message = withdrawSuccessMessage('removed');
    expect(message).toContain('off the store');
    expect(message).toContain('moderator');
  });

  it.each([['deleted'], ['none'], [undefined], [null]])(
    'every other outcome (%s) keeps the plain wording — no moderator claim',
    (outcome) => {
      // The exclusive half. Without it a mutant returning the scary sentence
      // unconditionally would pass the case above, and every draft withdraw would tell
      // its author to go find a moderator for no reason.
      const message = withdrawSuccessMessage(outcome);
      expect(message).toBe('Submission withdrawn.');
    }
  );
});

/**
 * The store `⋮` menu's owner "Visibility" item fetches the authoring context lazily and
 * decides what to render from it. Eligibility must be `showVisibility` on the FETCHED row —
 * the menu item itself is gated on ownership only, because neither store DTO carries a
 * status.
 */
describe('ownerVisibilityLoadState — the store menu’s lazily-fetched owner picker', () => {
  it('no context and no error → loading', () => {
    expect(ownerVisibilityLoadState({ isError: false, context: undefined })).toBe('loading');
    expect(ownerVisibilityLoadState({ isError: false, context: null })).toBe('loading');
  });

  it('no context and an error → error (e.g. FORBIDDEN for a caller with no role)', () => {
    expect(ownerVisibilityLoadState({ isError: true, context: undefined })).toBe('error');
  });

  it('an eligible owner row → ready, on every status showVisibility admits', () => {
    expect(ownerVisibilityLoadState({ isError: false, context: LIVE })).toBe('ready');
    expect(ownerVisibilityLoadState({ isError: false, context: INACTIVE })).toBe('ready');
  });

  it('🔴 a loaded but ineligible row → ineligible, never ready', () => {
    // `rejected` and mod-`removed` carry no settable level; an editor is refused by role.
    // Each is the case that kills a mutant returning 'ready' for any loaded context.
    expect(ownerVisibilityLoadState({ isError: false, context: REJECTED })).toBe('ineligible');
    expect(ownerVisibilityLoadState({ isError: false, context: MOD_REMOVED })).toBe('ineligible');
    expect(ownerVisibilityLoadState({ isError: false, context: { ...LIVE, role: 'editor' } })).toBe(
      'ineligible'
    );
  });

  it('agrees with showVisibility on every fixture (one predicate, not a second derivation)', () => {
    for (const r of [LIVE, OWNER_HIDDEN, MOD_REMOVED, INACTIVE, REJECTED]) {
      for (const role of ['owner', 'editor'] as const) {
        const context = { ...r, role };
        expect(ownerVisibilityLoadState({ isError: false, context }) === 'ready').toBe(
          showVisibility(context)
        );
      }
    }
  });

  it('a loaded context wins over a later refetch error', () => {
    // React Query keeps the last data alongside `isError` after a failed refetch; the
    // decision should follow the data the picker would actually render from.
    expect(ownerVisibilityLoadState({ isError: true, context: LIVE })).toBe('ready');
  });
});
