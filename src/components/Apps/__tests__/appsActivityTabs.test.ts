import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_TAB_LABELS,
  ACTIVITY_TAB_QUERY_KEY,
  ACTIVITY_TAB_VALUES,
  activityTabQuery,
  DEFAULT_ACTIVITY_TAB,
  isActivityTab,
  isActivityTabVisible,
  resolveActivityTab,
  SLOT_GATED_ACTIVITY_TABS,
  visibleActivityTabs,
} from '~/components/Apps/appsActivityTabs';

/**
 * The `/apps/activity` `?tab=` contract.
 *
 * 🔴 NEW-FEATURE COVERAGE, NOT REGRESSION COVERAGE, and the distinction matters here:
 * there is nothing to be red against at `origin/main` because the tabs were
 * UNCONTROLLED (`<Tabs defaultValue="subscriptions">`) and the query string was never
 * read. The behavioural claim that IS red at `origin/main` — "the page opens on Recent
 * activity, and `?tab=` selects on load" — is asserted in
 * `AppActivityPage.tabs.browser.test.tsx`, which mounts the real page.
 */

describe('the tab ledger', () => {
  it('is the four tabs the page renders, in render order', () => {
    // A ledger, not a floor: a loop over a set nobody pinned passes vacuously when the
    // set shrinks, and this set decides which `?tab=` values are honoured.
    expect([...ACTIVITY_TAB_VALUES]).toEqual([
      'activity',
      'subscriptions',
      'permissions',
      'hidden',
    ]);
  });

  it('🔴 the DEFAULT is the activity feed, not the installs list', () => {
    // The whole point of the rename. `origin/main` opened on `subscriptions`.
    expect(DEFAULT_ACTIVITY_TAB).toBe('activity');
    expect(ACTIVITY_TAB_QUERY_KEY).toBe('tab');
  });
});

describe('isActivityTab', () => {
  it('accepts exactly the ledger', () => {
    for (const value of ACTIVITY_TAB_VALUES) expect(isActivityTab(value)).toBe(true);
  });

  it('🔴 NEGATIVE CONTROL: rejects non-tabs, including prototype keys', () => {
    // Without this the accept loop above could be satisfied by `() => true`. The
    // prototype keys are the `dispatch-table-indexed-with-an-untrusted-key` hazard:
    // `?tab=constructor` is a value any visitor can send.
    for (const value of [
      'installs',
      '',
      'constructor',
      'toString',
      '__proto__',
      undefined,
      null,
      42,
      ['activity'],
    ]) {
      expect(isActivityTab(value), `${String(value)} must not be a tab`).toBe(false);
    }
  });
});

describe('tab visibility', () => {
  const OPEN = { canSeeSlotGatedTabs: true };
  const SLOTLESS = { canSeeSlotGatedTabs: false };

  it('🔴 the slot-gated ledger is exactly the three tabs whose DATA is slot-gated', () => {
    // Pinned as a ledger, not a floor: this set decides what the page renders, which
    // panels mount AND what `?tab=` honours, so a silent addition or removal must fail
    // here first. `permissions` is in it because `blocks.listMyScopeGrants` — the panel's
    // only read — runs `enforceAppBlocksFlag` and returns `[]` without `features.appBlocks`.
    expect([...SLOT_GATED_ACTIVITY_TABS]).toEqual(['subscriptions', 'permissions', 'hidden']);
  });

  it('🔴 `activity` is the ONLY ungated tab', () => {
    // NEGATIVE CONTROL for the ledger: without this, a predicate that gated everything
    // (or nothing) would satisfy the set assertion above.
    expect(isActivityTabVisible('activity', SLOTLESS)).toBe(true);
    for (const tab of SLOT_GATED_ACTIVITY_TABS) {
      expect(isActivityTabVisible(tab, SLOTLESS), `${tab} must be gated`).toBe(false);
      // …and the SAME tab is visible WITH the flag, so the line above cannot be
      // satisfied by a predicate that always returns false.
      expect(isActivityTabVisible(tab, OPEN), `${tab} must be visible with the flag`).toBe(true);
    }
  });

  it('a slot-flag viewer sees every tab; a slotless viewer sees ONE', () => {
    expect([...visibleActivityTabs(OPEN)]).toEqual([...ACTIVITY_TAB_VALUES]);
    expect([...visibleActivityTabs(SLOTLESS)]).toEqual(['activity']);
  });

  it('🔴 THE FLOOR IS 1, AND THE PAGE COLLAPSES ITS BAR THERE', () => {
    // The state the previous round proved unreachable and correctly declined to build a
    // branch for. Gating `permissions` made it reachable, so `activity.tsx` now hides its
    // `Tabs.List` below two visible tabs, mirroring `AppsSubNav`'s `links.length < 2`.
    //
    // 🔴 THIS IS THE TRIPWIRE FOR THAT COLLAPSE. Asserted as an EXACT count, not a
    // `<= 2`: a bound would stay green if a later change put a second tab back and left
    // the collapse as dead code, which is the state this test exists to rule out.
    expect(visibleActivityTabs(SLOTLESS).length).toBe(1);
    // …and the collapse is genuinely CONDITIONAL, not always-on: the flag-holding arm is
    // above the threshold, so the bar must render for them.
    expect(visibleActivityTabs(OPEN).length).toBeGreaterThanOrEqual(2);
  });

  it('every tab has a label, and they are the strings the bar renders', () => {
    // The page maps `visibleActivityTabs` through this record, so a missing or renamed
    // entry is a rendered tab with no name. Pinned literally rather than looped, because
    // a loop over the record's own keys would pass whatever it contains.
    expect(ACTIVITY_TAB_LABELS).toEqual({
      activity: 'Recent activity',
      subscriptions: 'Installs',
      permissions: 'Apps & permissions',
      hidden: 'Hidden',
    });
    for (const tab of ACTIVITY_TAB_VALUES) {
      expect(ACTIVITY_TAB_LABELS[tab], `${tab} needs a label`).toBeTruthy();
    }
  });

  it('🔴 the DEFAULT tab is visible to EVERY viewer — the fallback must land somewhere', () => {
    // `resolveActivityTab` returns `DEFAULT_ACTIVITY_TAB` for a tab the viewer cannot
    // see. If the default were itself gated, the fallback would hand Mantine a value
    // absent from the rendered list: the exact blank page it exists to prevent.
    for (const opts of [OPEN, SLOTLESS]) {
      expect(isActivityTabVisible(DEFAULT_ACTIVITY_TAB, opts)).toBe(true);
    }
  });
});

describe('resolveActivityTab', () => {
  const OPEN = { canSeeSlotGatedTabs: true };
  const SLOTLESS = { canSeeSlotGatedTabs: false };

  it('an absent / unknown / prototype-key value falls back to the default', () => {
    for (const raw of [undefined, null, '', 'nope', 'constructor', '__proto__', 7]) {
      expect(resolveActivityTab(raw, OPEN)).toBe('activity');
    }
  });

  it('🔴 a known tab is honoured — the deep link actually selects', () => {
    // NEGATIVE CONTROL for the fallback above: a resolver that always returned the
    // default would satisfy every case in the previous test.
    expect(resolveActivityTab('permissions', OPEN)).toBe('permissions');
    expect(resolveActivityTab('hidden', OPEN)).toBe('hidden');
    expect(resolveActivityTab('subscriptions', OPEN)).toBe('subscriptions');
  });

  it('takes the FIRST entry of a repeated query key rather than choking on the array', () => {
    // Next hands back `string[]` for `?tab=a&tab=b`. Handing an array to `Tabs.value`
    // selects nothing and renders an empty panel under a bar with no active tab.
    expect(resolveActivityTab(['permissions', 'hidden'], OPEN)).toBe('permissions');
    expect(resolveActivityTab([], OPEN)).toBe('activity');
  });

  it('🔴 `?tab=subscriptions` falls back for a viewer WITHOUT the slot flag', () => {
    // That tab is not rendered for them, so selecting it would leave the bar with no
    // active tab over an empty panel — a blank page with no error. This is a link a
    // page-only viewer can legitimately receive.
    //
    // 🔴 RED AT `origin/main` FOR `hidden`: the resolver tested `first ===
    // 'subscriptions'` by NAME, so gating `hidden` shipped precisely that blank page.
    // Looping the ledger is what keeps this honest when a third tab is gated.
    for (const tab of SLOT_GATED_ACTIVITY_TABS) {
      expect(resolveActivityTab(tab, SLOTLESS), `${tab} must fall back`).toBe('activity');
      // NEGATIVE CONTROL: with the flag, the SAME value is honoured — so the assertion
      // above cannot be satisfied by a resolver that always returns the default.
      expect(resolveActivityTab(tab, OPEN), `${tab} must be honoured`).toBe(tab);
    }
    // …and the UNGATED tab is unaffected by that flag — the fallback is scoped to the
    // ledger, not applied to everything.
    expect(resolveActivityTab('activity', SLOTLESS)).toBe('activity');
  });
});

describe('activityTabQuery', () => {
  it('🔴 the DEFAULT tab drops the key rather than writing ?tab=activity', () => {
    expect(activityTabQuery('activity', { tab: 'hidden' })).toEqual({});
    expect(activityTabQuery('activity')).toEqual({});
  });

  it('a non-default tab writes the key', () => {
    expect(activityTabQuery('permissions')).toEqual({ tab: 'permissions' });
  });

  it('🔴 preserves every OTHER key on the route, in both directions', () => {
    // This function owns ONE key. A spread that dropped the rest would silently discard
    // whatever a future filter puts there.
    expect(activityTabQuery('hidden', { foo: 'bar', tab: 'permissions' })).toEqual({
      foo: 'bar',
      tab: 'hidden',
    });
    expect(activityTabQuery('activity', { foo: 'bar', tab: 'permissions' })).toEqual({
      foo: 'bar',
    });
  });

  it('does not mutate the query object it was handed', () => {
    const current = { tab: 'permissions', foo: 'bar' };
    activityTabQuery('activity', current);
    expect(current).toEqual({ tab: 'permissions', foo: 'bar' });
  });
});
