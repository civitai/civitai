import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import type * as BuildAttemptsService from '~/server/services/blocks/build-attempts.service';
import client from 'prom-client';
import { APP_BLOCK_BUILDS_METRIC } from '~/server/prom/app-block-build.metrics';

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
  mockRelease,
  mockReviewUnpublish,
  mockTriggerApplyReview,
  mockWaitApply,
  mockWaitReachable,
  mockMarkPreview,
  mockFindUnique,
  mockSetNx,
  mockRedisDel,
  mockSuperseded,
  mockRecordAttempt,
} = vi.hoisted(() => {
  const SECRET = 'test-build-callback-secret';
  return {
    SECRET,
    mockEnvStore: { BLOCK_BUILD_CALLBACK_SECRET: SECRET } as Record<string, unknown>,
    mockFlag: { enabled: true, sharedServer: false },
    mockRelease: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
    mockReviewUnpublish: vi.fn(async (..._a: unknown[]) => ({ name: 'review-unpub-1' })),
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
    // The stale-run guard's answer (its own logic is covered with an in-memory table in
    // the production build-callback suite and the service suite).
    mockSuperseded: vi.fn(async () => false),
    mockRecordAttempt: vi.fn(async () => true),
  };
});
vi.mock('~/server/services/blocks/build-attempts.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuildAttemptsService>()),
  isSupersededRun: mockSuperseded,
  recordBuildAttempt: mockRecordAttempt,
}));

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
    flag === 'app-blocks-pipeline-enabled'
      ? mockFlag.enabled
      : flag === 'app-blocks-review-shared-server'
      ? mockFlag.sharedServer
      : false
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
  triggerReviewUnpublish: (...a: unknown[]) => mockReviewUnpublish(...a),
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  markReviewPreviewState: mockMarkPreview,
  releaseSettledBuildSlot: (...a: unknown[]) => mockRelease(...a),
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
  watchDirectPublishedReview,
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
  return {
    req: stream,
    res: res as unknown as NextApiResponse & { statusCode: number; body: any },
  };
}

/** The live counter value of one review build-outcome series (0 before the series exists). */
async function reviewOutcomeCount(failedStep: string): Promise<number> {
  const metric = client.register.getSingleMetric(APP_BLOCK_BUILDS_METRIC) as unknown as
    | { get(): Promise<{ values: { labels: Record<string, string>; value: number }[] }> }
    | undefined;
  if (!metric) return 0;
  const row = (await metric.get()).values.find(
    (v) =>
      v.labels.mode === 'review' &&
      v.labels.outcome === 'failed' &&
      v.labels.failed_step === failedStep
  );
  return row?.value ?? 0;
}

/** The moderator-visible text when a DIRECT publish never answers its probe (pinned whole). */
const DIRECT_UNREACHABLE_ERROR =
  'Preview published, but it never answered through the review gate (its page at / must return 200). The build may be broken: check it, then rebuild.';
/** The apply lane's text for the same probe failure (unchanged by the direct lane). */
const APPLY_UNREACHABLE_ERROR =
  'Preview deployed but its host did not become reachable in time (DNS propagation). Rebuild to retry.';

describe('expectedReviewImageRef (pure)', () => {
  it('binds to the review-prefixed image', () => {
    expect(expectedReviewImageRef(SLUG, SHA)).toBe(
      `ghcr.io/civitai/app-block-review-${SLUG}:${SHA}`
    );
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
    expect(mockMarkPreview).toHaveBeenCalledWith(PUBREQ, 'preview-deploying', expect.anything(), {
      requireActivePreview: true,
    });
  });

  it('replay guard: a duplicate success callback short-circuits before the apply', async () => {
    // setNx returns false → key already present → this is a replay.
    mockSetNx.mockResolvedValueOnce(false);
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      applied: false,
      reason: 'duplicate callback (replay-guarded)',
    });
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
    expect(mockMarkPreview).toHaveBeenCalledWith(PUBREQ, 'preview-failed', expect.anything(), {
      requireActivePreview: true,
    });
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

  // A finished build of a request that is no longer an active preview (torn down mid-build,
  // superseded, decided) releases the build slot its row still holds, so the queue moves on.
  it('a build finishing for a no-longer-active preview releases its build slot', async () => {
    mockRelease.mockClear();
    mockFindUnique.mockResolvedValueOnce({
      deployDetail: null,
      status: 'withdrawn',
      deployState: 'preview-building',
    });
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.body).toMatchObject({ applied: false });
    expect(mockRelease).toHaveBeenCalledWith(PUBREQ, { sha: SHA });
  });

  it('a torn-down-mid-build preview (no preview, build detail kept) is not resurrected by its build', async () => {
    mockRelease.mockClear();
    mockFindUnique.mockResolvedValueOnce({
      deployDetail: JSON.stringify({ actor: 'system', buildStartedAt: '2026-11-09T00:00:00.000Z' }),
      status: 'pending',
      deployState: null,
    });
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.body).toMatchObject({ applied: false });
    expect(mockTriggerApplyReview).not.toHaveBeenCalled();
    // Only THIS build's slot: identified by its sha.
    expect(mockRelease).toHaveBeenCalledWith(PUBREQ, { sha: SHA });
  });

  it.each([true, false])(
    'the serving mode (shared server = %s) is recorded on the preview detail from the deploying write on',
    async (on) => {
      mockFlag.sharedServer = on;
      mockMarkPreview.mockClear();
      try {
        const { req, res } = makeReqRes(goodBody());
        await handler(req, res);
        expect(mockMarkPreview).toHaveBeenCalledWith(
          PUBREQ,
          'preview-deploying',
          expect.objectContaining({ sha: SHA, sharedServer: on }),
          { requireActivePreview: true }
        );
      } finally {
        mockFlag.sharedServer = false;
      }
    }
  );

  it.each([true, false])(
    'the review apply Job is told shared server = %s, from the flag read once per build',
    async (on) => {
      mockFlag.sharedServer = on;
      try {
        const { req, res } = makeReqRes(goodBody());
        await handler(req, res);
        expect(mockTriggerApplyReview).toHaveBeenCalledWith(
          expect.objectContaining({ sharedServer: on })
        );
      } finally {
        mockFlag.sharedServer = false;
      }
    }
  );

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

  it('a shared-server preview is probed on the shared route', async () => {
    mockWaitReachable.mockClear();
    await watchReviewApplyJob({
      publishRequestId: PUBREQ,
      sha: SHA,
      jobName: 'review-apply-1',
      baseDetail,
      sharedServer: true,
      onSettled: () => undefined,
    });
    expect(mockWaitReachable).toHaveBeenCalledWith(HOST, { sharedServer: true });
  });

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
    expect(mockWaitReachable).toHaveBeenCalledWith(HOST, { sharedServer: false });
    expect(mockMarkPreview).toHaveBeenCalledWith(PUBREQ, 'preview-live', baseDetail, {
      requireActivePreview: true,
      expectedSha: SHA,
    });
    // Not marked failed, and the dedup slot is NOT freed on the happy path.
    expect(mockMarkPreview).toHaveBeenCalledTimes(1);
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  // A watcher whose preview was torn down (or superseded by a newer build) writes nothing: its
  // guarded live-mark matches no row. It must not report the build live, or an agent review
  // would start for a preview that no longer exists.
  it.each([
    [1, true],
    [0, false],
  ])('a live-mark matching %d row(s) settles the build with live=%s', async (matched, live) => {
    mockMarkPreview.mockImplementation((async (_id: string, state: string) =>
      state === 'preview-live' ? matched : 0) as never);
    const onSettled = vi.fn();
    await watchReviewApplyJob({
      publishRequestId: PUBREQ,
      sha: SHA,
      jobName: 'review-apply-1',
      baseDetail,
      onSettled,
    });
    expect(onSettled.mock.calls).toEqual([[PUBREQ, live]]);
    mockMarkPreview.mockImplementation(async () => undefined);
  });

  // A row torn down, withdrawn, superseded or decided while its apply ran still holds its build
  // slot, and its build callback has already run: the watcher is what releases it.
  it.each([
    ['succeeded', true],
    ['failed', true],
    ['succeeded', false],
  ] as const)(
    'apply %s (reachable=%s): the settled row releases its build slot before the queue moves',
    async (outcome, reachable) => {
      mockWaitApply.mockResolvedValueOnce(outcome);
      mockWaitReachable.mockResolvedValueOnce(reachable);
      mockRelease.mockClear();
      const order: string[] = [];
      mockRelease.mockImplementationOnce(async () => {
        order.push('release');
      });
      await watchReviewApplyJob({
        publishRequestId: PUBREQ,
        sha: SHA,
        jobName: 'review-apply-1',
        baseDetail,
        onSettled: () => order.push('settled'),
      });
      expect(mockRelease).toHaveBeenCalledWith(PUBREQ, { sha: SHA, buildStartedAt: undefined });
      expect(order).toEqual(['release', 'settled']);
    }
  );

  // An old watcher must never free the slot a newer build of the same request holds.
  it("the watcher releases only its own build's slot (its sha and buildStartedAt)", async () => {
    mockRelease.mockClear();
    const started = '2026-11-09T10:00:00.000Z';
    await watchReviewApplyJob({
      publishRequestId: PUBREQ,
      sha: SHA,
      jobName: 'review-apply-1',
      baseDetail: { ...baseDetail, buildStartedAt: started },
      onSettled: () => undefined,
    });
    expect(mockRelease).toHaveBeenCalledWith(PUBREQ, { sha: SHA, buildStartedAt: started });
  });

  // The apply Job published this sha, but the row stopped being this preview while it ran: its
  // teardown's unpublish may have landed first, and the row no longer has the sha to retry it.
  it.each([
    ['live', true],
    ['host unreachable', false],
  ] as const)(
    'published (%s) for a row that is no longer this preview: the watcher unpublishes that sha',
    async (_label, reachable) => {
      mockReviewUnpublish.mockClear();
      mockWaitReachable.mockResolvedValueOnce(reachable);
      mockMarkPreview.mockImplementation((async () => 0) as never);
      try {
        await watchReviewApplyJob({
          publishRequestId: PUBREQ,
          slug: SLUG,
          sha: SHA,
          jobName: 'review-apply-1',
          baseDetail,
          sharedServer: true,
          onSettled: () => undefined,
        });
      } finally {
        mockMarkPreview.mockImplementation(async () => undefined);
      }
      expect(mockReviewUnpublish).toHaveBeenCalledTimes(1);
      expect(mockReviewUnpublish).toHaveBeenCalledWith({
        slug: SLUG,
        sha: SHA,
        publishRequestId: PUBREQ,
      });
    }
  );

  it.each([
    ['the row is still this preview', 1, true],
    ['the write failed (unknown)', -1, true],
    ['per-preview serving (nothing published to the shared server)', 0, false],
  ] as const)('CONTROL: no unpublish when %s', async (_label, matched, sharedServer) => {
    mockReviewUnpublish.mockClear();
    mockMarkPreview.mockImplementation((async () => matched) as never);
    try {
      await watchReviewApplyJob({
        publishRequestId: PUBREQ,
        slug: SLUG,
        sha: SHA,
        jobName: 'review-apply-1',
        baseDetail,
        sharedServer,
        onSettled: () => undefined,
      });
    } finally {
      mockMarkPreview.mockImplementation(async () => undefined);
    }
    expect(mockReviewUnpublish).not.toHaveBeenCalled();
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
      { requireActivePreview: true, expectedSha: SHA }
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
      { requireActivePreview: true, expectedSha: SHA }
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
      { requireActivePreview: true, expectedSha: SHA }
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
      { requireActivePreview: true, expectedSha: SHA }
    );
  });
});

describe('review-build-callback — structured signals', () => {
  const RUN = 'app-blocks-review-my-app-aaaaaaaa-111111';
  const failBody = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      mode: 'review',
      slug: SLUG,
      sha: SHA,
      publishRequestId: PUBREQ,
      imageRef: expectedReviewImageRef(SLUG, SHA),
      status: 'None',
      ...over,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.enabled = true;
    mockSuperseded.mockResolvedValue(false);
  });

  const errorWritten = () =>
    (mockMarkPreview.mock.calls.at(-1) as unknown as [string, string, { error?: string }])[2].error;

  it('ABSENT signals: the moderator error is byte-identical to before', async () => {
    const { req, res } = makeReqRes(failBody());
    await handler(req, res);
    expect(res.body).toEqual({ ok: true, applied: false, reason: 'review build failed' });
    expect(errorWritten()).toBe('review build None');
    expect(mockRecordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'review',
        status: 'failed',
        publishRequestId: PUBREQ,
        failedStep: undefined,
        failureClass: null,
      })
    );
  });

  it('ORDER: the preview-failed write precedes the attempt row', async () => {
    const { req, res } = makeReqRes(failBody({ failedStep: 'scan', runId: RUN }));
    await handler(req, res);
    expect(mockMarkPreview.mock.invocationCallOrder[0]).toBeLessThan(
      mockRecordAttempt.mock.invocationCallOrder[0]
    );
  });

  it('a reported step names the step and class (structured, no build output)', async () => {
    const { req, res } = makeReqRes(failBody({ failedStep: 'scan', runId: RUN }));
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(errorWritten()).toBe('review build failed at security scan (unknown)');
    expect(mockRecordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN, failedStep: 'scan', failureClass: 'unknown' })
    );
  });

  it('an invalid field is dropped; the failure is still written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { req, res } = makeReqRes(failBody({ failedStep: 'deploy' }));
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(errorWritten()).toBe('review build None');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped invalid optional field(s) failedStep')
    );
    warn.mockRestore();
  });

  it('a failure from a SUPERSEDED run leaves the newer preview alone', async () => {
    mockSuperseded.mockResolvedValue(true);
    const { req, res } = makeReqRes(failBody({ failedStep: 'build', runId: RUN }));
    await handler(req, res);
    expect(res.body).toEqual({ ok: true, applied: false, reason: 'superseded run' });
    expect(mockSuperseded).toHaveBeenCalledWith({
      mode: 'review',
      slug: SLUG,
      sha: SHA,
      runId: RUN,
    });
    expect(mockMarkPreview).not.toHaveBeenCalled();
    // An ignored failure writes no attempt row.
    expect(mockRecordAttempt).not.toHaveBeenCalled();
  });

  it('the preview failure is written even when the attempt write reports failure', async () => {
    mockRecordAttempt.mockResolvedValueOnce(false);
    const { req, res } = makeReqRes(failBody({ failedStep: 'build', runId: RUN }));
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(errorWritten()).toBe('review build failed at build (unknown)');
  });
});

// DIRECT PUBLISH: the review build published the preview to the shared static server itself and
// says so with `directPublish: true` in its signed callback. Success skips the review apply Job
// and goes straight to the shared-route probe; everything without the field is unchanged.
describe('review-build-callback with directPublish: true', () => {
  const HOST = 'review-abc123def4567890.civit.ai';
  const activeRow = {
    deployDetail: JSON.stringify({ sha: SHA, host: HOST, url: `https://${HOST}/${SLUG}` }),
    status: 'pending',
    deployState: 'preview-building',
  };
  const directBody = (fields: Record<string, unknown> = {}) =>
    JSON.stringify({
      mode: 'review',
      slug: SLUG,
      sha: SHA,
      publishRequestId: PUBREQ,
      imageRef: expectedReviewImageRef(SLUG, SHA),
      status: 'Succeeded',
      directPublish: true,
      ...fields,
    });

  beforeEach(() => {
    mockFlag.enabled = true;
    mockFlag.sharedServer = false;
    mockFindUnique.mockResolvedValue(activeRow);
    mockSetNx.mockResolvedValue(true);
    mockWaitReachable.mockResolvedValue(true);
    mockMarkPreview.mockImplementation(async () => undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
    // A once-implementation a case did not consume (the code under test never called it) must
    // not leak into the next case: drop it and restore the default.
    mockReviewUnpublish.mockReset();
    mockReviewUnpublish.mockImplementation(async () => ({ name: 'review-unpub-1' }));
    mockFindUnique.mockReset();
    mockFindUnique.mockResolvedValue({
      deployDetail: JSON.stringify({ url: 'https://x/y' }),
      status: 'pending',
      deployState: 'preview-building',
    });
  });

  it('success: no review apply Job, and the response says it was a direct publish', async () => {
    const { req, res } = makeReqRes(directBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, applied: true, directPublish: true });
    expect(mockTriggerApplyReview).not.toHaveBeenCalled();
  });

  it('success: recorded as served by the shared server even while that flag reads off', async () => {
    const { req, res } = makeReqRes(directBody());
    await handler(req, res);
    expect(mockMarkPreview).toHaveBeenCalledWith(
      PUBREQ,
      'preview-deploying',
      expect.objectContaining({ sha: SHA, host: HOST, sharedServer: true }),
      { requireActivePreview: true }
    );
  });

  it('success: probes the shared route and marks the preview live, waiting on no Job', async () => {
    const { req, res } = makeReqRes(directBody());
    await handler(req, res);
    await vi.waitFor(() =>
      expect(mockMarkPreview).toHaveBeenCalledWith(
        PUBREQ,
        'preview-live',
        expect.objectContaining({ host: HOST, sharedServer: true }),
        { requireActivePreview: true, expectedSha: SHA }
      )
    );
    expect(mockWaitReachable).toHaveBeenCalledWith(HOST, { sharedServer: true });
    expect(mockWaitApply).not.toHaveBeenCalled();
  });

  it('failure: marks the preview failed like any failed build, no apply', async () => {
    const { req, res } = makeReqRes(directBody({ status: 'Failed' }));
    await handler(req, res);
    expect(res.body).toMatchObject({ applied: false, reason: 'review build failed' });
    expect(mockTriggerApplyReview).not.toHaveBeenCalled();
    expect(mockMarkPreview).toHaveBeenCalledWith(PUBREQ, 'preview-failed', expect.anything(), {
      requireActivePreview: true,
    });
  });

  // The build publishes files + meta BEFORE this callback, so a publish that wrote its meta and
  // then failed would leave the preview served (behind the gate) until the bucket lifecycle. A
  // failed direct callback unpublishes its sha, without holding the response, and the row stays
  // failed.
  it('failure: unpublishes what the build may have published, without waiting on it', async () => {
    let finish: (v: { name: string }) => void = () => undefined;
    mockReviewUnpublish.mockImplementationOnce(
      () => new Promise<{ name: string }>((r) => (finish = r))
    );
    const { req, res } = makeReqRes(directBody({ status: 'Failed' }));
    const done = handler(req, res);
    try {
      await vi.waitFor(() => expect(res.statusCode).toBe(200), { timeout: 1000 });
      expect(res.body).toMatchObject({ applied: false, reason: 'review build failed' });
      expect(mockReviewUnpublish.mock.calls).toEqual([
        [{ slug: SLUG, sha: SHA, publishRequestId: PUBREQ }],
      ]);
      const states = (mockMarkPreview.mock.calls as unknown as unknown[][]).map((c) => c[1]);
      expect(states).toEqual(['preview-failed']);
    } finally {
      finish({ name: 'review-unpub-1' });
      await done;
    }
  });

  it('failure: a rejected unpublish does not fail the callback', async () => {
    mockReviewUnpublish.mockRejectedValueOnce(new Error('k8s down'));
    const { req, res } = makeReqRes(directBody({ status: 'Failed' }));
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(mockReviewUnpublish).toHaveBeenCalledTimes(1);
  });

  // A superseded run's late failure must not unpublish: a newer run of the SAME sha may have
  // published the preview the moderator is looking at.
  it('failure from a SUPERSEDED direct run: no unpublish, no state write', async () => {
    mockSuperseded.mockResolvedValueOnce(true);
    const { req, res } = makeReqRes(directBody({ status: 'Failed', runId: 'old-run' }));
    await handler(req, res);
    expect(res.body).toMatchObject({ applied: false, reason: 'superseded run' });
    expect(mockSuperseded).toHaveBeenCalledTimes(1);
    expect(mockReviewUnpublish).not.toHaveBeenCalled();
    expect(mockMarkPreview).not.toHaveBeenCalled();
  });

  // INVARIANT GUARD (green before and after): a failed build without the field published nothing
  // to the shared server, so its callback unpublishes nothing.
  it('failure without the field: no unpublish', async () => {
    mockFlag.sharedServer = true;
    const { req, res } = makeReqRes(directBody({ status: 'Failed', directPublish: undefined }));
    await handler(req, res);
    expect(res.body).toMatchObject({ applied: false, reason: 'review build failed' });
    expect(mockReviewUnpublish).not.toHaveBeenCalled();
  });

  it('success for a preview torn down mid-build: unpublishes what the build just published', async () => {
    mockFindUnique.mockResolvedValue({ deployDetail: null, status: 'pending', deployState: null });
    const { req, res } = makeReqRes(directBody());
    await handler(req, res);
    expect(res.body).toMatchObject({ applied: false });
    expect(mockReviewUnpublish).toHaveBeenCalledWith({
      slug: SLUG,
      sha: SHA,
      publishRequestId: PUBREQ,
    });
    expect(mockTriggerApplyReview).not.toHaveBeenCalled();
    expect(mockMarkPreview).not.toHaveBeenCalled();
  });

  it('a failed unpublish of that orphan does not fail the callback', async () => {
    mockFindUnique.mockResolvedValue({ deployDetail: null, status: 'rejected', deployState: null });
    mockReviewUnpublish.mockRejectedValueOnce(new Error('k8s down'));
    const { req, res } = makeReqRes(directBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(mockRelease).toHaveBeenCalledWith(PUBREQ, { sha: SHA });
  });

  // A direct build can publish its meta and THEN fail (a later step, or its callback reports
  // failure). Its failed detail must still say it was served by the shared server, or a
  // different-sha rebuild (unpublishReplacedSharedPreview needs sharedServer === true and the
  // old sha) skips unpublishing it, and teardown falls back to the CURRENT flag.
  it('failure: the failed detail records sharedServer: true and the sha, even while that flag reads off', async () => {
    const { req, res } = makeReqRes(directBody({ status: 'Failed' }));
    await handler(req, res);
    expect(res.body).toMatchObject({ applied: false, reason: 'review build failed' });
    const failedWrites = (mockMarkPreview.mock.calls as unknown as unknown[][]).filter(
      (c) => c[1] === 'preview-failed'
    );
    expect(failedWrites).toHaveLength(1);
    // What the row will hold, read back the way the rebuild reads it (a JSON round trip).
    const stored = JSON.parse(JSON.stringify(failedWrites[0][2]));
    expect(stored.sharedServer).toBe(true);
    expect(stored.sha).toBe(SHA);
  });

  // INVARIANT GUARD (green before and after): a failed build WITHOUT the field published
  // nothing to the shared server, so its failed detail does not claim it.
  it('failure without the field: the failed detail does not claim the shared server', async () => {
    mockFlag.sharedServer = true;
    const { req, res } = makeReqRes(directBody({ status: 'Failed', directPublish: undefined }));
    await handler(req, res);
    const failedWrites = (mockMarkPreview.mock.calls as unknown as unknown[][]).filter(
      (c) => c[1] === 'preview-failed'
    );
    expect(failedWrites).toHaveLength(1);
    expect((failedWrites[0][2] as { sharedServer?: unknown }).sharedServer).toBeUndefined();
  });

  // The orphan unpublish creates a k8s Job (two API calls with long timeouts) and must not hold
  // the Tekton callback's short request window: the handler answers without waiting on it.
  it('torn-down success: responds without waiting on the orphan unpublish', async () => {
    mockFindUnique.mockResolvedValue({ deployDetail: null, status: 'pending', deployState: null });
    let finish: (v: { name: string }) => void = () => undefined;
    mockReviewUnpublish.mockImplementationOnce(
      () => new Promise<{ name: string }>((r) => (finish = r))
    );
    const { req, res } = makeReqRes(directBody());
    const done = handler(req, res);
    try {
      await vi.waitFor(() => expect(res.statusCode).toBe(200), { timeout: 1000 });
      expect(res.body).toMatchObject({ applied: false });
      expect(mockReviewUnpublish).toHaveBeenCalledTimes(1);
      expect(mockRelease).toHaveBeenCalledWith(PUBREQ, { sha: SHA });
    } finally {
      finish({ name: 'review-unpub-1' });
      await done;
    }
  });

  // A FAILED direct build may also have published before failing; on a row torn down or decided
  // mid-build that teardown's unpublish may have run before the publish landed. Unpublish its sha
  // (not waiting on it), leave the row alone, release the slot as before.
  it('failure for a preview torn down mid-build: unpublishes its sha, without waiting on it', async () => {
    mockFindUnique.mockResolvedValue({ deployDetail: null, status: 'pending', deployState: null });
    let finish: (v: { name: string }) => void = () => undefined;
    mockReviewUnpublish.mockImplementationOnce(
      () => new Promise<{ name: string }>((r) => (finish = r))
    );
    const { req, res } = makeReqRes(directBody({ status: 'Failed' }));
    const done = handler(req, res);
    try {
      await vi.waitFor(() => expect(res.statusCode).toBe(200), { timeout: 1000 });
      expect(res.body).toMatchObject({
        applied: false,
        reason: 'preview no longer active (torn down or decided)',
      });
      expect(mockReviewUnpublish.mock.calls).toEqual([
        [{ slug: SLUG, sha: SHA, publishRequestId: PUBREQ }],
      ]);
      expect(mockMarkPreview).not.toHaveBeenCalled();
      expect(mockRelease).toHaveBeenCalledWith(PUBREQ, { sha: SHA });
    } finally {
      finish({ name: 'review-unpub-1' });
      await done;
    }
  });

  it('failure for a decided preview: a rejected unpublish does not fail the callback', async () => {
    mockFindUnique.mockResolvedValue({ deployDetail: null, status: 'rejected', deployState: null });
    mockReviewUnpublish.mockRejectedValueOnce(new Error('k8s down'));
    const { req, res } = makeReqRes(directBody({ status: 'Failed' }));
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(mockReviewUnpublish).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledWith(PUBREQ, { sha: SHA });
  });

  // GUARD (green before and after): a superseded run's late failure on a torn-down row does not
  // unpublish — a newer run of the same sha may have published.
  it('failure from a SUPERSEDED direct run on a torn-down row: no unpublish, slot still released', async () => {
    mockFindUnique.mockResolvedValue({ deployDetail: null, status: 'pending', deployState: null });
    mockSuperseded.mockResolvedValueOnce(true);
    const { req, res } = makeReqRes(directBody({ status: 'Failed', runId: 'old-run' }));
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(mockReviewUnpublish).not.toHaveBeenCalled();
    expect(mockMarkPreview).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledWith(PUBREQ, { sha: SHA });
  });

  // INVARIANT GUARD (green before and after): a failed build without the field on a torn-down
  // row published nothing to the shared server, so nothing is unpublished.
  it('failure without the field for a torn-down preview: no unpublish', async () => {
    mockFindUnique.mockResolvedValue({ deployDetail: null, status: 'pending', deployState: null });
    const { req, res } = makeReqRes(directBody({ status: 'Failed', directPublish: undefined }));
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(mockReviewUnpublish).not.toHaveBeenCalled();
  });

  // INVARIANT GUARDS (green before the change too): the old body is still the old path.
  it('without the field, a torn-down preview is NOT unpublished by its build callback', async () => {
    mockFindUnique.mockResolvedValue({ deployDetail: null, status: 'pending', deployState: null });
    const { req, res } = makeReqRes(directBody({ directPublish: undefined }));
    await handler(req, res);
    expect(mockReviewUnpublish).not.toHaveBeenCalled();
  });

  it.each(['true', 1, 'yes'])(
    'a non-boolean directPublish (%s) still runs the review apply Job',
    async (v) => {
      const { req, res } = makeReqRes(directBody({ directPublish: v }));
      await handler(req, res);
      expect(mockTriggerApplyReview).toHaveBeenCalledTimes(1);
      expect(res.body).toMatchObject({ applied: true, jobName: 'review-apply-1' });
    }
  );
});

describe('watchDirectPublishedReview', () => {
  const HOST = 'review-abc123def4567890.civit.ai';
  const baseDetail = { sha: SHA, host: HOST, url: `https://${HOST}/${SLUG}` };
  afterEach(() => vi.clearAllMocks());

  it('host never answers: marks failed, frees the replay mark, never waits on an apply Job', async () => {
    mockWaitReachable.mockResolvedValueOnce(false);
    const onSettled = vi.fn();
    await watchDirectPublishedReview({
      publishRequestId: PUBREQ,
      slug: SLUG,
      sha: SHA,
      baseDetail,
      onSettled,
    });
    expect(mockWaitReachable).toHaveBeenCalledWith(HOST, { sharedServer: true });
    expect(mockWaitApply).not.toHaveBeenCalled();
    expect(mockRedisDel).toHaveBeenCalledWith(
      `blocks:token-rate-limit:review-apply:${PUBREQ}:${SHA}`
    );
    expect(mockMarkPreview).toHaveBeenCalledWith(
      PUBREQ,
      'preview-failed',
      expect.objectContaining({ error: DIRECT_UNREACHABLE_ERROR }),
      { requireActivePreview: true, expectedSha: SHA }
    );
    expect(onSettled.mock.calls).toEqual([[PUBREQ, false]]);
  });

  // No apply Job ran on this lane, so its probe failure is not an apply failure: it is not
  // counted under failed_step="apply" (the build itself was already counted as succeeded).
  it('host never answers: NOT counted as an apply failure', async () => {
    mockWaitReachable.mockResolvedValueOnce(false);
    const before = await reviewOutcomeCount('apply');
    await watchDirectPublishedReview({
      publishRequestId: PUBREQ,
      slug: SLUG,
      sha: SHA,
      baseDetail,
      onSettled: () => undefined,
    });
    expect(mockMarkPreview).toHaveBeenCalledWith(
      PUBREQ,
      'preview-failed',
      expect.anything(),
      expect.anything()
    );
    expect((await reviewOutcomeCount('apply')) - before).toBe(0);
  });

  // POSITIVE CONTROL for the case above (green before and after): the same counter read DOES
  // move by one when the apply lane's probe fails, so the 0 above is not a dead instrument.
  it('control: the apply lane probe failure IS counted as an apply failure, with the DNS text', async () => {
    mockWaitApply.mockResolvedValueOnce('succeeded');
    mockWaitReachable.mockResolvedValueOnce(false);
    const before = await reviewOutcomeCount('apply');
    await watchReviewApplyJob({
      publishRequestId: PUBREQ,
      slug: SLUG,
      sha: SHA,
      jobName: 'review-apply-1',
      baseDetail,
      onSettled: () => undefined,
    });
    expect((await reviewOutcomeCount('apply')) - before).toBe(1);
    expect(mockMarkPreview).toHaveBeenCalledWith(
      PUBREQ,
      'preview-failed',
      expect.objectContaining({ error: APPLY_UNREACHABLE_ERROR }),
      { requireActivePreview: true, expectedSha: SHA }
    );
  });

  it('live-mark matching no row (torn down while probing): unpublishes the orphan', async () => {
    mockWaitReachable.mockResolvedValueOnce(true);
    mockMarkPreview.mockImplementationOnce((async () => 0) as never);
    await watchDirectPublishedReview({
      publishRequestId: PUBREQ,
      slug: SLUG,
      sha: SHA,
      baseDetail,
      onSettled: () => undefined,
    });
    expect(mockReviewUnpublish).toHaveBeenCalledWith({
      slug: SLUG,
      sha: SHA,
      publishRequestId: PUBREQ,
    });
  });
});
