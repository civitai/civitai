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
  mockMarkPreview,
  mockFindUnique,
} = vi.hoisted(() => {
  const SECRET = 'test-build-callback-secret';
  return {
    SECRET,
    mockEnvStore: { BLOCK_BUILD_CALLBACK_SECRET: SECRET } as Record<string, unknown>,
    mockFlag: { enabled: true },
    mockTriggerApplyReview: vi.fn(async () => ({ name: 'review-apply-1' })),
    mockWaitApply: vi.fn(async () => 'succeeded'),
    mockMarkPreview: vi.fn(async () => undefined),
    mockFindUnique: vi.fn(async () => ({ deployDetail: JSON.stringify({ url: 'https://x/y' }) })),
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
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerApplyReview: mockTriggerApplyReview,
  waitForApplyJob: mockWaitApply,
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
    expect(mockMarkPreview).toHaveBeenCalledWith(PUBREQ, 'preview-deploying', expect.anything());
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
    expect(mockMarkPreview).toHaveBeenCalledWith(PUBREQ, 'preview-failed', expect.anything());
  });
});
