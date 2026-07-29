import { describe, expect, it } from 'vitest';
import { isModRemovedListing } from '~/components/Apps/offsiteOwnerControls';
import {
  ariaSortFor,
  bucketGroupsByStatus,
  compareDate,
  compareStatus,
  compareText,
  currentlyPublishedVersionId,
  filterGroups,
  groupSubmissionsByApp,
  matchesQuery,
  nextSortState,
  OWNER_STATUS_BUCKETS,
  sortGroups,
  statusBucket,
  statusRank,
  STATUS_SECTION_ORDER,
  toDate,
  type SortState,
  type SubmissionAccessors,
  type SubmissionGroup,
} from '~/components/Apps/submissionsTable';

/**
 * W13 — /apps/my-submissions table view-model logic (shared by the onsite +
 * offsite lists). Pins the column comparators, the case-insensitive name/slug
 * filter, and the per-app version-collapse so filter/sort/group can't drift and
 * are provable without mounting a table.
 */

// A minimal row shape covering both lists' needs for these pure helpers.
// `listingStatus` / `lastModerationAction` mirror the backing `AppListing` fields the
// owner lists carry — they drive the `mod-removed` override (see below).
type Row = {
  id: string;
  identity: string;
  name: string;
  slug: string;
  status: string;
  submittedAt: string | Date | null;
  reviewedAt: string | Date | null;
  listingStatus?: string | null;
  lastModerationAction?: string | null;
};

const A: SubmissionAccessors<Row> = {
  identity: (r: Row) => r.identity,
  name: (r: Row) => r.name,
  slug: (r: Row) => r.slug,
  status: (r: Row) => r.status,
  submittedAt: (r: Row) => toDate(r.submittedAt),
  reviewedAt: (r: Row) => toDate(r.reviewedAt),
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
    expect(groups[0].older.map((r: Row) => r.id)).toEqual(['v2', 'v1']); // newest-first
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
    expect(groups.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['bravo', 'alpha']);
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
    const block = groups.find((g: SubmissionGroup<Row>) => g.identity === 'block-123');
    expect(block?.versionCount).toBe(2);
    expect(block?.latest.id).toBe('onsite-2');
    expect(groups.find((g: SubmissionGroup<Row>) => g.identity === 'my-slug')?.versionCount).toBe(1);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', identity: 'app', submittedAt: '2026-09-01' })];
    const snapshot = rows.map((r: Row) => r.id);
    groupSubmissionsByApp(rows, A.identity, A.submittedAt);
    expect(rows.map((r: Row) => r.id)).toEqual(snapshot);
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
    expect(filterGroups(groups, 'Other', A).map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['other']);
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

  const ids = (s: SortState) => sortGroups(groups, s, A).map((g: SubmissionGroup<Row>) => g.identity);

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
    const before = groups.map((g: SubmissionGroup<Row>) => g.identity);
    sortGroups(groups, { column: 'app', direction: 'desc' }, A);
    expect(groups.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(before);
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

describe('statusBucket / bucketGroupsByStatus — status sections', () => {
  it('maps each known status to its section', () => {
    expect(statusBucket('approved')).toBe('live');
    expect(statusBucket('pending')).toBe('pending');
    expect(statusBucket('rejected')).toBe('rejected');
    expect(statusBucket('withdrawn')).toBe('withdrawn');
  });

  it('maps an unknown/other status to the (closed) withdrawn section as a safe default', () => {
    expect(statusBucket('archived')).toBe('withdrawn');
    expect(statusBucket('')).toBe('withdrawn');
  });

  it('the section order is Live → Pending → Rejected → Withdrawn → Removed-by-a-moderator', () => {
    expect(STATUS_SECTION_ORDER).toEqual([
      'live',
      'pending',
      'rejected',
      'withdrawn',
      'mod-removed',
    ]);
  });

  it('buckets a never-approved group by its LATEST submission status', () => {
    // No approved version anywhere → the section follows the current (latest) version.
    const groups = groupSubmissionsByApp(
      [
        row({ id: 'v1', identity: 'app', status: 'pending', submittedAt: '2026-01-01' }),
        row({ id: 'v2', identity: 'app', status: 'rejected', submittedAt: '2026-02-01' }),
      ],
      A.identity,
      A.submittedAt
    );
    const buckets = bucketGroupsByStatus(groups, A.status);
    expect(buckets.rejected.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['app']);
    expect(buckets.live).toEqual([]);
  });

  it('keeps a currently-LIVE app in Live even when its latest update is rejected/withdrawn/pending', () => {
    // 🟡#1 regression guard: an app with an approved (published) version whose NEWEST
    // submission is an in-flight update must stay in the always-expanded Live section,
    // never buried in the default-collapsed Rejected/Withdrawn section.
    for (const latestStatus of ['rejected', 'withdrawn', 'pending'] as const) {
      const groups = groupSubmissionsByApp(
        [
          row({ id: 'v1', identity: 'app', status: 'approved', submittedAt: '2026-01-01' }),
          row({ id: 'v2', identity: 'app', status: latestStatus, submittedAt: '2026-02-01' }),
        ],
        A.identity,
        A.submittedAt
      );
      const buckets = bucketGroupsByStatus(groups, A.status);
      expect(buckets.live.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['app']);
      expect(buckets.pending).toEqual([]);
      expect(buckets.rejected).toEqual([]);
      expect(buckets.withdrawn).toEqual([]);
    }
  });

  it('partitions distinct apps into their four sections', () => {
    const groups = groupSubmissionsByApp(
      [
        row({ id: 'a', identity: 'live-app', status: 'approved' }),
        row({ id: 'b', identity: 'pending-app', status: 'pending' }),
        row({ id: 'c', identity: 'rejected-app', status: 'rejected' }),
        row({ id: 'd', identity: 'withdrawn-app', status: 'withdrawn' }),
        row({ id: 'e', identity: 'weird-app', status: 'archived' }),
      ],
      A.identity,
      A.submittedAt
    );
    const buckets = bucketGroupsByStatus(groups, A.status);
    expect(buckets.live.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['live-app']);
    expect(buckets.pending.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['pending-app']);
    expect(buckets.rejected.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['rejected-app']);
    // Unknown status ('archived') falls back into the closed Withdrawn section.
    expect(buckets.withdrawn.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['withdrawn-app', 'weird-app']);
  });

  it('preserves the incoming group order within a bucket (a pre-applied sort is kept)', () => {
    const groups = groupSubmissionsByApp(
      [
        row({ id: 'p1', identity: 'p1', status: 'pending', submittedAt: '2026-03-01' }),
        row({ id: 'p2', identity: 'p2', status: 'pending', submittedAt: '2026-01-01' }),
      ],
      A.identity,
      A.submittedAt
    );
    const buckets = bucketGroupsByStatus(groups, A.status);
    expect(buckets.pending.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['p1', 'p2']);
  });

  it('yields all (empty) owner buckets for no groups', () => {
    const buckets = bucketGroupsByStatus([], A.status);
    expect(buckets).toEqual({
      live: [],
      pending: [],
      rejected: [],
      withdrawn: [],
      'mod-removed': [],
    });
  });
});

describe('bucketGroupsByStatus — mod-removed override (precedence fix)', () => {
  // The owner lists supply this override; it reuses the REAL classifier
  // (`isModRemovedListing` → `ownerListingState`), not a mocked shortcut, so the test
  // pins the exact rule the UI ships: `AppListing.status='removed'` + a last
  // moderation event that is NOT the owner's own `owner-unpublish`.
  const modRemovedOverride = (g: SubmissionGroup<Row>): 'mod-removed' | null =>
    isModRemovedListing({
      listingStatus: g.latest.listingStatus,
      lastModerationAction: g.latest.lastModerationAction,
    })
      ? 'mod-removed'
      : null;

  const bucketize = (rows: Row[]) =>
    bucketGroupsByStatus(
      groupSubmissionsByApp(rows, A.identity, A.submittedAt),
      A.status,
      OWNER_STATUS_BUCKETS,
      modRemovedOverride
    );

  it('a mod-removed listing that ALSO has an approved version buckets to mod-removed, NOT live', () => {
    // The bug this fixes: a once-live app a moderator took down (backing listing
    // `removed`, last event a mod `delist`) has an approved version in its history, so
    // the any-approved→Live rule would misfile it under Live. The override wins.
    const rows = [
      row({
        id: 'v1',
        identity: 'app',
        status: 'approved',
        submittedAt: '2026-01-01',
      }),
      row({
        id: 'v2',
        identity: 'app',
        status: 'approved',
        submittedAt: '2026-02-01',
        listingStatus: 'removed',
        lastModerationAction: 'delist',
      }),
    ];
    const buckets = bucketize(rows);
    expect(buckets['mod-removed'].map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['app']);
    expect(buckets.live).toEqual([]);
    expect(buckets.rejected).toEqual([]);
    expect(buckets.withdrawn).toEqual([]);
  });

  it('an owner-hidden listing (last event owner-unpublish) does NOT land in mod-removed', () => {
    // Owner-hidden stays DISTINCT + unchanged: it has an approved version, so it keeps
    // its normal Live placement (the any-approved→Live rule), and never appears in the
    // moderator-takedown section.
    const rows = [
      row({
        id: 'v1',
        identity: 'app',
        status: 'approved',
        submittedAt: '2026-01-01',
        listingStatus: 'removed',
        lastModerationAction: 'owner-unpublish',
      }),
    ];
    const buckets = bucketize(rows);
    expect(buckets['mod-removed']).toEqual([]);
    expect(buckets.live.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['app']);
  });

  it('rejected / withdrawn / pending groups are unchanged by the override', () => {
    // No backing removed listing → the override returns null → the existing bucketing
    // is untouched (a never-approved group follows its latest status).
    const rows = [
      row({ id: 'p', identity: 'pending-app', status: 'pending' }),
      row({ id: 'r', identity: 'rejected-app', status: 'rejected' }),
      row({ id: 'w', identity: 'withdrawn-app', status: 'withdrawn' }),
    ];
    const buckets = bucketize(rows);
    expect(buckets.pending.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['pending-app']);
    expect(buckets.rejected.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['rejected-app']);
    expect(buckets.withdrawn.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['withdrawn-app']);
    expect(buckets['mod-removed']).toEqual([]);
    expect(buckets.live).toEqual([]);
  });

  it('a mod-removed listing with NO recorded moderation event still buckets to mod-removed', () => {
    // `ownerListingState` treats a `removed` listing with a null last action as a
    // moderator takedown (a removed listing is not owner-hidden unless the last event
    // is `owner-unpublish`), so it belongs in the section, not Live.
    const rows = [
      row({
        id: 'x',
        identity: 'app',
        status: 'approved',
        listingStatus: 'removed',
        lastModerationAction: null,
      }),
    ];
    const buckets = bucketize(rows);
    expect(buckets['mod-removed'].map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['app']);
    expect(buckets.live).toEqual([]);
  });

  it('WITHOUT the override, a mod-removed listing still misfiles under Live (proves the override is the fix)', () => {
    // Mutation guard: the default call (no override) reproduces the pre-fix bug — an
    // approved-in-history removed listing lands in Live. Only the override moves it.
    const rows = [
      row({
        id: 'x',
        identity: 'app',
        status: 'approved',
        listingStatus: 'removed',
        lastModerationAction: 'delist',
      }),
    ];
    const buckets = bucketGroupsByStatus(
      groupSubmissionsByApp(rows, A.identity, A.submittedAt),
      A.status
    );
    expect(buckets.live.map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['app']);
    expect(buckets['mod-removed']).toEqual([]);
  });

  it('an in-flight update (latest pending/rejected) over an approved+mod-removed listing → mod-removed, not live', () => {
    // The precedence must beat BOTH signals at once: the group has an approved version
    // in history (would → Live via any-approved) AND its latest request is an in-flight
    // pending/rejected update (would → Pending/Rejected via latest-status). Because the
    // backing listing is a moderator takedown, the override wins over both.
    for (const latestStatus of ['pending', 'rejected'] as const) {
      const rows = [
        row({ id: 'v1', identity: 'app', status: 'approved', submittedAt: '2026-01-01' }),
        row({
          id: 'v2',
          identity: 'app',
          status: latestStatus,
          submittedAt: '2026-02-01',
          listingStatus: 'removed',
          lastModerationAction: 'delist',
        }),
      ];
      const buckets = bucketize(rows);
      expect(buckets['mod-removed'].map((g: SubmissionGroup<Row>) => g.identity)).toEqual(['app']);
      expect(buckets.live).toEqual([]);
      expect(buckets.pending).toEqual([]);
      expect(buckets.rejected).toEqual([]);
    }
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
