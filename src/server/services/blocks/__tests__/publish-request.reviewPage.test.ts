import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * REVIEW PAGE service-logic coverage (PR #3298) for
 *   - resolveReviewRequestTarget  — the light SSR fail-close resolver
 *     (`/apps/review/<publishRequestId>` getServerSideProps): status→mode or null.
 *   - getReviewRequestById         — the full hydrated single-request fetch that
 *     feeds OnsiteReviewModalBody on the page.
 *
 * Both perform NO authorization (the router's moderatorProcedure gates them) and
 * both map a non-reviewable status → null via `reviewModeForStatus`
 * (pending/approved/rejected → mode; withdrawn/superseded/anything-else → null).
 * We prove:
 *   - withdrawn → null (the 404 path; must not leak a withdrawn app's detail).
 *   - pending / approved / rejected → { …, status|mode } with the correct mode.
 *   - a non-existent id (findUnique → null) → null.
 *   - getReviewRequestById returns a `request` carrying the fields the page body
 *     consumes (id, slug, status-derived mode, approvalNotes/rejectionReason,
 *     bundleSizeBytes as string, the Forgejo deep links) — shape-parity lock.
 *
 * dbRead + forgejo.service are dynamically imported by the service; we mock both
 * (mirrors publish-request.reviewSandbox.test.ts) so no generated Prisma client
 * or real Forgejo config is touched.
 */

const { mockDbRead, mockReviewRepoUrl, mockRepoCommitUrl } = vi.hoisted(() => ({
  mockDbRead: {
    appBlockPublishRequest: { findUnique: vi.fn() },
    // Loosely typed: `vi.fn(async () => [])` infers `never[]`, which reds every
    // `mockResolvedValue` below — and `src/**/__tests__/**` is outside `pnpm typecheck`, so
    // nothing else would tell you.
    appListing: { findMany: vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []) },
  },
  mockReviewRepoUrl: vi.fn((slug: string) => `https://forgejo.example/review/${slug}`),
  mockRepoCommitUrl: vi.fn(
    (slug: string, ref: string) => `https://forgejo.example/${slug}/commit/${ref}`
  ),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: {} }));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  reviewRepoUrl: mockReviewRepoUrl,
  repoCommitUrl: mockRepoCommitUrl,
}));

import {
  draftTransitionWhere,
  getReviewRequestById,
  resetRestoreWhere,
  resolveReviewRequestTarget,
} from '~/server/services/blocks/publish-request.service';

// A full hydrated DB row shaped as getReviewRequestById's `select` returns it.
function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pubreq_0123456789ABCDEFGHJKMNPQRS',
    appBlockId: 'appblk_1',
    slug: 'my-app',
    version: '1.2.3',
    status: 'pending',
    submittedAt: new Date('2026-07-01T00:00:00Z'),
    reviewedAt: null,
    approvalNotes: null,
    rejectionReason: null,
    bundleSizeBytes: BigInt(4096),
    bundleSha256: 'sha-abc',
    manifest: { name: 'my-app' },
    fileSummary: null,
    manifestDiffSummary: null,
    forgejoCommitSha: null,
    submittedBy: { id: 7, username: 'author', deletedAt: null, image: null },
    reviewedBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockDbRead.appBlockPublishRequest.findUnique.mockReset();
  mockDbRead.appListing.findMany.mockReset();
  // The fixture row's OWN listing — `dbRow()` carries `appBlockId: 'appblk_1'`, so
  // `listingBelongsToRequest` requires the listing to be keyed on that same block.
  mockDbRead.appListing.findMany.mockResolvedValue([
    {
      id: 'apl_mine',
      status: 'draft',
      contentRating: 'pg13',
      slug: 'my-app',
      kind: 'onsite',
      appBlockId: 'appblk_1',
      userId: 7,
      icon: { url: 'icon-uuid' },
      cover: { url: 'cover-uuid' },
      metric: { openCount: 1234 },
    },
  ]);
  mockReviewRepoUrl.mockClear();
  mockRepoCommitUrl.mockClear();
});

describe('resolveReviewRequestTarget — SSR status→mode fail-close', () => {
  it('withdrawn → null (the 404 path; does not resolve a target)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'withdrawn',
    });
    await expect(resolveReviewRequestTarget('pubreq_x')).resolves.toBeNull();
  });

  it('a superseded / unknown status → null', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'superseded',
    });
    await expect(resolveReviewRequestTarget('pubreq_x')).resolves.toBeNull();
  });

  it('non-existent id (findUnique → null) → null', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(null);
    await expect(resolveReviewRequestTarget('pubreq_missing')).resolves.toBeNull();
  });

  it.each([
    ['pending', 'pending'],
    ['approved', 'approved'],
    ['rejected', 'rejected'],
  ])('%s → { id, status: %s } (correct mode)', async (dbStatus, expectedMode) => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_ok',
      status: dbStatus,
    });
    const res = await resolveReviewRequestTarget('pubreq_ok');
    expect(res).toEqual({ id: 'pubreq_ok', status: expectedMode });
  });
});

describe('getReviewRequestById — full hydrated single-request fetch', () => {
  it('withdrawn → null (fail-closed; never hydrates a non-reviewable row)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(dbRow({ status: 'withdrawn' }));
    await expect(getReviewRequestById('pubreq_0123456789ABCDEFGHJKMNPQRS')).resolves.toBeNull();
  });

  it('non-existent id (findUnique → null) → null', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(null);
    await expect(getReviewRequestById('pubreq_missing')).resolves.toBeNull();
  });

  it.each([
    ['pending', 'pending'],
    ['approved', 'approved'],
    ['rejected', 'rejected'],
  ])(
    '%s → { mode: %s, request } with the page-body fields (shape parity)',
    async (dbStatus, expectedMode) => {
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(dbRow({ status: dbStatus }));
      const res = await getReviewRequestById('pubreq_0123456789ABCDEFGHJKMNPQRS');
      expect(res).not.toBeNull();
      expect(res!.mode).toBe(expectedMode);
      // Shape-parity: the fields OnsiteReviewModalBody consumes on the page.
      expect(res!.request).toMatchObject({
        id: 'pubreq_0123456789ABCDEFGHJKMNPQRS',
        slug: 'my-app',
        version: '1.2.3',
        approvalNotes: null,
        rejectionReason: null,
      });
      // status is stripped from `request` (mode carries it) — mirrors the list builders.
      expect((res!.request as Record<string, unknown>).status).toBeUndefined();
      // bundle bigint is serialized to string for the tRPC/superjson path.
      expect(res!.request.bundleSizeBytes).toBe('4096');
      // Forgejo review-repo deep link is derived server-side from the slug.
      expect(res!.request.reviewRepoUrl).toBe('https://forgejo.example/review/my-app');
      /**
       * 🔴 THE STORE-LISTING JOIN, WHICH THE REVIEW PAGE'S MEDIA SECTION IS ENTIRELY MADE
       * OF. `ReviewListingMedia` takes these as props, and the page-level browser test is
       * a labelled invariant guard that names no field — so with this unasserted, deleting
       * the one spread here renders "No icon" / "No cover" on the review page, nothing red.
       */
      expect(res!.request.playCount).toBe(1234);
      expect(res!.request.iconUrl).toContain('icon-uuid');
      expect(res!.request.coverUrl).toContain('cover-uuid');
      // One slug join for the page; the other two reads are the re-rate lookups.
      const slugJoins = mockDbRead.appListing.findMany.mock.calls.filter(
        (c) => ((c[0] ?? {}) as { where?: { slug?: unknown } }).where?.slug !== undefined
      );
      expect(slugJoins).toHaveLength(1);
      expect(mockDbRead.appListing.findMany).toHaveBeenCalledTimes(3);
      const joinArgs = mockDbRead.appListing.findMany.mock.calls[0][0] as {
        where: { slug: { in: string[] } };
      };
      expect(joinArgs.where.slug).toEqual({ in: ['my-app'] });
    }
  );

  it('🔴 a slug-matched listing belonging to ANOTHER app is not shown on this submission', async () => {
    // The released-slug case: the row survives in the Rejected tab while the slug is free
    // for a second developer to claim. See `listingBelongsToRequest`.
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      dbRow({ status: 'rejected', appBlockId: null })
    );
    mockDbRead.appListing.findMany.mockResolvedValue([
      {
        slug: 'my-app',
        kind: 'onsite',
        appBlockId: null,
        userId: 999,
        icon: null,
        cover: null,
        metric: { openCount: 9 },
      },
    ]);
    const res = await getReviewRequestById('pubreq_0123456789ABCDEFGHJKMNPQRS');
    expect(res!.request).toMatchObject({ playCount: null, iconUrl: null, coverUrl: null });
  });

  it('a submission whose app has NO listing projects nulls, not a throw', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(dbRow());
    mockDbRead.appListing.findMany.mockResolvedValue([]);
    const res = await getReviewRequestById('pubreq_0123456789ABCDEFGHJKMNPQRS');
    expect(res!.request).toMatchObject({ playCount: null, iconUrl: null, coverUrl: null });
    expect(res!.request).toMatchObject({ appListingId: null, approveRating: null });
  });

  /**
   * `approveRating` asks the database with approveRequest's own `where` builders; these
   * pin that it sends exactly those and maps what comes back. The listing's own rating
   * (`r`) and the manifest's (`pg13`) differ so the wrong source is visible.
   */
  describe('approveRating — will this approve re-rate a listing, and from what', () => {
    const SUBMITTER = 7;
    type Where = { OR?: Record<string, unknown>[] };
    const isDraftQuery = (w: Where) => w.OR?.[0]?.status === 'draft';
    const isResetQuery = (w: Where) => w.OR?.[0]?.status === 'pending';
    const approveRatingFor = async (
      found: { drafts?: unknown[]; resets?: unknown[] },
      request: Record<string, unknown> = {}
    ) => {
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        dbRow({ manifest: { name: 'my-app', contentRating: 'pg13' }, ...request })
      );
      mockDbRead.appListing.findMany.mockImplementation(async (...a: unknown[]) => {
        const w = ((a[0] ?? {}) as { where?: Where }).where ?? {};
        if (isDraftQuery(w)) return found.drafts ?? [];
        if (isResetQuery(w)) return found.resets ?? [];
        return [];
      });
      const res = await getReviewRequestById('pubreq_0123456789ABCDEFGHJKMNPQRS');
      return (res!.request as unknown as { approveRating: unknown }).approveRating;
    };
    const queries = () =>
      mockDbRead.appListing.findMany.mock.calls.map(
        (c) => ((c[0] ?? {}) as { where?: Where }).where ?? {}
      );

    it('asks with exactly draftTransitionWhere and resetRestoreWhere for this request', async () => {
      await approveRatingFor({});
      const wheres = queries();
      expect(wheres.find(isDraftQuery)).toEqual({
        OR: [draftTransitionWhere({ slug: 'my-app', submittedByUserId: SUBMITTER })],
      });
      expect(wheres.find(isResetQuery)).toEqual({ OR: [resetRestoreWhere('appblk_1')] });
    });

    it('a request not yet keyed to an app asks for no reset restore', async () => {
      await approveRatingFor({}, { appBlockId: null });
      expect(queries().some(isResetQuery)).toBe(false);
    });

    it('a matching first-version DRAFT is floored from the submitted manifest rating', async () => {
      expect(
        await approveRatingFor({ drafts: [{ id: 'apl_draft', slug: 'my-app', userId: SUBMITTER }] })
      ).toEqual({ listingId: 'apl_draft', declared: 'pg13' });
    });

    it('a manifest with no rating floors from g', async () => {
      expect(
        await approveRatingFor(
          { drafts: [{ id: 'apl_draft', slug: 'my-app', userId: SUBMITTER }] },
          { manifest: { name: 'my-app' } }
        )
      ).toEqual({ listingId: 'apl_draft', declared: 'g' });
    });

    it('a listing RESET to pending is floored from the rating it already carries', async () => {
      expect(
        await approveRatingFor({
          resets: [{ id: 'apl_reset', appBlockId: 'appblk_1', contentRating: 'r' }],
        })
      ).toEqual({ listingId: 'apl_reset', declared: 'r' });
    });

    it('rows for another request on the same page are not this one’s', async () => {
      expect(
        await approveRatingFor({
          drafts: [{ id: 'apl_other', slug: 'other-app', userId: SUBMITTER }],
          resets: [{ id: 'apl_other2', appBlockId: 'appblk_9', contentRating: 'r' }],
        })
      ).toBeNull();
    });

    it('nothing the writer would re-rate: null', async () => {
      expect(await approveRatingFor({})).toBeNull();
    });
  });

  it('another app’s slug-matched listing lends this submission no listing id either', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      dbRow({ status: 'rejected', appBlockId: null })
    );
    mockDbRead.appListing.findMany.mockResolvedValue([
      {
        id: 'apl_theirs',
        status: 'approved',
        contentRating: 'r',
        slug: 'my-app',
        kind: 'onsite',
        appBlockId: null,
        userId: 999,
        icon: null,
        cover: null,
        metric: null,
      },
    ]);
    const res = await getReviewRequestById('pubreq_0123456789ABCDEFGHJKMNPQRS');
    expect(res!.request).toMatchObject({ appListingId: null, approveRating: null });
  });

  it('a rejected detail carries the rejectionReason the history view renders', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      dbRow({
        status: 'rejected',
        rejectionReason: 'uses a disallowed scope',
        reviewedBy: { id: 9, username: 'reviewer', deletedAt: null, image: null },
        reviewedAt: new Date('2026-07-02T00:00:00Z'),
      })
    );
    const res = await getReviewRequestById('pubreq_0123456789ABCDEFGHJKMNPQRS');
    expect(res!.mode).toBe('rejected');
    expect(res!.request.rejectionReason).toBe('uses a disallowed scope');
    expect(res!.request.reviewedBy).toMatchObject({ username: 'reviewer' });
  });

  it('pushCommitUrl is the canonical-commit link only for a push row (no bundle sha) with a forgejo sha', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      dbRow({ status: 'approved', bundleSha256: null, forgejoCommitSha: 'deadbeef' })
    );
    const res = await getReviewRequestById('pubreq_0123456789ABCDEFGHJKMNPQRS');
    expect(res!.request.pushCommitUrl).toBe('https://forgejo.example/my-app/commit/deadbeef');
  });
});
