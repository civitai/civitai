import { describe, expect, it } from 'vitest';

import {
  INACTIVE_LISTING_STATUSES,
  INACTIVE_PAGE_SIZE,
  isInactiveListing,
  MY_APPS_CONTAINER_SIZE,
  myAppListingHref,
  pageCount,
  pageSlice,
  partitionMyAppRows,
  sortByRecentlyUpdated,
} from '~/components/Apps/myAppsView';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';

/**
 * `/apps/mine` view-model — the merged author table's partition, order and pagination.
 *
 * 🔴 THIS FILE IS IN THE **`unit`** PROJECT ON PURPOSE. The browser-mode `component`
 * project is report-only and gates nothing; `unit` is the tier whose verdict is read. The
 * rule this pins — which listing statuses are "inactive" — is pure logic, so it belongs
 * where it can actually block.
 *
 * Every fixture below uses a status/kind pair that is DISTINCT from every other fixture's
 * and from any literal an assertion names, so a mutant that hardcodes one of those literals
 * cannot survive by coincidence.
 */

type Row = { appListingId: string; status: string; updatedAt: string | Date };

const row = (appListingId: string, status: string, updatedAt: string): Row => ({
  appListingId,
  status,
  updatedAt,
});

describe('isInactiveListing — the LISTING-level terminal states, and only those', () => {
  it('the declared set is exactly {rejected, removed}', () => {
    // A value pin: the set IS the product decision, so growing or shrinking it silently is
    // the failure this catches.
    expect([...INACTIVE_LISTING_STATUSES].sort()).toEqual(['rejected', 'removed']);
  });

  it('rejected is inactive', () => {
    expect(isInactiveListing('rejected')).toBe(true);
  });

  it('removed is inactive', () => {
    expect(isInactiveListing('removed')).toBe(true);
  });

  it('draft is ACTIVE — it belongs in the main table, not the collapse', () => {
    expect(isInactiveListing('draft')).toBe(false);
  });

  it('pending is ACTIVE', () => {
    expect(isInactiveListing('pending')).toBe(false);
  });

  it('approved is ACTIVE', () => {
    expect(isInactiveListing('approved')).toBe(false);
  });

  /**
   * 🔴 THE CORE INVARIANT OF THE MERGE, stated as its own case so a mutant that adds
   * `'withdrawn'` to the set dies HERE, by name, rather than by tripping some neighbouring
   * assertion about draft or pending.
   *
   * `withdrawn` exists ONLY in the publish-request enum. `app_listings.status` cannot hold
   * it. A `withdrawn` submission is an event on an app; it says nothing about whether the
   * app is live, and an app whose owner withdrew one request is very often `approved` and
   * serving users. Treating it as a listing state would file healthy apps under "Inactive"
   * where they are collapsed away from their own owner by default.
   */
  it('🔴 withdrawn is NOT a listing status and must never partition an app as inactive', () => {
    expect(isInactiveListing('withdrawn')).toBe(false);
    expect(INACTIVE_LISTING_STATUSES as readonly string[]).not.toContain('withdrawn');
  });

  it('an unknown status is ACTIVE — fail OPEN, so a new state is visible not hidden', () => {
    expect(isInactiveListing('quarantined')).toBe(false);
  });
});

describe('partitionMyAppRows', () => {
  it('sends only the two terminal statuses to the collapse and keeps the rest in the table', () => {
    const rows = [
      row('apl_draft', 'draft', '2026-08-05T00:00:00Z'),
      row('apl_removed', 'removed', '2026-08-04T00:00:00Z'),
      row('apl_pending', 'pending', '2026-08-03T00:00:00Z'),
      row('apl_rejected', 'rejected', '2026-08-02T00:00:00Z'),
      row('apl_approved', 'approved', '2026-08-01T00:00:00Z'),
    ];
    const { active, inactive } = partitionMyAppRows(rows);
    expect(active.map((r) => r.appListingId)).toEqual(['apl_draft', 'apl_pending', 'apl_approved']);
    expect(inactive.map((r) => r.appListingId)).toEqual(['apl_removed', 'apl_rejected']);
  });

  /**
   * 🔴 DECISION #2, as a behavioural case. The partition reads the LISTING row and nothing
   * else — a row carrying a withdrawn (or rejected) SUBMISSION on an approved app stays
   * ACTIVE. The extra fields are here precisely so a partition that started consulting
   * history would fail.
   */
  it('🔴 an APPROVED app whose latest submission was withdrawn stays ACTIVE', () => {
    const rows = [
      {
        ...row('apl_live', 'approved', '2026-08-07T00:00:00Z'),
        latestSubmissionStatus: 'withdrawn',
      },
      { ...row('apl_gone', 'removed', '2026-08-06T00:00:00Z'), latestSubmissionStatus: 'approved' },
    ];
    const { active, inactive } = partitionMyAppRows(rows);
    expect(active.map((r) => r.appListingId)).toEqual(['apl_live']);
    expect(inactive.map((r) => r.appListingId)).toEqual(['apl_gone']);
  });

  it('preserves the incoming order within each group', () => {
    const rows = [
      row('c', 'approved', '2026-01-03T00:00:00Z'),
      row('a', 'approved', '2026-01-01T00:00:00Z'),
      row('b', 'approved', '2026-01-02T00:00:00Z'),
    ];
    expect(partitionMyAppRows(rows).active.map((r) => r.appListingId)).toEqual(['c', 'a', 'b']);
  });

  it('an empty input yields two empty groups, not undefined', () => {
    expect(partitionMyAppRows([])).toEqual({ active: [], inactive: [] });
  });
});

describe('sortByRecentlyUpdated', () => {
  it('orders newest-updated first regardless of the input order', () => {
    const rows = [
      row('mid', 'pending', '2026-03-15T12:00:00Z'),
      row('newest', 'draft', '2026-07-01T09:30:00Z'),
      row('oldest', 'approved', '2025-11-20T23:59:00Z'),
    ];
    expect(sortByRecentlyUpdated(rows).map((r) => r.appListingId)).toEqual([
      'newest',
      'mid',
      'oldest',
    ]);
  });

  it('accepts Date as well as ISO string', () => {
    const rows = [
      { appListingId: 'str', status: 'draft', updatedAt: '2026-02-01T00:00:00Z' },
      { appListingId: 'date', status: 'draft', updatedAt: new Date('2026-06-01T00:00:00Z') },
    ];
    expect(sortByRecentlyUpdated(rows).map((r) => r.appListingId)).toEqual(['date', 'str']);
  });

  it('breaks a tie by id so the order is stable across renders', () => {
    const rows = [
      row('zeta', 'pending', '2026-05-05T00:00:00Z'),
      row('alpha', 'removed', '2026-05-05T00:00:00Z'),
    ];
    expect(sortByRecentlyUpdated(rows).map((r) => r.appListingId)).toEqual(['alpha', 'zeta']);
  });

  it('an unparseable timestamp sorts LAST rather than poisoning the comparator', () => {
    const rows = [row('bad', 'draft', 'not-a-date'), row('good', 'draft', '2026-04-04T00:00:00Z')];
    expect(sortByRecentlyUpdated(rows).map((r) => r.appListingId)).toEqual(['good', 'bad']);
  });

  it('does not mutate its input', () => {
    const rows = [
      row('second', 'draft', '2026-01-01T00:00:00Z'),
      row('first', 'draft', '2026-09-09T00:00:00Z'),
    ];
    sortByRecentlyUpdated(rows);
    expect(rows.map((r) => r.appListingId)).toEqual(['second', 'first']);
  });
});

describe('Inactive collapse pagination', () => {
  it('the page size is a positive integer', () => {
    expect(Number.isInteger(INACTIVE_PAGE_SIZE)).toBe(true);
    expect(INACTIVE_PAGE_SIZE).toBeGreaterThan(0);
  });

  it('pageCount is never 0 — the control always has a page to be on', () => {
    expect(pageCount(0, 4)).toBe(1);
  });

  it('pageCount rounds UP on a partial last page', () => {
    // 9 over a page size of 4 is 3 pages (4 + 4 + 1) — the boundary a floor would drop.
    expect(pageCount(9, 4)).toBe(3);
    expect(pageCount(8, 4)).toBe(2);
  });

  it('pageSlice returns exactly one page, at the right offset', () => {
    const rows = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
    expect(pageSlice(rows, 1, 3)).toEqual(['r1', 'r2', 'r3']);
    expect(pageSlice(rows, 2, 3)).toEqual(['r4', 'r5', 'r6']);
  });

  it('🔴 the LAST page is the short one, not an empty one', () => {
    const rows = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
    expect(pageSlice(rows, 3, 3)).toEqual(['r7']);
  });

  it('a page past the end CLAMPS to the last page instead of stranding the user on blank', () => {
    const rows = ['r1', 'r2', 'r3', 'r4', 'r5'];
    expect(pageSlice(rows, 99, 2)).toEqual(['r5']);
  });

  it('a page below 1 clamps to the first page', () => {
    const rows = ['r1', 'r2', 'r3'];
    expect(pageSlice(rows, 0, 2)).toEqual(['r1', 'r2']);
  });
});

describe('myAppListingHref — per-row, per-kind, never one flat link', () => {
  it('an ON-SITE row with a block lands on the listing-keyed editor', () => {
    expect(
      myAppListingHref({
        appListingId: 'apl_on',
        kind: 'onsite',
        appBlockId: 'ab_9',
        role: 'owner',
        capabilities: capabilitiesForKind('onsite'),
      })
    ).toBe('/apps/listing/apl_on/edit?tab=details');
  });

  it('an OFF-SITE row (no block) still lands on the SAME canonical route', () => {
    // Listing-keyed, not block-keyed: an off-site listing has no block id to build a
    // `/apps/<appBlockId>/…` href with at all.
    expect(
      myAppListingHref({
        appListingId: 'apl_off',
        kind: 'offsite',
        appBlockId: null,
        role: 'editor',
        capabilities: capabilitiesForKind('offsite'),
      })
    ).toBe('/apps/listing/apl_off/edit?tab=details');
  });

  it('the listing id is URL-encoded', () => {
    expect(
      myAppListingHref({
        appListingId: 'apl a/b',
        kind: 'onsite',
        appBlockId: 'ab_1',
        role: 'owner',
        capabilities: capabilitiesForKind('onsite'),
      })
    ).toContain('/apps/listing/apl%20a%2Fb/edit');
  });
});

describe('MY_APPS_CONTAINER_SIZE', () => {
  it('is a raw px number, not a Mantine size token (tokens cap at xl = 1320)', () => {
    expect(typeof MY_APPS_CONTAINER_SIZE).toBe('number');
    expect(Number.isFinite(MY_APPS_CONTAINER_SIZE)).toBe(true);
  });

  it('is wider than the readable/form width the page used before the merge', () => {
    // The page went from a single-column card list to a two-image table when it absorbed
    // /apps/my-submissions; 1100 is the width that made the old submissions table clip.
    expect(MY_APPS_CONTAINER_SIZE).toBeGreaterThan(1100);
  });
});
