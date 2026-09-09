import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_TAB_QUERY_KEY,
  ACTIVITY_TAB_VALUES,
  activityTabQuery,
  DEFAULT_ACTIVITY_TAB,
  INSTALL_GATED_ACTIVITY_TABS,
  isActivityTab,
  isActivityTabVisible,
  resolveActivityTab,
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
  const OPEN = { canSeeInstallOnlyTabs: true };
  const SLOTLESS = { canSeeInstallOnlyTabs: false };

  it('🔴 the install-gated ledger is exactly the two SLOT-INSTALL tabs', () => {
    // Pinned as a ledger, not a floor: this set decides both what the page renders AND
    // what `?tab=` honours, so a silent addition or removal must fail here first.
    expect([...INSTALL_GATED_ACTIVITY_TABS]).toEqual(['subscriptions', 'hidden']);
  });

  it('🔴 `permissions` is NOT gated — the consent/audit surface stays reachable', () => {
    // A full-page app (`appBlocksPages`) invokes scopes with no install row, so a
    // page-only viewer has grants to read and revoke here. This is the deliberate
    // asymmetry with the two tabs above; do not unify the predicates.
    expect(isActivityTabVisible('permissions', SLOTLESS)).toBe(true);
    expect(isActivityTabVisible('activity', SLOTLESS)).toBe(true);
  });

  it('a slot-flag viewer sees every tab; a page-only viewer sees the ungated two', () => {
    expect([...visibleActivityTabs(OPEN)]).toEqual([...ACTIVITY_TAB_VALUES]);
    expect([...visibleActivityTabs(SLOTLESS)]).toEqual(['activity', 'permissions']);
  });

  it('🔴 THE FLOOR IS 2 — which is why the page has no `< 2` bar collapse', () => {
    // `AppsSubNav` hides its bar below two rows. This bar has no such branch because
    // the state is unreachable: `activity` and `permissions` are both ungated, and the
    // page 404s (`canAccessAppsActivity`) for anyone holding neither runtime flag. A
    // collapse would be a branch that can never execute — coverage-shaped and inert.
    //
    // 🔴 THIS TEST IS THE TRIPWIRE. Gate `permissions` (or `activity`) and the floor
    // drops to 1, this goes red, and the collapse becomes real, reachable work.
    for (const opts of [OPEN, SLOTLESS]) {
      expect(visibleActivityTabs(opts).length).toBeGreaterThanOrEqual(2);
    }
    // …and the minimum is exactly 2, not vacuously large: naming it pins WHICH viewer
    // is the worst case, so a later gate cannot pass by shrinking a different arm.
    expect(visibleActivityTabs(SLOTLESS).length).toBe(2);
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
  const OPEN = { canSeeInstallOnlyTabs: true };
  const SLOTLESS = { canSeeInstallOnlyTabs: false };

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
    for (const tab of INSTALL_GATED_ACTIVITY_TABS) {
      expect(resolveActivityTab(tab, SLOTLESS), `${tab} must fall back`).toBe('activity');
      // NEGATIVE CONTROL: with the flag, the SAME value is honoured — so the assertion
      // above cannot be satisfied by a resolver that always returns the default.
      expect(resolveActivityTab(tab, OPEN), `${tab} must be honoured`).toBe(tab);
    }
    // …and the UNGATED tabs are unaffected by that flag — the fallback is scoped to the
    // ledger, not applied to everything.
    expect(resolveActivityTab('permissions', SLOTLESS)).toBe('permissions');
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
