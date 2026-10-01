import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The MOD-ONLY prior-versions read (`blocks.listVersionHistory`) and the store-listing
 * projection the three mod-queue list procs now carry.
 *
 * Both are slug-keyed, and that is the whole point: `AppBlockPublishRequest.appBlockId` is
 * NULL while an app's FIRST request is pending, so an id-keyed read or join returns nothing
 * for exactly the rows a moderator reviews most carefully.
 *
 * `dbRead` comes from the canonical shared db mock (`~/__tests__/mocks/db.mock`, which
 * `no-direct-shared-module-mock` requires) and `forgejo.service` is stubbed here, so no
 * generated Prisma client or Forgejo config is touched.
 */

const { mockReviewRepoUrl, mockRepoCommitUrl } = vi.hoisted(() => ({
  mockReviewRepoUrl: vi.fn((slug: string) => `https://forgejo.example/review/${slug}`),
  mockRepoCommitUrl: vi.fn(
    (slug: string, ref: string) => `https://forgejo.example/${slug}/commit/${ref}`
  ),
}));

vi.mock('~/server/services/blocks/forgejo.service', () => ({
  reviewRepoUrl: mockReviewRepoUrl,
  repoCommitUrl: mockRepoCommitUrl,
}));

import {
  listApprovedRequests,
  listPendingRequests,
  listVersionHistory,
  VERSION_HISTORY_LIMIT,
} from '~/server/services/blocks/publish-request.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;

/** A history row shaped as `listVersionHistory`'s `select` returns it. */
function historyRow(over: Partial<Record<string, unknown>> & { id: string }) {
  return {
    version: '1.0.0',
    status: 'approved',
    submittedAt: new Date('2026-03-01T00:00:00Z'),
    reviewedAt: new Date('2026-03-02T00:00:00Z'),
    rejectionReason: null,
    deployState: 'live',
    submittedBy: { id: 7, username: 'author', image: null },
    reviewedBy: { id: 9, username: 'mod', image: null },
    ...over,
  };
}

/** A queue row shaped as `listPendingRequests`'s `select` returns it. */
function queueRow(over: Partial<Record<string, unknown>> & { id: string; slug: string }) {
  return {
    appBlockId: null,
    version: '1.0.0',
    submittedAt: new Date('2026-03-01T00:00:00Z'),
    bundleSizeBytes: BigInt(2048),
    bundleSha256: 'sha-abc',
    manifest: {},
    fileSummary: {},
    manifestDiffSummary: {},
    forgejoCommitSha: null,
    submittedBy: { id: 7, username: 'author', image: null },
    ...over,
  };
}

beforeEach(() => {
  mockDbRead.appBlockPublishRequest.findMany.mockReset();
  mockDbRead.appListing.findMany.mockReset();
  mockDbRead.appListing.findMany.mockResolvedValue([]);
});

describe('listVersionHistory — keyed on SLUG, newest-first, bounded', () => {
  it('queries by SLUG ALONE, so a pending first version with a NULL appBlockId is found', async () => {
    // 🔴 THE REGRESSION THIS EXISTS FOR. An `appBlockId`-keyed read would return nothing
    // here, and nothing would error — the modal would simply say "no submissions" about an
    // app with a live pending request.
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      historyRow({ id: 'pubreq_1', status: 'pending', reviewedAt: null }),
    ]);
    const result = await listVersionHistory({ slug: 'first-timer' });
    const args = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ slug: 'first-timer' });
    expect(JSON.stringify(args.where)).not.toContain('appBlockId');
    expect(result.items.map((r: { id: string }) => r.id)).toEqual(['pubreq_1']);
  });

  it('orders newest-first by submittedAt', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    await listVersionHistory({ slug: 'any-app' });
    expect(mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0].orderBy).toEqual({
      submittedAt: 'desc',
    });
  });

  it('includes EVERY status, so the modal reads as a full history rather than a gap', async () => {
    // No `status` filter at all — the current (pending) request has to be in the list or a
    // moderator reading it cannot tell what they are looking at.
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      historyRow({ id: 'p', status: 'pending', reviewedAt: null }),
      historyRow({ id: 'r', status: 'rejected', rejectionReason: 'no' }),
      historyRow({ id: 'w', status: 'withdrawn' }),
      historyRow({ id: 'a', status: 'approved' }),
    ]);
    const result = await listVersionHistory({ slug: 'any-app' });
    expect(Object.keys(mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0].where)).toEqual([
      'slug',
    ]);
    expect(result.items.map((r: { status: string }) => r.status)).toEqual([
      'pending',
      'rejected',
      'withdrawn',
      'approved',
    ]);
  });

  it('takes LIMIT + 1 and reports truncation without leaking the extra row', async () => {
    const rows = Array.from({ length: VERSION_HISTORY_LIMIT + 1 }, (_, i) =>
      historyRow({ id: `pubreq_${i}` })
    );
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue(rows);
    const result = await listVersionHistory({ slug: 'busy-app' });
    expect(mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0].take).toBe(
      VERSION_HISTORY_LIMIT + 1
    );
    expect(result.items).toHaveLength(VERSION_HISTORY_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.items.at(-1)?.id).toBe(`pubreq_${VERSION_HISTORY_LIMIT - 1}`);
  });

  it('a page at exactly the limit is NOT truncated (the off-by-one)', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue(
      Array.from({ length: VERSION_HISTORY_LIMIT }, (_, i) => historyRow({ id: `pubreq_${i}` }))
    );
    const result = await listVersionHistory({ slug: 'busy-app' });
    expect(result.items).toHaveLength(VERSION_HISTORY_LIMIT);
    expect(result.truncated).toBe(false);
  });

  it('🔴 does NOT project deployDetail — it carries a tenant-influenced build-log excerpt', async () => {
    const select = (() => {
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
      return listVersionHistory({ slug: 'any-app' }).then(
        () => mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0].select
      );
    })();
    const resolved = await select;
    expect(resolved.deployDetail).toBeUndefined();
    // Positive control: the sibling field it is easily confused with IS projected, so the
    // assertion above is about `deployDetail` rather than about an empty select.
    expect(resolved.deployState).toBe(true);
    // …and so are the fields the modal renders, including both user chips.
    for (const field of ['id', 'version', 'status', 'submittedAt', 'reviewedAt', 'rejectionReason'])
      expect(resolved[field], `${field} must be projected`).toBe(true);
    expect(resolved.submittedBy).toEqual({ select: { id: true, username: true, image: true } });
    expect(resolved.reviewedBy).toEqual({ select: { id: true, username: true, image: true } });
    // No bundle pointers, no manifest blob: the modal is a list of dates and verdicts.
    expect(resolved.manifest).toBeUndefined();
    expect(resolved.bundleKey).toBeUndefined();
  });
});

describe('the mod queue rows carry the app store listing, joined on SLUG', () => {
  it('projects playCount + iconUrl + coverUrl from the listing matching the row slug', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      queueRow({ id: 'pubreq_a', slug: 'has-listing' }),
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      {
        slug: 'has-listing',
        icon: { url: 'icon-uuid' },
        cover: { url: 'cover-uuid' },
        metric: { openCount: 4821 },
      },
    ]);
    const result = await listPendingRequests({ limit: 10 });
    expect(mockDbRead.appListing.findMany.mock.calls[0][0].where).toEqual({
      slug: { in: ['has-listing'] },
    });
    const row = result.items[0];
    expect(row.playCount).toBe(4821);
    // The URLs are CDN-transformed rather than raw `Image.url`, and no raw Image row
    // reaches the client.
    expect(row.iconUrl).toContain('icon-uuid');
    expect(row.coverUrl).toContain('cover-uuid');
    expect(row).not.toHaveProperty('icon');
    expect(row).not.toHaveProperty('cover');
  });

  it('a slug with NO listing yields nulls rather than throwing', async () => {
    // The pending FIRST version whose draft listing does not exist yet is the common case
    // on this queue, not an edge one.
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      queueRow({ id: 'pubreq_b', slug: 'no-listing' }),
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([]);
    const result = await listPendingRequests({ limit: 10 });
    expect(result.items[0]).toMatchObject({ playCount: null, iconUrl: null, coverUrl: null });
  });

  it('a listing with no METRIC row yields a null play count, not a zero', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      queueRow({ id: 'pubreq_c', slug: 'new-listing' }),
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      { slug: 'new-listing', icon: null, cover: null, metric: null },
    ]);
    const result = await listPendingRequests({ limit: 10 });
    expect(result.items[0].playCount).toBeNull();
  });

  it('a metric of ZERO stays zero — null and 0 are different facts', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      queueRow({ id: 'pubreq_d', slug: 'quiet-listing' }),
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      { slug: 'quiet-listing', icon: null, cover: null, metric: { openCount: 0 } },
    ]);
    const result = await listPendingRequests({ limit: 10 });
    expect(result.items[0].playCount).toBe(0);
  });

  it('🔴 ONE listing query per page, not one per row, and only for the rows RETURNED', async () => {
    // The `limit + 1` probe row must not be joined — and the join must never become an
    // N+1 on a 50-row mod queue.
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      queueRow({ id: 'r1', slug: 'app-1' }),
      queueRow({ id: 'r2', slug: 'app-2' }),
      queueRow({ id: 'r3', slug: 'app-3' }), // the probe row at limit=2
    ]);
    const result = await listPendingRequests({ limit: 2 });
    expect(mockDbRead.appListing.findMany).toHaveBeenCalledTimes(1);
    expect(mockDbRead.appListing.findMany.mock.calls[0][0].where.slug.in).toEqual([
      'app-1',
      'app-2',
    ]);
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe('r2');
  });

  it('no listing query at all when the page is empty', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    await listPendingRequests({ limit: 10 });
    expect(mockDbRead.appListing.findMany).not.toHaveBeenCalled();
  });

  it('the APPROVED history proc carries the same projection', async () => {
    // The columns exist on every tab, so the join has to be on every proc — a field that
    // exists in one payload and not another renders an em dash that looks like data.
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        ...queueRow({ id: 'pubreq_e', slug: 'shipped' }),
        reviewedAt: new Date('2026-03-02T00:00:00Z'),
        approvalNotes: null,
        deployState: 'live',
        deployDetail: null,
        deployUpdatedAt: null,
        reviewedBy: { id: 9, username: 'mod', image: null },
      },
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      { slug: 'shipped', icon: null, cover: null, metric: { openCount: 12 } },
    ]);
    const result = await listApprovedRequests({ limit: 10 });
    expect(result.items[0].playCount).toBe(12);
  });
});
