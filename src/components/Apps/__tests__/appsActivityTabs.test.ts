import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_TAB_QUERY_KEY,
  ACTIVITY_TAB_VALUES,
  activityTabQuery,
  DEFAULT_ACTIVITY_TAB,
  isActivityTab,
  resolveActivityTab,
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

describe('resolveActivityTab', () => {
  const OPEN = { canSeeInstalls: true };
  const SLOTLESS = { canSeeInstalls: false };

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
    expect(resolveActivityTab('subscriptions', SLOTLESS)).toBe('activity');
    // …and the OTHER tabs are unaffected by that flag — the fallback is scoped to the
    // gated tab, not applied to everything.
    expect(resolveActivityTab('permissions', SLOTLESS)).toBe('permissions');
    expect(resolveActivityTab('hidden', SLOTLESS)).toBe('hidden');
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
