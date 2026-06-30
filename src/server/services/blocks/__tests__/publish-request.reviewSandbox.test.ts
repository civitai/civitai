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
    appBlockPublishRequest: { findUnique: vi.fn() },
  },
  mockDbWrite: {
    appBlockPublishRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
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
  withdrawRequest,
  parseReviewDetail,
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
