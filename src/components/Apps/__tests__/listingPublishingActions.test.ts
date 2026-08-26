import { describe, expect, it } from 'vitest';

import {
  EDITOR_ACTIONS,
  listingOwnerState,
  listingPublishingActions,
  OWNER_ACTIONS_BY_STATE,
  PUBLISHING_PANEL_ACTIONS,
  showModRemovedNotice,
  showRepublish,
  showUnpublish,
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
  it('returns the ledger entry for the row state', () => {
    expect(listingPublishingActions(LIVE)).toEqual(['unpublish']);
    expect(listingPublishingActions(OWNER_HIDDEN)).toEqual(['republish']);
    expect(listingPublishingActions(MOD_REMOVED)).toEqual([]);
    expect(listingPublishingActions(INACTIVE)).toEqual([]);
  });

  it('gives a seated EDITOR nothing, in every state', () => {
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
    for (const base of [LIVE, OWNER_HIDDEN, MOD_REMOVED, INACTIVE]) {
      expect(listingPublishingActions({ ...base, role: 'editor' })).toEqual([]);
    }
    // The two that are load-bearing, restated so the weakening above is explicit rather
    // than absorbed: the owner answer differs, the editor answer does not.
    expect(listingPublishingActions(LIVE)).not.toEqual([]);
    expect(listingPublishingActions(OWNER_HIDDEN)).not.toEqual([]);
  });

  it('agrees with the per-control predicates the component calls', () => {
    // 🔴 THE COMPONENT USES `showUnpublish`/`showRepublish`, and the ledger test compares the
    // DOM against `OWNER_ACTIONS_BY_STATE`. If those two ever disagreed, the ledger would be
    // pinning itself rather than the page. This is the seam that forbids it.
    for (const base of [LIVE, OWNER_HIDDEN, MOD_REMOVED, INACTIVE]) {
      for (const role of ['owner', 'editor'] as const) {
        const r = { ...base, role };
        const declared = listingPublishingActions(r);
        expect(showUnpublish(r)).toBe(declared.includes('unpublish'));
        expect(showRepublish(r)).toBe(declared.includes('republish'));
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
