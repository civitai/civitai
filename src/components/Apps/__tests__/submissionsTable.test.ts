import { describe, expect, it } from 'vitest';
import {
  ariaSortFor,
  compareDate,
  compareStatus,
  compareText,
  currentlyPublishedVersionId,
  filterGroups,
  groupSubmissionsByApp,
  matchesQuery,
  nextSortState,
  sortGroups,
  statusRank,
  toDate,
  type SortState,
  type SubmissionAccessors,
} from '~/components/Apps/submissionsTable';

/**
 * W13 — /apps/my-submissions table view-model logic (shared by the onsite +
 * offsite lists). Pins the column comparators, the case-insensitive name/slug
 * filter, and the per-app version-collapse so filter/sort/group can't drift and
 * are provable without mounting a table.
 */

// A minimal row shape covering both lists' needs for these pure helpers.
type Row = {
  id: string;
  identity: string;
  name: string;
  slug: string;
  status: string;
  submittedAt: string | Date | null;
  reviewedAt: string | Date | null;
};

const A: SubmissionAccessors<Row> = {
  identity: (r) => r.identity,
  name: (r) => r.name,
  slug: (r) => r.slug,
  status: (r) => r.status,
  submittedAt: (r) => toDate(r.submittedAt),
  reviewedAt: (r) => toDate(r.reviewedAt),
};

function row(overrides: Partial<Row>): Row {
  return {
    id: 'r',
    identity: 'app',
    name: 'App',
    slug: 'app',
    status: 'pending',
    submittedAt: '2026-01-01T00:00:00Z',
    reviewedAt: null,
    ...overrides,
  };
}

describe('statusRank / compareStatus — pending → approved → rejected → withdrawn', () => {
  it('ranks the known statuses in the intended order', () => {
    expect(statusRank('pending')).toBeLessThan(statusRank('approved'));
    expect(statusRank('approved')).toBeLessThan(statusRank('rejected'));
    expect(statusRank('rejected')).toBeLessThan(statusRank('withdrawn'));
  });

  it('an unknown status ranks after all known ones', () => {
    expect(statusRank('weird')).toBeGreaterThan(statusRank('withdrawn'));
  });

  it('compareStatus orders by rank', () => {
    expect(compareStatus('pending', 'approved')).toBeLessThan(0);
    expect(compareStatus('withdrawn', 'pending')).toBeGreaterThan(0);
    expect(compareStatus('approved', 'approved')).toBe(0);
  });
});

describe('compareText — case-insensitive', () => {
  it('sorts alphabetically ignoring case', () => {
    expect(compareText('alpha', 'Beta')).toBeLessThan(0);
    expect(compareText('Zed', 'apple')).toBeGreaterThan(0);
    expect(compareText('Same', 'same')).toBe(0);
  });
});

describe('compareDate — nulls sort as oldest', () => {
  it('orders older before newer', () => {
    expect(compareDate(new Date('2026-01-01'), new Date('2026-02-01'))).toBeLessThan(0);
    expect(compareDate(new Date('2026-03-01'), new Date('2026-02-01'))).toBeGreaterThan(0);
  });

  it('a null date sorts as the oldest (before any real date)', () => {
    expect(compareDate(null, new Date('2026-01-01'))).toBeLessThan(0);
    expect(compareDate(new Date('2026-01-01'), null)).toBeGreaterThan(0);
    expect(compareDate(null, null)).toBe(0);
  });
});

describe('matchesQuery — name OR slug, case-insensitive substring', () => {
  it('matches on the name', () => {
    expect(matchesQuery('My Cool App', 'other-slug', 'cool')).toBe(true);
  });

  it('matches on the slug', () => {
    expect(matchesQuery('Name', 'vitrine-tool', 'VITRINE')).toBe(true);
  });

  it('is case-insensitive on both sides', () => {
    expect(matchesQuery('ALPHA', 'beta', 'alp')).toBe(true);
  });

  it('does not match when neither contains the query', () => {
    expect(matchesQuery('Alpha', 'beta', 'zzz')).toBe(false);
  });

  it('an empty/whitespace query matches everything', () => {
    expect(matchesQuery('x', 'y', '')).toBe(true);
    expect(matchesQuery('x', 'y', '   ')).toBe(true);
  });
});

describe('groupSubmissionsByApp — version collapse', () => {
  it('collapses multiple versions of one app; latest = newest by submittedAt', () => {
    const rows = [
      row({ id: 'v1', identity: 'app', submittedAt: '2026-01-01T00:00:00Z' }),
      row({ id: 'v3', identity: 'app', submittedAt: '2026-03-01T00:00:00Z' }),
      row({ id: 'v2', identity: 'app', submittedAt: '2026-02-01T00:00:00Z' }),
    ];
    const groups = groupSubmissionsByApp(rows, A.identity, A.submittedAt);
    expect(groups).toHaveLength(1);
    expect(groups[0].versionCount).toBe(3);
    expect(groups[0].latest.id).toBe('v3'); // newest
    expect(groups[0].older.map((r) => r.id)).toEqual(['v2', 'v1']); // newest-first
  });

  it('a single-version app yields one group with no older versions', () => {
    const groups = groupSubmissionsByApp(
      [row({ id: 'only', identity: 'solo' })],
      A.identity,
      A.submittedAt
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].versionCount).toBe(1);
    expect(groups[0].older).toEqual([]);
  });

  it('groups distinct apps separately, preserving first-seen order', () => {
    const rows = [
      row({ id: 'b1', identity: 'bravo' }),
      row({ id: 'a1', identity: 'alpha' }),
      row({ id: 'a2', identity: 'alpha', submittedAt: '2026-05-01T00:00:00Z' }),
    ];
    const groups = groupSubmissionsByApp(rows, A.identity, A.submittedAt);
    expect(groups.map((g) => g.identity)).toEqual(['bravo', 'alpha']);
    expect(groups[1].versionCount).toBe(2);
    expect(groups[1].latest.id).toBe('a2');
  });

  it('supports mixed onsite (block id) + offsite (slug) identity keys', () => {
    // Onsite rows key by an app-block id, offsite by slug — both are just strings
    // here, so distinct keys never collide across the two lists.
    const rows = [
      row({ id: 'onsite-1', identity: 'block-123' }),
      row({ id: 'offsite-1', identity: 'my-slug' }),
      row({ id: 'onsite-2', identity: 'block-123', submittedAt: '2026-06-01T00:00:00Z' }),
    ];
    const groups = groupSubmissionsByApp(rows, A.identity, A.submittedAt);
    expect(groups).toHaveLength(2);
    const block = groups.find((g) => g.identity === 'block-123');
    expect(block?.versionCount).toBe(2);
    expect(block?.latest.id).toBe('onsite-2');
    expect(groups.find((g) => g.identity === 'my-slug')?.versionCount).toBe(1);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', identity: 'app', submittedAt: '2026-09-01' })];
    const snapshot = rows.map((r) => r.id);
    groupSubmissionsByApp(rows, A.identity, A.submittedAt);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });
});

describe('filterGroups — matches if ANY version matches', () => {
  const groups = groupSubmissionsByApp(
    [
      row({ id: 'v1', identity: 'app', name: 'Old Name', slug: 'app', submittedAt: '2026-01-01' }),
      row({ id: 'v2', identity: 'app', name: 'New Name', slug: 'app', submittedAt: '2026-02-01' }),
      row({ id: 'other', identity: 'other', name: 'Other', slug: 'other-slug' }),
    ],
    A.identity,
    A.submittedAt
  );

  it('keeps a group when an OLDER version matches (not just the latest)', () => {
    const result = filterGroups(groups, 'Old Name', A);
    expect(result).toHaveLength(1);
    expect(result[0].identity).toBe('app');
  });

  it('filters out a group when no version matches', () => {
    expect(filterGroups(groups, 'Other', A).map((g) => g.identity)).toEqual(['other']);
  });

  it('an empty query returns all groups', () => {
    expect(filterGroups(groups, '', A)).toHaveLength(2);
  });
});

describe('sortGroups — by the latest version of each group', () => {
  const groups = groupSubmissionsByApp(
    [
      row({
        id: 'a',
        identity: 'alpha',
        name: 'Alpha',
        status: 'approved',
        submittedAt: '2026-02-01',
        reviewedAt: '2026-02-05',
      }),
      row({
        id: 'b',
        identity: 'bravo',
        name: 'Bravo',
        status: 'pending',
        submittedAt: '2026-01-01',
        reviewedAt: null,
      }),
    ],
    A.identity,
    A.submittedAt
  );

  const ids = (s: SortState) => sortGroups(groups, s, A).map((g) => g.identity);

  it('sorts by App text asc/desc', () => {
    expect(ids({ column: 'app', direction: 'asc' })).toEqual(['alpha', 'bravo']);
    expect(ids({ column: 'app', direction: 'desc' })).toEqual(['bravo', 'alpha']);
  });

  it('sorts by Status enum order asc/desc (pending before approved)', () => {
    expect(ids({ column: 'status', direction: 'asc' })).toEqual(['bravo', 'alpha']);
    expect(ids({ column: 'status', direction: 'desc' })).toEqual(['alpha', 'bravo']);
  });

  it('sorts by Submitted date asc/desc', () => {
    expect(ids({ column: 'submitted', direction: 'asc' })).toEqual(['bravo', 'alpha']);
    expect(ids({ column: 'submitted', direction: 'desc' })).toEqual(['alpha', 'bravo']);
  });

  it('sorts by Reviewed date, unreviewed (null) as oldest', () => {
    // bravo has null reviewedAt (sorts oldest); alpha has a real date.
    expect(ids({ column: 'reviewed', direction: 'asc' })).toEqual(['bravo', 'alpha']);
    expect(ids({ column: 'reviewed', direction: 'desc' })).toEqual(['alpha', 'bravo']);
  });

  it('does not mutate the input group array', () => {
    const before = groups.map((g) => g.identity);
    sortGroups(groups, { column: 'app', direction: 'desc' }, A);
    expect(groups.map((g) => g.identity)).toEqual(before);
  });
});

describe('nextSortState — header-click toggle', () => {
  it('toggles direction when the same column is clicked', () => {
    expect(nextSortState({ column: 'app', direction: 'asc' }, 'app')).toEqual({
      column: 'app',
      direction: 'desc',
    });
    expect(nextSortState({ column: 'app', direction: 'desc' }, 'app')).toEqual({
      column: 'app',
      direction: 'asc',
    });
  });

  it('switches column with a sensible default direction (text asc, date desc)', () => {
    expect(nextSortState({ column: 'app', direction: 'asc' }, 'status')).toEqual({
      column: 'status',
      direction: 'asc',
    });
    expect(nextSortState({ column: 'app', direction: 'asc' }, 'submitted')).toEqual({
      column: 'submitted',
      direction: 'desc',
    });
    expect(nextSortState({ column: 'app', direction: 'asc' }, 'reviewed')).toEqual({
      column: 'reviewed',
      direction: 'desc',
    });
  });
});

describe('ariaSortFor', () => {
  it('reports the direction for the active column, none otherwise', () => {
    const s: SortState = { column: 'submitted', direction: 'asc' };
    expect(ariaSortFor(s, 'submitted')).toBe('ascending');
    expect(ariaSortFor({ column: 'submitted', direction: 'desc' }, 'submitted')).toBe('descending');
    expect(ariaSortFor(s, 'app')).toBe('none');
  });
});

describe('currentlyPublishedVersionId — newest approved version is the live one', () => {
  // Helper: a minimal newest-first version list (the shape the caller passes as
  // `[group.latest, ...group.older]`).
  const v = (id: string, status: string) => ({ id, status });

  it('the LATEST version is approved → it is the published one', () => {
    expect(
      currentlyPublishedVersionId([v('v3', 'approved'), v('v2', 'approved'), v('v1', 'rejected')])
    ).toBe('v3');
  });

  it('latest is PENDING but a previous version is approved → the previous approved one', () => {
    expect(
      currentlyPublishedVersionId([v('v3', 'pending'), v('v2', 'approved'), v('v1', 'approved')])
    ).toBe('v2');
  });

  it('latest is rejected/draft/removed → skips to the most-recent approved', () => {
    expect(
      currentlyPublishedVersionId([
        v('v4', 'rejected'),
        v('v3', 'draft'),
        v('v2', 'removed'),
        v('v1', 'approved'),
      ])
    ).toBe('v1');
  });

  it('nothing approved yet → null (no live version)', () => {
    expect(currentlyPublishedVersionId([v('v2', 'pending'), v('v1', 'rejected')])).toBeNull();
  });

  it('a single approved version → it', () => {
    expect(currentlyPublishedVersionId([v('only', 'approved')])).toBe('only');
  });

  it('a single pending version → null', () => {
    expect(currentlyPublishedVersionId([v('only', 'pending')])).toBeNull();
  });

  it('an empty list → null', () => {
    expect(currentlyPublishedVersionId([])).toBeNull();
  });
});

describe('toDate', () => {
  it('parses ISO strings, passes Date through, and maps null/invalid to null', () => {
    expect(toDate('2026-01-01T00:00:00Z')?.getTime()).toBe(Date.parse('2026-01-01T00:00:00Z'));
    const d = new Date('2026-05-05');
    expect(toDate(d)).toBe(d);
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate('not-a-date')).toBeNull();
  });
});
