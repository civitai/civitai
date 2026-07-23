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
  },
  mockReviewRepoUrl: vi.fn((slug: string) => `https://forgejo.example/review/${slug}`),
  mockRepoCommitUrl: vi.fn((slug: string, ref: string) => `https://forgejo.example/${slug}/commit/${ref}`),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: {} }));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  reviewRepoUrl: mockReviewRepoUrl,
  repoCommitUrl: mockRepoCommitUrl,
}));

import {
  resolveReviewRequestTarget,
  getReviewRequestById,
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
    submittedBy: { id: 7, username: 'author', image: null },
    reviewedBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockDbRead.appBlockPublishRequest.findUnique.mockReset();
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
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      dbRow({ status: 'withdrawn' })
    );
    await expect(
      getReviewRequestById('pubreq_0123456789ABCDEFGHJKMNPQRS')
    ).resolves.toBeNull();
  });

  it('non-existent id (findUnique → null) → null', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(null);
    await expect(getReviewRequestById('pubreq_missing')).resolves.toBeNull();
  });

  it.each([
    ['pending', 'pending'],
    ['approved', 'approved'],
    ['rejected', 'rejected'],
  ])('%s → { mode: %s, request } with the page-body fields (shape parity)', async (dbStatus, expectedMode) => {
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
  });

  it('a rejected detail carries the rejectionReason the history view renders', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      dbRow({
        status: 'rejected',
        rejectionReason: 'uses a disallowed scope',
        reviewedBy: { id: 9, username: 'reviewer', image: null },
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
