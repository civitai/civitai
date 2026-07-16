import { describe, expect, it } from 'vitest';

import {
  MOD_STATUS_BUCKETS,
  MOD_STATUS_SECTION_ORDER,
  bucketGroupsByStatus,
  modStatusBucket,
  type SubmissionGroup,
} from '~/components/Apps/submissionsTable';

/**
 * W13 post-approval mgmt (P2) — the MOD-view bucketing extension. Proves the shared
 * bucketing was made per-consumer WITHOUT changing the owner default:
 *   - `modStatusBucket` maps the AppListing lifecycle (incl. `removed`/`draft`),
 *   - `bucketGroupsByStatus(..., MOD_STATUS_BUCKETS)` yields the 5 mod sections and
 *     buckets each listing by its own status.
 * (The owner default — 4 sections, byte-identical — stays covered by
 * `submissionsTable.test.ts`.)
 */

type Row = { id: string; status: string };

/** A single-listing group (the mod view isn't version-collapsed). */
function group(id: string, status: string): SubmissionGroup<Row> {
  const latest: Row = { id, status };
  return { identity: id, latest, older: [], versionCount: 1 };
}

const statusOf = (r: Row) => r.status;

describe('modStatusBucket', () => {
  it('maps the AppListing lifecycle to the mod sections', () => {
    expect(modStatusBucket('approved')).toBe('live');
    expect(modStatusBucket('pending')).toBe('pending');
    expect(modStatusBucket('rejected')).toBe('rejected');
    expect(modStatusBucket('removed')).toBe('removed');
    expect(modStatusBucket('draft')).toBe('draft');
  });

  it('maps an unknown status to the (closed) draft section as a safe default', () => {
    expect(modStatusBucket('archived')).toBe('draft');
    expect(modStatusBucket('')).toBe('draft');
  });
});

describe('MOD_STATUS_SECTION_ORDER', () => {
  it('renders Live → Pending → Rejected → Removed → Draft', () => {
    expect(MOD_STATUS_SECTION_ORDER).toEqual(['live', 'pending', 'rejected', 'removed', 'draft']);
  });
});

describe('bucketGroupsByStatus with the MOD config', () => {
  it('initialises exactly the five mod buckets and buckets each listing by status', () => {
    const groups = [
      group('a', 'approved'),
      group('b', 'pending'),
      group('c', 'rejected'),
      group('d', 'removed'),
      group('e', 'draft'),
    ];
    const buckets = bucketGroupsByStatus(groups, statusOf, MOD_STATUS_BUCKETS);
    expect(Object.keys(buckets).sort()).toEqual(
      ['draft', 'live', 'pending', 'rejected', 'removed'].sort()
    );
    expect(buckets.live.map((g) => g.identity)).toEqual(['a']);
    expect(buckets.pending.map((g) => g.identity)).toEqual(['b']);
    expect(buckets.rejected.map((g) => g.identity)).toEqual(['c']);
    expect(buckets.removed.map((g) => g.identity)).toEqual(['d']);
    expect(buckets.draft.map((g) => g.identity)).toEqual(['e']);
  });

  it('a removed listing buckets to Removed (NOT Live — no false any-approved promotion)', () => {
    const buckets = bucketGroupsByStatus([group('x', 'removed')], statusOf, MOD_STATUS_BUCKETS);
    expect(buckets.removed).toHaveLength(1);
    expect(buckets.live).toHaveLength(0);
  });

  it('an empty input yields all five empty buckets', () => {
    const buckets = bucketGroupsByStatus<Row, 'live' | 'pending' | 'rejected' | 'removed' | 'draft'>(
      [],
      statusOf,
      MOD_STATUS_BUCKETS
    );
    expect(buckets).toEqual({ live: [], pending: [], rejected: [], removed: [], draft: [] });
  });
});
