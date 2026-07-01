import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MOD REVIEW SANDBOX (#2831) — service-layer coverage for previewRequest,
 * getReviewStatus, markReviewPreviewState, and teardownReviewForRequest.
 *
 * Verifies:
 *   - previewRequest reads the in-review repo HEAD, triggers the review build
 *     with SERVER-derived sha/host/url + the modUserId, and stamps building.
 *   - previewRequest refuses a non-pending request.
 *   - a trigger failure flips state to preview-failed and re-throws.
 *   - getReviewStatus surfaces only preview-* states.
 *   - teardownReviewForRequest deletes review resources by the publish request,
 *     unconditionally (label selector is the safety boundary) and never throws.
 */

const {
  mockDbRead,
  mockDbWrite,
  mockGetReviewHead,
  mockTriggerReviewBuild,
  mockDeleteReviewResources,
} = vi.hoisted(() => ({
  mockDbRead: {
    appBlockPublishRequest: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
  },
  mockDbWrite: {
    appBlockPublishRequest: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
  },
  mockGetReviewHead: vi.fn(async () => 'a'.repeat(40)),
  mockTriggerReviewBuild: vi.fn(async () => ({ name: 'review-pr-1' })),
  mockDeleteReviewResources: vi.fn(async () => undefined),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  getReviewRepoHeadSha: mockGetReviewHead,
}));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  getReviewRepoHeadSha: mockGetReviewHead,
  triggerReviewBuild: mockTriggerReviewBuild,
  deleteReviewResources: mockDeleteReviewResources,
  // pure helper used by previewRequest
  reviewHost: (sha: string, domain: string) => `review-${sha.slice(0, 16)}.${domain}`,
}));

import {
  previewRequest,
  getReviewStatus,
  teardownReviewForRequest,
  teardownPreview,
  countActiveReviewPreviews,
  listActiveReviewPreviews,
  withdrawRequest,
  parseReviewDetail,
  MAX_CONCURRENT_REVIEW_PREVIEWS,
  REVIEW_PREVIEW_TTL_MS,
} from '~/server/services/blocks/publish-request.service';

const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';
const SHA = 'a'.repeat(40);

describe('previewRequest', () => {
  beforeEach(() => {
    process.env.NEXTAUTH_URL = 'https://civitai.com';
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockDbWrite.appBlockPublishRequest.updateMany.mockClear();
    mockGetReviewHead.mockClear();
    mockTriggerReviewBuild.mockReset();
    mockTriggerReviewBuild.mockResolvedValue({ name: 'review-pr-1' });
  });
  afterEach(() => vi.clearAllMocks());

  it('triggers a review build with server-derived sha/host/url + modUserId, stamps building', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      slug: 'my-app',
    });
    const result = await previewRequest({ publishRequestId: PUBREQ, modUserId: 99 });

    expect(mockGetReviewHead).toHaveBeenCalledWith('my-app');
    expect(result.sha).toBe(SHA);
    expect(result.host).toBe(`review-${'a'.repeat(16)}.civit.ai`);
    expect(result.url).toBe(`https://review-${'a'.repeat(16)}.civit.ai/my-app`);

    expect(mockTriggerReviewBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'my-app',
        sha: SHA,
        publishRequestId: PUBREQ,
        modUserId: 99,
        callbackUrl: 'https://civitai.com/api/internal/blocks/review-build-callback',
      })
    );
    // building state stamped (first updateMany call).
    const buildingCall = mockDbWrite.appBlockPublishRequest.updateMany.mock.calls.find(
      ([arg]: any[]) => arg.data.deployState === 'preview-building'
    );
    expect(buildingCall).toBeDefined();
  });

  it('refuses a non-pending request', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'approved',
      slug: 'my-app',
    });
    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 1 })).rejects.toThrow(
      /pending/
    );
    expect(mockTriggerReviewBuild).not.toHaveBeenCalled();
  });

  it('flips to preview-failed and re-throws when the trigger fails', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      slug: 'my-app',
    });
    mockTriggerReviewBuild.mockRejectedValue(new Error('receiver 500'));
    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 1 })).rejects.toThrow(
      /could not start review build/
    );
    const failedCall = mockDbWrite.appBlockPublishRequest.updateMany.mock.calls.find(
      ([arg]: any[]) => arg.data.deployState === 'preview-failed'
    );
    expect(failedCall).toBeDefined();
  });
});

describe('getReviewStatus', () => {
  beforeEach(() => mockDbRead.appBlockPublishRequest.findUnique.mockReset());

  it('returns the preview state + parsed detail', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ url: 'https://review-x.civit.ai/my-app', sha: SHA }),
      deployUpdatedAt: new Date(),
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ });
    expect(r.state).toBe('preview-live');
    expect(r.detail.url).toBe('https://review-x.civit.ai/my-app');
  });

  it('returns state:null for a non-preview deploy_state (production building)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'approved',
      deployState: 'building',
      deployDetail: null,
      deployUpdatedAt: null,
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ });
    expect(r.state).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getReviewStatus mint surface (#2847 auth bridge): a live preview + a calling
// mod id → a FRESH mod-bound, host-bound, short-TTL `previewUrl` (?mr=<token>).
// ---------------------------------------------------------------------------
describe('getReviewStatus previewUrl mint surface', () => {
  const SECRET = 'test-nextauth-secret-cccccccccccccccccccc';
  const HOST = 'review-aaaaaaaaaaaaaaaa.civit.ai';
  const URL = `https://${HOST}/my-app`;
  const prevSecret = process.env.NEXTAUTH_SECRET;

  beforeEach(() => {
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    process.env.NEXTAUTH_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = prevSecret;
  });

  it('mints a previewUrl bound to the calling mod when preview-live + modUserId supplied', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ url: URL, host: HOST, sha: SHA }),
      deployUpdatedAt: new Date(),
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ, modUserId: 4242 });
    expect(r.previewUrl).toBeDefined();
    expect(r.previewUrl!.startsWith(`${URL}?mr=`)).toBe(true);

    // The minted token verifies for THIS host + carries the calling mod id.
    const { verifyReviewAccessToken } = await import(
      '~/server/services/blocks/review-session'
    );
    const token = decodeURIComponent(r.previewUrl!.split('?mr=')[1]);
    expect(verifyReviewAccessToken(token, HOST, { secret: SECRET })).toEqual({
      ok: true,
      modUserId: 4242,
    });
  });

  it('does NOT mint a previewUrl when modUserId is omitted', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ url: URL, host: HOST, sha: SHA }),
      deployUpdatedAt: new Date(),
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ });
    expect(r.previewUrl).toBeUndefined();
  });

  it('does NOT mint a previewUrl when the preview is not live (building)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-building',
      deployDetail: JSON.stringify({ url: URL, host: HOST, sha: SHA }),
      deployUpdatedAt: new Date(),
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ, modUserId: 4242 });
    expect(r.previewUrl).toBeUndefined();
  });

  it('does NOT mint a previewUrl when detail.host is missing', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ url: URL, sha: SHA }), // no host
      deployUpdatedAt: new Date(),
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ, modUserId: 4242 });
    expect(r.previewUrl).toBeUndefined();
  });
});

describe('teardownReviewForRequest', () => {
  beforeEach(() => {
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockDeleteReviewResources.mockClear();
  });

  it('deletes review resources by publish request (label selector is the boundary)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      slug: 'my-app',
      deployState: 'building', // production value — still must tear down via selector
      deployDetail: JSON.stringify({ sha: SHA }),
    });
    await teardownReviewForRequest(PUBREQ);
    expect(mockDeleteReviewResources).toHaveBeenCalledWith({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
    });
  });

  it('never throws even if the delete fails', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      slug: 'my-app',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ sha: SHA }),
    });
    mockDeleteReviewResources.mockRejectedValue(new Error('k8s down'));
    await expect(teardownReviewForRequest(PUBREQ)).resolves.toBeUndefined();
  });
});

describe('withdrawRequest review teardown (#2831)', () => {
  const USER = 7;
  beforeEach(() => {
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockDbWrite.appBlockPublishRequest.updateMany.mockReset();
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
    mockDeleteReviewResources.mockClear();
  });

  it('tears down the review env when a previewed request is self-withdrawn', async () => {
    // First findUnique = the classify-read in withdrawRequest; second = the read
    // inside teardownReviewForRequest. Both return a previewed, owned, pending row.
    mockDbRead.appBlockPublishRequest.findUnique
      .mockResolvedValueOnce({
        id: PUBREQ,
        status: 'pending',
        submittedByUserId: USER,
        deployState: 'preview-live',
      })
      .mockResolvedValueOnce({
        slug: 'my-app',
        deployState: 'preview-live',
        deployDetail: JSON.stringify({ sha: SHA }),
      });

    await withdrawRequest({ publishRequestId: PUBREQ, userId: USER });
    // teardown is fire-and-forget (void) — let the microtask flush.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockDbWrite.appBlockPublishRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PUBREQ, status: 'pending' }, data: { status: 'withdrawn' } })
    );
    expect(mockDeleteReviewResources).toHaveBeenCalledWith({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
    });
  });

  it('does NOT tear down when no preview was started', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValueOnce({
      id: PUBREQ,
      status: 'pending',
      submittedByUserId: USER,
      deployState: null,
    });

    await withdrawRequest({ publishRequestId: PUBREQ, userId: USER });
    await new Promise((r) => setTimeout(r, 0));

    expect(mockDeleteReviewResources).not.toHaveBeenCalled();
  });
});

describe('parseReviewDetail', () => {
  it('tolerates null / non-JSON', () => {
    expect(parseReviewDetail(null)).toEqual({});
    expect(parseReviewDetail('not json')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Concurrency cap — countActiveReviewPreviews builds the ACTIVE predicate
// (pending + preview-building/deploying/live + within the TTL window). The DB
// filtering is mocked away, so we assert the WHERE clause carries the exact
// predicate (that's what excludes failed/null/expired/non-pending in prod) and
// that the count is the returned row count.
// ---------------------------------------------------------------------------
describe('countActiveReviewPreviews', () => {
  beforeEach(() => {
    mockDbRead.appBlockPublishRequest.findMany.mockReset();
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
  });

  it('queries pending + active preview-* states within the TTL window, oldest-first', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      { id: 'a', slug: 's1', version: '1.0.0', deployState: 'preview-live', deployDetail: null, deployUpdatedAt: new Date() },
      { id: 'b', slug: 's2', version: '1.0.0', deployState: 'preview-building', deployDetail: null, deployUpdatedAt: new Date() },
    ]);
    const before = Date.now();
    const count = await countActiveReviewPreviews();
    expect(count).toBe(2);

    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.where.status).toBe('pending');
    expect(arg.where.deployState).toEqual({
      in: ['preview-building', 'preview-deploying', 'preview-live'],
    });
    // TTL cutoff ≈ now - REVIEW_PREVIEW_TTL_MS (excludes rows older than 6h).
    const cutoff: Date = arg.where.deployUpdatedAt.gt;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeLessThanOrEqual(before - REVIEW_PREVIEW_TTL_MS + 5000);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - REVIEW_PREVIEW_TTL_MS - 5000);
    // oldest-first — the natural teardown order.
    expect(arg.orderBy).toEqual({ deployUpdatedAt: 'asc' });
    // no exclusion by default.
    expect(arg.where.id).toBeUndefined();
  });

  it('respects excludePublishRequestId (so a rebuild never counts itself)', async () => {
    await countActiveReviewPreviews({ excludePublishRequestId: PUBREQ });
    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.where.id).toEqual({ not: PUBREQ });
  });
});

// ---------------------------------------------------------------------------
// previewRequest cap enforcement — blocks a fresh request when MAX others are
// active; allows a rebuild of an already-active request (self excluded).
// ---------------------------------------------------------------------------
describe('previewRequest concurrency cap', () => {
  beforeEach(() => {
    process.env.NEXTAUTH_URL = 'https://civitai.com';
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      slug: 'my-app',
    });
    mockDbRead.appBlockPublishRequest.findMany.mockReset();
    mockDbWrite.appBlockPublishRequest.updateMany.mockClear();
    mockGetReviewHead.mockClear();
    mockTriggerReviewBuild.mockReset();
    mockTriggerReviewBuild.mockResolvedValue({ name: 'review-pr-1' });
  });
  afterEach(() => vi.clearAllMocks());

  it('throws (naming the cap + active slugs) when MAX others are active', async () => {
    const others = Array.from({ length: MAX_CONCURRENT_REVIEW_PREVIEWS }, (_, i) => ({
      id: `other-${i}`,
      slug: `other-app-${i}`,
      version: '1.0.0',
      deployState: 'preview-live',
      deployDetail: null,
      deployUpdatedAt: new Date(),
    }));
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue(others);

    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 1 })).rejects.toThrow(
      new RegExp(`cap reached \\(${MAX_CONCURRENT_REVIEW_PREVIEWS}/${MAX_CONCURRENT_REVIEW_PREVIEWS} active\\)`)
    );
    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 1 })).rejects.toThrow(
      /other-app-0/
    );
    // The cap query excluded THIS request.
    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.where.id).toEqual({ not: PUBREQ });
    expect(mockTriggerReviewBuild).not.toHaveBeenCalled();
  });

  it('allows a rebuild of an already-active request when MAX total active (self excluded → 4 others)', async () => {
    // Self is one of the 5 active, so the exclude-self query returns 4 others.
    const others = Array.from({ length: MAX_CONCURRENT_REVIEW_PREVIEWS - 1 }, (_, i) => ({
      id: `other-${i}`,
      slug: `other-app-${i}`,
      version: '1.0.0',
      deployState: 'preview-live',
      deployDetail: null,
      deployUpdatedAt: new Date(),
    }));
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue(others);

    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 1 })).resolves.toBeDefined();
    expect(mockTriggerReviewBuild).toHaveBeenCalled();
  });

  it('proceeds under the cap', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      { id: 'x', slug: 'x', version: '1.0.0', deployState: 'preview-live', deployDetail: null, deployUpdatedAt: new Date() },
    ]);
    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 1 })).resolves.toBeDefined();
    expect(mockTriggerReviewBuild).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// teardownPreview — manual, per-request, label-scoped delete + DB clear.
// ---------------------------------------------------------------------------
describe('teardownPreview', () => {
  beforeEach(() => {
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockDbWrite.appBlockPublishRequest.update.mockReset();
    mockDbWrite.appBlockPublishRequest.update.mockResolvedValue({});
    mockDeleteReviewResources.mockReset();
    mockDeleteReviewResources.mockResolvedValue(undefined);
  });

  it('preview-live pending: deletes review resources by request + clears DB, tornDown:true', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ sha: SHA, host: 'h' }),
      slug: 'my-app',
    });
    const res = await teardownPreview({ publishRequestId: PUBREQ });
    expect(res).toEqual({ publishRequestId: PUBREQ, tornDown: true });
    expect(mockDeleteReviewResources).toHaveBeenCalledWith({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
    });
    const updateArg = mockDbWrite.appBlockPublishRequest.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: PUBREQ });
    expect(updateArg.data.deployState).toBeNull();
    expect(updateArg.data.deployDetail).toBeNull();
    expect(updateArg.data.deployUpdatedAt).toBeInstanceOf(Date);
  });

  it('non-pending / non-preview state: no-op, tornDown:false (no delete, no DB clear)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'approved',
      deployState: 'building', // production value, not a preview-*
      deployDetail: null,
      slug: 'my-app',
    });
    const res = await teardownPreview({ publishRequestId: PUBREQ });
    expect(res).toEqual({ publishRequestId: PUBREQ, tornDown: false });
    expect(mockDeleteReviewResources).not.toHaveBeenCalled();
    expect(mockDbWrite.appBlockPublishRequest.update).not.toHaveBeenCalled();
  });

  it('best-effort: k8s delete throwing still clears the DB + returns tornDown:true', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-building',
      deployDetail: JSON.stringify({ sha: SHA }),
      slug: 'my-app',
    });
    mockDeleteReviewResources.mockRejectedValue(new Error('k8s down'));
    const res = await teardownPreview({ publishRequestId: PUBREQ });
    expect(res.tornDown).toBe(true);
    expect(mockDbWrite.appBlockPublishRequest.update).toHaveBeenCalled();
  });

  it('throws when the request is not found', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(null);
    await expect(teardownPreview({ publishRequestId: PUBREQ })).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// listActiveReviewPreviews — the global panel's feed (cap + active rows).
// ---------------------------------------------------------------------------
describe('listActiveReviewPreviews', () => {
  beforeEach(() => {
    mockDbRead.appBlockPublishRequest.findMany.mockReset();
  });

  it('returns cap + mapped active rows (host from detail), querying oldest-first', async () => {
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        id: 'a',
        slug: 's1',
        version: '1.0.0',
        deployState: 'preview-live',
        deployDetail: JSON.stringify({ host: 'review-a.civit.ai', sha: SHA }),
        deployUpdatedAt: older,
      },
      {
        id: 'b',
        slug: 's2',
        version: '2.0.0',
        deployState: 'preview-building',
        deployDetail: null,
        deployUpdatedAt: newer,
      },
    ]);

    const res = await listActiveReviewPreviews();
    expect(res.cap).toBe(MAX_CONCURRENT_REVIEW_PREVIEWS);
    expect(res.active).toEqual([
      {
        publishRequestId: 'a',
        slug: 's1',
        version: '1.0.0',
        state: 'preview-live',
        host: 'review-a.civit.ai',
        updatedAt: older,
      },
      {
        publishRequestId: 'b',
        slug: 's2',
        version: '2.0.0',
        state: 'preview-building',
        host: null,
        updatedAt: newer,
      },
    ]);

    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.where.status).toBe('pending');
    expect(arg.where.deployState).toEqual({
      in: ['preview-building', 'preview-deploying', 'preview-live'],
    });
    expect(arg.orderBy).toEqual({ deployUpdatedAt: 'asc' });
  });

  it('returns an empty active list + the cap when nothing is active', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    const res = await listActiveReviewPreviews();
    expect(res).toEqual({ cap: MAX_CONCURRENT_REVIEW_PREVIEWS, active: [] });
  });
});
