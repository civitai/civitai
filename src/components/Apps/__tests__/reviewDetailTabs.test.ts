import { describe, expect, test } from 'vitest';
import {
  DEFAULT_REVIEW_DETAIL_TAB,
  isReviewDetailTab,
  resolveReviewDetailTab,
  REVIEW_DETAIL_TAB_LABELS,
  REVIEW_DETAIL_TAB_QUERY_KEY,
  REVIEW_DETAIL_TAB_VALUES,
  reviewDetailTabQuery,
  type ReviewDetailTab,
} from '~/components/Apps/reviewDetailTabs';

/**
 * The review PAGE's `?tab=` contract, in the node-env `unit` project.
 *
 * This is the BLOCKING half of the tab coverage: the browser tier that renders the bar is
 * report-only in CI, so the rules that decide WHICH tab a URL selects are pinned here where
 * a failure actually stops something.
 */

describe('the tab set', () => {
  test('🔴 is exactly these five, in this order (fails when it GROWS or SHRINKS)', () => {
    // A ledger, not a floor. Every derivation below maps over this list, so a set that
    // silently changed would move the default, the labels and the fallbacks with it.
    expect([...REVIEW_DETAIL_TAB_VALUES]).toEqual([
      'permissions',
      'code',
      'agent',
      'manifest',
      'preview',
    ]);
  });

  test('🔴 PERMISSIONS IS THE DEFAULT — the whole point of the redesign', () => {
    expect(DEFAULT_REVIEW_DETAIL_TAB).toBe('permissions');
    // …and it is the FIRST tab, so the bar's reading order matches what a bare URL opens.
    expect(REVIEW_DETAIL_TAB_VALUES[0]).toBe('permissions');
  });

  test('every tab has a label, and no two share one', () => {
    const labels = REVIEW_DETAIL_TAB_VALUES.map((t) => REVIEW_DETAIL_TAB_LABELS[t]);
    expect(labels.every((l) => typeof l === 'string' && l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('isReviewDetailTab accepts members and rejects everything else', () => {
    for (const tab of REVIEW_DETAIL_TAB_VALUES) expect(isReviewDetailTab(tab)).toBe(true);
    for (const junk of ['', 'summary', 'Permissions', 0, null, undefined, {}, ['code']]) {
      expect(isReviewDetailTab(junk)).toBe(false);
    }
  });
});

describe('resolveReviewDetailTab', () => {
  test('a known value selects that tab', () => {
    for (const tab of REVIEW_DETAIL_TAB_VALUES) {
      expect(resolveReviewDetailTab(tab)).toBe(tab);
    }
  });

  test('🔴 absent / empty / unknown all fall back to the default, never to nothing', () => {
    // Handing an unrecognised value to `Tabs.value` selects a tab that is not in the list,
    // and Mantine then renders a bar with nothing active over an EMPTY PANEL — a blank page
    // with no error. Falling back is the only outcome that is a page.
    expect(resolveReviewDetailTab(undefined)).toBe(DEFAULT_REVIEW_DETAIL_TAB);
    expect(resolveReviewDetailTab('')).toBe(DEFAULT_REVIEW_DETAIL_TAB);
    expect(resolveReviewDetailTab('summary')).toBe(DEFAULT_REVIEW_DETAIL_TAB);
    expect(resolveReviewDetailTab('PERMISSIONS')).toBe(DEFAULT_REVIEW_DETAIL_TAB);
    expect(resolveReviewDetailTab(null)).toBe(DEFAULT_REVIEW_DETAIL_TAB);
    expect(resolveReviewDetailTab(7)).toBe(DEFAULT_REVIEW_DETAIL_TAB);
  });

  test('🔴 a REPEATED key arrives as an array — the first entry wins, not the array', () => {
    // Next hands back `string | string[]`, and a component that assumed `string` would put
    // an array into `Tabs.value` and render no active tab at all.
    expect(resolveReviewDetailTab(['code', 'manifest'])).toBe('code');
    // An array whose first entry is junk still falls back rather than selecting nothing.
    expect(resolveReviewDetailTab(['nope', 'code'])).toBe(DEFAULT_REVIEW_DETAIL_TAB);
    expect(resolveReviewDetailTab([])).toBe(DEFAULT_REVIEW_DETAIL_TAB);
  });

  describe('the report-hash fallback (keeps the existing per-finding deep links working)', () => {
    test('🔴 a `#finding-<tab>-<n>` anchor resolves the OUTER tab to `agent`', () => {
      // `ReportTabs` ships a copy-link affordance producing exactly these URLs. Once the
      // agent report moved behind a non-default tab, such a link landed on Permissions and
      // the finding it names was not on screen at all.
      expect(resolveReviewDetailTab(undefined, { hash: '#finding-security-2' })).toBe('agent');
      expect(resolveReviewDetailTab(undefined, { hash: '#finding-code-0' })).toBe('agent');
    });

    test('a bare report-tab hash does too', () => {
      for (const h of ['#scopes', '#security', '#code']) {
        expect(resolveReviewDetailTab(undefined, { hash: h })).toBe('agent');
      }
    });

    test('🔴 NEGATIVE CONTROL: a hash the report renderer does not recognise changes nothing', () => {
      // Without this the `agent` answers above are satisfied by a resolver that returns
      // `agent` for ANY non-empty hash.
      expect(resolveReviewDetailTab(undefined, { hash: '#top' })).toBe(DEFAULT_REVIEW_DETAIL_TAB);
      expect(resolveReviewDetailTab(undefined, { hash: '#finding-scopes-1' })).toBe(
        DEFAULT_REVIEW_DETAIL_TAB
      );
      expect(resolveReviewDetailTab(undefined, { hash: '' })).toBe(DEFAULT_REVIEW_DETAIL_TAB);
      expect(resolveReviewDetailTab(undefined, {})).toBe(DEFAULT_REVIEW_DETAIL_TAB);
    });

    test('🔴 an explicit `?tab=` WINS over the hash — it is the more specific instruction', () => {
      expect(resolveReviewDetailTab('manifest', { hash: '#finding-security-2' })).toBe('manifest');
      // …and an UNKNOWN `?tab=` does not win: it is not an instruction at all, so the hash
      // still gets its say rather than both being discarded.
      expect(resolveReviewDetailTab('no-such-tab', { hash: '#finding-security-2' })).toBe('agent');
    });
  });
});

describe('reviewDetailTabQuery', () => {
  const ROUTE = { publishRequestId: 'pubreq_01ABC' } as const;

  test('🔴 the DYNAMIC ROUTE PARAM SURVIVES — without it the replace targets a literal segment', () => {
    // `/apps/review/[publishRequestId]` is interpolated FROM the query, so a spread that
    // dropped `publishRequestId` would navigate to a path containing the bracket name.
    for (const tab of REVIEW_DETAIL_TAB_VALUES) {
      expect(reviewDetailTabQuery(tab, { ...ROUTE }).publishRequestId).toBe('pubreq_01ABC');
    }
  });

  test('a non-default tab writes the key', () => {
    expect(reviewDetailTabQuery('code', { ...ROUTE })).toEqual({
      publishRequestId: 'pubreq_01ABC',
      tab: 'code',
    });
  });

  test('🔴 the DEFAULT tab DROPS the key rather than writing `?tab=permissions`', () => {
    // The canonical URL for the page's own default is the bare route; otherwise every
    // arrival that touches a tab and comes back leaves a redundant parameter behind, in the
    // address bar and in anything that copies it.
    expect(reviewDetailTabQuery(DEFAULT_REVIEW_DETAIL_TAB, { ...ROUTE, tab: 'code' })).toEqual({
      publishRequestId: 'pubreq_01ABC',
    });
    expect(
      REVIEW_DETAIL_TAB_QUERY_KEY in reviewDetailTabQuery(DEFAULT_REVIEW_DETAIL_TAB, { ...ROUTE })
    ).toBe(false);
  });

  test('other keys on the route are preserved untouched', () => {
    expect(reviewDetailTabQuery('agent', { ...ROUTE, from: 'queue' })).toEqual({
      publishRequestId: 'pubreq_01ABC',
      from: 'queue',
      tab: 'agent',
    });
  });

  test('it does not mutate the query it was given', () => {
    const current: Record<string, string> = { ...ROUTE, tab: 'code' };
    reviewDetailTabQuery('permissions', current);
    expect(current.tab).toBe('code');
  });

  test('🔴 ROUND TRIP: every tab survives query → resolve', () => {
    // The pair is what the page actually does; testing either alone can pass while the two
    // disagree about the default-drops-the-key rule.
    for (const tab of REVIEW_DETAIL_TAB_VALUES as readonly ReviewDetailTab[]) {
      const q = reviewDetailTabQuery(tab, { ...ROUTE });
      expect(resolveReviewDetailTab(q[REVIEW_DETAIL_TAB_QUERY_KEY])).toBe(tab);
    }
  });
});
