import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';

/**
 * MOD REVIEW SANDBOX (#2831) — coverage for POST
 * /api/internal/blocks/review-build-callback:
 *   - HMAC verification (BLOCK_BUILD_CALLBACK_SECRET) — bad sig → 401
 *   - pipeline flag kill-switch (503 when dark)
 *   - mode must be 'review'
 *   - review imageRef binding (expectedReviewImageRef helper, pure)
 *   - on success → triggerApplyReview + preview-deploying state
 *   - on failure → preview-failed state, no apply
 */

const {
  SECRET,
  mockEnvStore,
  mockFlag,
  mockTriggerApplyReview,
  mockWaitApply,
  mockWaitReachable,
  mockMarkPreview,
  mockFindUnique,
  mockSetNx,
  mockRedisDel,
} = vi.hoisted(() => {
  const SECRET = 'test-build-callback-secret';
  return {
    SECRET,
    mockEnvStore: { BLOCK_BUILD_CALLBACK_SECRET: SECRET } as Record<string, unknown>,
    mockFlag: { enabled: true },
    mockTriggerApplyReview: vi.fn(async () => ({ name: 'review-apply-1' })),
    mockWaitApply: vi.fn(async () => 'succeeded'),
    // Default: the review host becomes reachable → the watcher marks preview-live.
    mockWaitReachable: vi.fn(async () => true),
    mockMarkPreview: vi.fn(async () => undefined),
    // Default row = an ACTIVE preview (pending + a preview-* deployState) so the
    // callback's "preview no longer active" guard does NOT abort. Torn-down /
    // decided cases override this per-test (deployDetail/deployState nullable).
    mockFindUnique: vi.fn(
      async (): Promise<{
        deployDetail: string | null;
        status: string;
        deployState: string | null;
      }> => ({
        deployDetail: JSON.stringify({ url: 'https://x/y' }),
        status: 'pending',
        deployState: 'preview-building',
      })
    ),
    // replay-guard primitive — true = newly set (first callback → run apply).
    mockSetNx: vi.fn(async () => true),
    mockRedisDel: vi.fn(async () => undefined),
  };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/env/server', () => ({
  env: new Proxy(mockEnvStore, {
    get(t, p: string) {
      if (p in t) return t[p];
      return undefined;
    },
  }),
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn(async (flag: string) =>
    flag === 'app-blocks-pipeline-enabled' ? mockFlag.enabled : false
  ),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlockPublishRequest: { findUnique: mockFindUnique } },
  dbWrite: {},
}));
vi.mock('~/server/redis/client', () => ({
  redis: { setNxKeepTtlWithEx: mockSetNx, del: mockRedisDel },
  REDIS_KEYS: { BLOCKS: { TOKEN_RATE_LIMIT: 'blocks:token-rate-limit' } },
}));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerApplyReview: mockTriggerApplyReview,
  waitForApplyJob: mockWaitApply,
  waitForReviewHostReachable: mockWaitReachable,
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  markReviewPreviewState: mockMarkPreview,
  parseReviewDetail: (raw: string | null | undefined) => {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  },
}));

import handler, {
  expectedReviewImageRef,
  verifySignature,
  checkCallbackTimestamp,
  watchReviewApplyJob,
} from '~/pages/api/internal/blocks/review-build-callback';

const SLUG = 'my-app';
const SHA = 'a'.repeat(40);
const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';

function sign(body: string) {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

function makeReqRes(body: string, sig?: string) {
  const stream = Readable.from([Buffer.from(body)]) as unknown as NextApiRequest;
  stream.method = 'POST';
  (stream as any).headers = { 'x-appblocks-signature': sig ?? sign(body) };
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader() {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return { req: stream, res: res as unknown as NextApiResponse & { statusCode: number; body: any } };
}

describe('expectedReviewImageRef (pure)', () => {
  it('binds to the review-prefixed image', () => {
    expect(expectedReviewImageRef(SLUG, SHA)).toBe(`ghcr.io/civitai/app-block-review-${SLUG}:${SHA}`);
  });
});

describe('checkCallbackTimestamp (pure)', () => {
  it('allows an absent ts', () => {
    expect(checkCallbackTimestamp(undefined).ok).toBe(true);
  });
  it('rejects a stale ts', () => {
    expect(checkCallbackTimestamp(1).ok).toBe(false);
  });
});

describe('verifySignature (pure)', () => {
  it('rejects a missing header', () => {
    expect(verifySignature(Buffer.from('x'), undefined)).toBe(false);
  });
});

describe('POST /api/internal/blocks/review-build-callback', () => {
  beforeEach(() => {
    mockFlag.enabled = true;
    mockTriggerApplyReview.mockClear();
    mockMarkPreview.mockClear();
    mockSetNx.mockClear();
    mockSetNx.mockResolvedValue(true);
    mockRedisDel.mockClear();
    mockWaitApply.mockClear();
    mockWaitApply.mockResolvedValue('succeeded');
    mockWaitReachable.mockClear();
    mockWaitReachable.mockResolvedValue(true);
  });
  afterEach(() => vi.clearAllMocks());

  const goodBody = () =>
    JSON.stringify({
      mode: 'review',
      slug: SLUG,
      sha: SHA,
      publishRequestId: PUBREQ,
      imageRef: expectedReviewImageRef(SLUG, SHA),
      status: 'Succeeded',
    });

  it('401 on a bad signature', async () => {
    const { req, res } = makeReqRes(goodBody(), 'deadbeef');
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockTriggerApplyReview).not.toHaveBeenCalled();
  });

  it('503 when the pipeline flag is off', async () => {
    mockFlag.enabled = false;
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.statusCode).toBe(503);
  });

  it('400 when mode is not review', async () => {
    const body = JSON.stringify({
      mode: 'build',
      slug: SLUG,
      sha: SHA,
      publishRequestId: PUBREQ,
      imageRef: expectedReviewImageRef(SLUG, SHA),
      status: 'Succeeded',
    });
    const { req, res } = makeReqRes(body);
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('400 when imageRef does not match the review slug/sha', async () => {
    const body = JSON.stringify({
      mode: 'review',
      slug: SLUG,
      sha: SHA,
      publishRequestId: PUBREQ,
      imageRef: `ghcr.io/civitai/app-block-${SLUG}:${SHA}`, // production image, not review
      status: 'Succeeded',
    });
    const { req, res } = makeReqRes(body);
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(mockTriggerApplyReview).not.toHaveBeenCalled();
  });

  it('on success → triggers review apply + marks deploying', async () => {
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(mockTriggerApplyReview).toHaveBeenCalledWith(
      expect.objectContaining({ slug: SLUG, sha: SHA, publishRequestId: PUBREQ })
    );
    expect(mockMarkPreview).toHaveBeenCalledWith(
      PUBREQ,
      'preview-deploying',
      expect.anything(),
      { requireActivePreview: true }
    );
  });

  it('replay guard: a duplicate success callback short-circuits before the apply', async () => {
    // setNx returns false → key already present → this is a replay.
    mockSetNx.mockResolvedValueOnce(false);
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ applied: false, reason: 'duplicate callback (replay-guarded)' });
    expect(mockTriggerApplyReview).not.toHaveBeenCalled();
  });

  it('on build failure → marks failed, no apply', async () => {
    const body = JSON.stringify({
      mode: 'review',
      slug: SLUG,
      sha: SHA,
      publishRequestId: PUBREQ,
      imageRef: expectedReviewImageRef(SLUG, SHA),
      status: 'Failed',
    });
    const { req, res } = makeReqRes(body);
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ applied: false });
    expect(mockTriggerApplyReview).not.toHaveBeenCalled();
    expect(mockMarkPreview).toHaveBeenCalledWith(
      PUBREQ,
      'preview-failed',
      expect.anything(),
      { requireActivePreview: true }
    );
  });

  it('torn-down mid-build → aborts: no apply, no state write, no resurrection', async () => {
    // A mod tore the preview down while the build was running: teardownPreview
    // cleared deployState→null but left status='pending'. A SUCCESS callback must
    // NOT re-create the k8s resources or re-write preview-live (which would
    // silently refill the cap slot with a detail-less zombie).
    mockFindUnique.mockResolvedValueOnce({
      deployDetail: null,
      status: 'pending',
      deployState: null,
    });
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      applied: false,
      reason: 'preview no longer active (torn down or decided)',
    });
    expect(mockTriggerApplyReview).not.toHaveBeenCalled();
    expect(mockMarkPreview).not.toHaveBeenCalled();
  });

  it('request already decided (approved) → aborts: no apply, no state write', async () => {
    // The request was approved/rejected before the build finished; the approve
    // path already tore down + flipped deployState to a production value. A late
    // review success callback must not touch it.
    mockFindUnique.mockResolvedValueOnce({
      deployDetail: null,
      status: 'approved',
      deployState: 'building', // production build state (no preview- prefix)
    });
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ applied: false });
    expect(mockTriggerApplyReview).not.toHaveBeenCalled();
    expect(mockMarkPreview).not.toHaveBeenCalled();
  });
});

// The apply watcher runs fire-and-forget AFTER the handler returns 200 to Tekton,
// so it can't be observed through the HTTP response — drive it directly. This is
// where the DNS-reachability gate lives: on a successful apply we only mark
// preview-live once the PUBLIC review host actually answers, so a mod never
// clicks through to ERR_NAME_NOT_RESOLVED while the per-host DNS record is still
// propagating.
describe('watchReviewApplyJob (reachability gate)', () => {
  const HOST = 'review-abc123def4567890.civit.ai';
  const baseDetail = { sha: SHA, host: HOST, url: `https://${HOST}/${SLUG}` };

  beforeEach(() => {
    mockWaitApply.mockClear();
    mockWaitApply.mockResolvedValue('succeeded');
    mockWaitReachable.mockClear();
    mockWaitReachable.mockResolvedValue(true);
    mockMarkPreview.mockClear();
    mockRedisDel.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it('apply succeeded + host reachable → marks preview-live', async () => {
    await watchReviewApplyJob({
      publishRequestId: PUBREQ,
      sha: SHA,
      jobName: 'review-apply-1',
      baseDetail,
    });
    expect(mockWaitReachable).toHaveBeenCalledWith(HOST);
    expect(mockMarkPreview).toHaveBeenCalledWith(
      PUBREQ,
      'preview-live',
      baseDetail,
      { requireActivePreview: true }
    );
    // Not marked failed, and the dedup slot is NOT freed on the happy path.
    expect(mockMarkPreview).toHaveBeenCalledTimes(1);
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it('apply succeeded + host NEVER reachable → marks preview-failed with the DNS detail + frees the dedup slot', async () => {
    mockWaitReachable.mockResolvedValueOnce(false);
    await watchReviewApplyJob({
      publishRequestId: PUBREQ,
      sha: SHA,
      jobName: 'review-apply-1',
      baseDetail,
    });
    // Must NOT go live — that's the whole point of the gate.
    expect(mockMarkPreview).not.toHaveBeenCalledWith(
      PUBREQ,
      'preview-live',
      expect.anything(),
      expect.anything()
    );
    expect(mockMarkPreview).toHaveBeenCalledWith(
      PUBREQ,
      'preview-failed',
      expect.objectContaining({ error: expect.stringContaining('DNS propagation') }),
      { requireActivePreview: true }
    );
    // Dedup slot freed (mirrors the other definitive-failed path) so a same-sha
    // rebuild isn't suppressed within the TTL window.
    expect(mockRedisDel).toHaveBeenCalledTimes(1);
  });

  it('is the gate: removing the reachable check would let a not-reachable host go live', async () => {
    // Sanity anchor for the gate — with reachable=false the ONLY live-marking
    // call count is 0. (If the gate were removed this would be 1 and the test
    // would fail, per the task requirement.)
    mockWaitReachable.mockResolvedValueOnce(false);
    await watchReviewApplyJob({
      publishRequestId: PUBREQ,
      sha: SHA,
      jobName: 'review-apply-1',
      baseDetail,
    });
    const liveCalls = (mockMarkPreview.mock.calls as unknown[][]).filter(
      (c) => c[1] === 'preview-live'
    );
    expect(liveCalls).toHaveLength(0);
  });

  it('apply failed → marks preview-failed, never probes reachability, frees the dedup slot', async () => {
    mockWaitApply.mockResolvedValueOnce('failed');
    await watchReviewApplyJob({
      publishRequestId: PUBREQ,
      sha: SHA,
      jobName: 'review-apply-1',
      baseDetail,
    });
    expect(mockWaitReachable).not.toHaveBeenCalled();
    expect(mockMarkPreview).toHaveBeenCalledWith(
      PUBREQ,
      'preview-failed',
      expect.objectContaining({ error: 'review deploy failed' }),
      { requireActivePreview: true }
    );
    expect(mockRedisDel).toHaveBeenCalledTimes(1);
  });

  it('apply timeout → marks preview-failed, never probes reachability, does NOT free the dedup slot', async () => {
    mockWaitApply.mockResolvedValueOnce('timeout');
    await watchReviewApplyJob({
      publishRequestId: PUBREQ,
      sha: SHA,
      jobName: 'review-apply-1',
      baseDetail,
    });
    expect(mockWaitReachable).not.toHaveBeenCalled();
    expect(mockMarkPreview).toHaveBeenCalledWith(
      PUBREQ,
      'preview-failed',
      expect.objectContaining({ error: 'review deploy timed out' }),
      { requireActivePreview: true }
    );
    // 'timeout' leaves the dedup slot for the TTL (the Job may still run).
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it('no host on the detail (degraded read) → skips the probe and marks live', async () => {
    await watchReviewApplyJob({
      publishRequestId: PUBREQ,
      sha: SHA,
      jobName: 'review-apply-1',
      baseDetail: { sha: SHA },
    });
    expect(mockWaitReachable).not.toHaveBeenCalled();
    expect(mockMarkPreview).toHaveBeenCalledWith(
      PUBREQ,
      'preview-live',
      { sha: SHA },
      { requireActivePreview: true }
    );
  });
});
