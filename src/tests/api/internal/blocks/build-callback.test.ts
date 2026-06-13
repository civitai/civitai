import { createHmac } from 'crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Coverage for POST /api/internal/blocks/build-callback:
 *  - L-CALLBACK imageRef binding (pure `expectedImageRef` helper), and
 *  - the security hardening added after the v1 audit: the `appBlocks` flag
 *    kill-switch (503 when dark, matching git-push / workflow-completed) and
 *    the apply-path replay guard (a captured signed callback can't re-trigger
 *    the deploy Job within the dedup window).
 *
 * The handler reads the raw request stream (bodyParser is off) and HMAC-verifies
 * it, so the handler tests build a real signed body and drive the default export.
 */

const { SECRET, mockFlag, mockRedis, mockTriggerApply, mockWaitApply, mockSetCommitStatus, mockAppBlockUpdate } =
  vi.hoisted(() => ({
    SECRET: 'test-build-callback-secret',
    mockFlag: { enabled: true },
    mockRedis: { incrByValue: 1 },
    mockTriggerApply: vi.fn<(...a: any[]) => Promise<{ name: string }>>(async () => ({ name: 'apply-job-1' })),
    mockWaitApply: vi.fn<(...a: any[]) => Promise<string>>(async () => 'succeeded'),
    mockSetCommitStatus: vi.fn(async () => undefined),
    mockAppBlockUpdate: vi.fn(async () => undefined),
  }));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/env/server', () => ({
  env: new Proxy({ BLOCK_BUILD_CALLBACK_SECRET: SECRET } as Record<string, unknown>, {
    get(t, p: string) {
      if (p in t) return t[p];
      if (p === 'LOGGING') return '';
      return undefined;
    },
  }),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: { appBlock: { update: mockAppBlockUpdate } },
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn(async () => mockFlag.enabled) }));
vi.mock('~/server/redis/client', () => ({
  redis: {
    incrBy: vi.fn(async () => mockRedis.incrByValue),
    expire: vi.fn(async () => true),
  },
  REDIS_KEYS: { BLOCKS: { TOKEN_RATE_LIMIT: 'blocks:token-rate-limit' } },
}));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerApply: mockTriggerApply,
  waitForApplyJob: mockWaitApply,
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({ setCommitStatus: mockSetCommitStatus }));

import { expectedImageRef } from '~/pages/api/internal/blocks/build-callback';

/**
 * L-CALLBACK coverage. The handler binds the accepted `imageRef` to ITS OWN
 * slug + sha — a bare `app-block-` prefix check would let a signature-valid
 * callback for slug A carry `app-block-<B>:<sha>` and deploy B's image onto A.
 */
describe('build-callback imageRef binding', () => {
  const SHA = 'a'.repeat(40);

  it('accepts exactly the canonical (slug, sha) image', () => {
    const slug = 'generate-from-model';
    expect(expectedImageRef(slug, SHA)).toBe(`ghcr.io/civitai/app-block-${slug}:${SHA}`);
  });
  it('rejects another slug under the same prefix', () => {
    expect(`ghcr.io/civitai/app-block-slug-b:${SHA}` === expectedImageRef('slug-a', SHA)).toBe(false);
  });
  it('rejects a mutable :latest tag for our own slug', () => {
    expect(`ghcr.io/civitai/app-block-slug-a:latest` === expectedImageRef('slug-a', SHA)).toBe(false);
  });
  it('rejects a different sha for our own slug', () => {
    expect(expectedImageRef('slug-a', 'b'.repeat(40)) === expectedImageRef('slug-a', SHA)).toBe(false);
  });
  it('rejects a prefix-matching but unrelated repo', () => {
    expect(`ghcr.io/civitai/app-block-slug-a-evil:${SHA}` === expectedImageRef('slug-a', SHA)).toBe(false);
  });
});

// ---- handler: flag kill-switch + replay guard --------------------------------

const SLUG = 'generate-from-model';
const SHA = 'a'.repeat(40);
const APB = 'apb_0123456789ABCDEFGHJKMNPQRS'; // matches APB_RE (apb_ + 26 Crockford)

function signedReq(bodyObj: Record<string, unknown>): NextApiRequest {
  const raw = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
  return {
    method: 'POST',
    headers: { 'x-appblocks-signature': sig },
    async *[Symbol.asyncIterator]() {
      yield raw;
    },
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse & { _status: number; _body: any } {
  const res = {
    _status: 0,
    _body: null as any,
    status: vi.fn(function (this: any, n: number) {
      this._status = n;
      return this;
    }),
    json: vi.fn(function (this: any, b: unknown) {
      this._body = b;
      return this;
    }),
    end: vi.fn(function (this: any) {
      return this;
    }),
  };
  return res as unknown as NextApiResponse & { _status: number; _body: any };
}

const validSuccessBody = () => ({
  slug: SLUG,
  sha: SHA,
  appBlockId: APB,
  imageRef: `ghcr.io/civitai/app-block-${SLUG}:${SHA}`,
  status: 'Succeeded',
});

async function invoke(req: NextApiRequest, res: NextApiResponse) {
  const handler = (await import('~/pages/api/internal/blocks/build-callback')).default;
  await handler(req, res);
}

describe('build-callback handler — flag gate + replay guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.enabled = true;
    mockRedis.incrByValue = 1;
    mockTriggerApply.mockResolvedValue({ name: 'apply-job-1' });
  });

  it('503s when the appBlocks flag is off — apply path never runs (kill switch)', async () => {
    mockFlag.enabled = false;
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    expect(res._status).toBe(503);
    expect(mockTriggerApply).not.toHaveBeenCalled();
  });

  it('401s on a bad signature before checking the flag', async () => {
    const req = {
      method: 'POST',
      headers: { 'x-appblocks-signature': 'sha256=deadbeef' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(validSuccessBody()));
      },
    } as unknown as NextApiRequest;
    const res = makeRes();
    await invoke(req, res);
    expect(res._status).toBe(401);
    expect(mockTriggerApply).not.toHaveBeenCalled();
  });

  it('triggers the apply exactly once on the first success callback', async () => {
    mockRedis.incrByValue = 1; // first time
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ ok: true, applied: true });
    expect(mockTriggerApply).toHaveBeenCalledTimes(1);
    expect(mockTriggerApply).toHaveBeenCalledWith(
      expect.objectContaining({ slug: SLUG, sha: SHA, appBlockId: APB })
    );
  });

  it('short-circuits a replayed success callback without re-triggering apply', async () => {
    mockRedis.incrByValue = 2; // duplicate within the dedup window
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ applied: false, reason: 'duplicate callback (replay-guarded)' });
    expect(mockTriggerApply).not.toHaveBeenCalled();
  });

  it('does not consume the replay slot for a build-failure callback (no apply path)', async () => {
    const res = makeRes();
    await invoke(signedReq({ ...validSuccessBody(), status: 'Failed' }), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ applied: false });
    expect(mockTriggerApply).not.toHaveBeenCalled();
  });
});
