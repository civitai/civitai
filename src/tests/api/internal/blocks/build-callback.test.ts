import { createHmac } from 'crypto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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

const {
  SECRET,
  mockEnvStore,
  mockFlag,
  mockRedis,
  mockSetNx,
  mockRedisDel,
  mockTriggerApply,
  mockWaitApply,
  mockSetCommitStatus,
  mockAppBlockUpdate,
} = vi.hoisted(() => {
  // nxResult: true = newly set (first time), false = key already present (replay).
  const mockRedis = { nxResult: true, nxThrows: false };
  const SECRET = 'test-build-callback-secret';
  return {
    SECRET,
    // Mutable env backing store so dual-secret (F6) tests can set/clear
    // BLOCK_BUILD_CALLBACK_SECRET[_NEXT] per case. Defaults to the single
    // current secret so the existing handler tests are unchanged.
    mockEnvStore: { BLOCK_BUILD_CALLBACK_SECRET: SECRET } as Record<string, unknown>,
    mockFlag: { enabled: true },
    mockRedis,
    // mirrors redis.setNxKeepTtlWithEx(key, value, ttl): Promise<boolean>
    mockSetNx: vi.fn(async () => {
      if (mockRedis.nxThrows) throw new Error('redis down');
      return mockRedis.nxResult;
    }),
    mockRedisDel: vi.fn(async () => 1),
    mockTriggerApply: vi.fn<(...a: any[]) => Promise<{ name: string }>>(async () => ({ name: 'apply-job-1' })),
    mockWaitApply: vi.fn<(...a: any[]) => Promise<string>>(async () => 'succeeded'),
    mockSetCommitStatus: vi.fn(async () => undefined),
    mockAppBlockUpdate: vi.fn(async () => undefined),
  };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/env/server', () => ({
  env: new Proxy(mockEnvStore, {
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
// Per-key Flipt mock: the build-callback gate now reads the dedicated
// `app-blocks-pipeline-enabled` PIPELINE flag (Decision 1), NOT the user-facing
// `app-blocks-enabled`. Only the pipeline key reflects `mockFlag.enabled`; the
// user flag is hard-false so a regression that repoints back to it would 503
// even with the pipeline "on".
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn(async (flag: string) =>
    flag === 'app-blocks-pipeline-enabled' ? mockFlag.enabled : false
  ),
}));
vi.mock('~/server/redis/client', () => ({
  redis: { setNxKeepTtlWithEx: mockSetNx, del: mockRedisDel },
  REDIS_KEYS: { BLOCKS: { TOKEN_RATE_LIMIT: 'blocks:token-rate-limit' } },
}));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerApply: mockTriggerApply,
  waitForApplyJob: mockWaitApply,
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({ setCommitStatus: mockSetCommitStatus }));

import {
  checkCallbackTimestamp,
  expectedImageRef,
  verifySignature,
} from '~/pages/api/internal/blocks/build-callback';
import { isFlipt } from '~/server/flipt/client';

const mockedIsFlipt = vi.mocked(isFlipt);

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

/**
 * F6 — dual-secret HMAC rotation window. verifySignature must accept a
 * signature computed under the CURRENT secret OR the optional *_NEXT secret, so
 * the secret rotates without an outage. With _NEXT unset the behaviour is
 * byte-identical to the prior single-secret implementation (fail-closed when no
 * secret is configured / never an empty-key HMAC).
 */
describe('build-callback verifySignature dual-secret window (F6)', () => {
  const body = Buffer.from('{"slug":"x","status":"Succeeded"}', 'utf8');
  const sign = (secret: string) => createHmac('sha256', secret).update(body).digest('hex');

  beforeEach(() => {
    mockEnvStore.BLOCK_BUILD_CALLBACK_SECRET = undefined;
    mockEnvStore.BLOCK_BUILD_CALLBACK_SECRET_NEXT = undefined;
  });
  afterEach(() => {
    // Restore the default single-secret env for the handler tests below.
    mockEnvStore.BLOCK_BUILD_CALLBACK_SECRET = SECRET;
    mockEnvStore.BLOCK_BUILD_CALLBACK_SECRET_NEXT = undefined;
  });

  it('accepts a signature valid under the current secret', () => {
    mockEnvStore.BLOCK_BUILD_CALLBACK_SECRET = 'current-secret';
    expect(verifySignature(body, sign('current-secret'))).toBe(true);
    expect(verifySignature(body, `sha256=${sign('current-secret')}`)).toBe(true);
  });

  it('accepts BOTH old and NEXT during rotation', () => {
    mockEnvStore.BLOCK_BUILD_CALLBACK_SECRET = 'old-secret';
    mockEnvStore.BLOCK_BUILD_CALLBACK_SECRET_NEXT = 'new-secret';
    expect(verifySignature(body, sign('new-secret'))).toBe(true);
    expect(verifySignature(body, sign('old-secret'))).toBe(true);
  });

  it('rejects a signature under neither secret', () => {
    mockEnvStore.BLOCK_BUILD_CALLBACK_SECRET = 'old-secret';
    mockEnvStore.BLOCK_BUILD_CALLBACK_SECRET_NEXT = 'new-secret';
    expect(verifySignature(body, sign('attacker'))).toBe(false);
  });

  it('NEXT unset → identical single-secret behaviour', () => {
    mockEnvStore.BLOCK_BUILD_CALLBACK_SECRET = 'only';
    expect(verifySignature(body, sign('only'))).toBe(true);
    expect(verifySignature(body, sign('other'))).toBe(false);
  });

  it('fails closed when NO secret is configured (never an empty-key HMAC)', () => {
    expect(verifySignature(body, sign(''))).toBe(false);
    expect(verifySignature(body, sign('anything'))).toBe(false);
  });

  it('ignores an empty-string secret (does not compute an empty-key HMAC)', () => {
    mockEnvStore.BLOCK_BUILD_CALLBACK_SECRET = '';
    mockEnvStore.BLOCK_BUILD_CALLBACK_SECRET_NEXT = 'real-next';
    expect(verifySignature(body, sign(''))).toBe(false);
    expect(verifySignature(body, sign('real-next'))).toBe(true);
  });
});

/**
 * F5 — callback `ts` replay-freshness window (pure helper). The signer stamps an
 * integer unix-epoch-seconds `ts` inside the HMAC-signed body; this check is
 * enforce-if-present (absent → allow for rollout) and rejects a stale/future or
 * non-finite ts. HMAC-bound defence-in-depth on top of the #2510 redis dedup,
 * which fails OPEN and is single-window only.
 */
describe('checkCallbackTimestamp (F5)', () => {
  const NOW = 1_700_000_000; // fixed reference now (unix seconds)

  it('allows an absent ts (enforce-if-present rollout tolerance)', () => {
    expect(checkCallbackTimestamp(undefined, NOW)).toEqual({ ok: true });
    expect(checkCallbackTimestamp(null, NOW)).toEqual({ ok: true });
  });

  it('allows a fresh ts within ±300s', () => {
    expect(checkCallbackTimestamp(NOW, NOW)).toEqual({ ok: true });
    expect(checkCallbackTimestamp(NOW - 299, NOW)).toEqual({ ok: true });
    expect(checkCallbackTimestamp(NOW + 299, NOW)).toEqual({ ok: true });
    expect(checkCallbackTimestamp(NOW - 300, NOW)).toEqual({ ok: true });
  });

  it('rejects a stale ts beyond -300s (the replay case)', () => {
    const r = checkCallbackTimestamp(NOW - 301, NOW);
    expect(r.ok).toBe(false);
  });

  it('rejects a future ts beyond +300s', () => {
    const r = checkCallbackTimestamp(NOW + 301, NOW);
    expect(r.ok).toBe(false);
  });

  it('rejects a present-but-non-finite ts', () => {
    expect(checkCallbackTimestamp('1700000000', NOW).ok).toBe(false);
    expect(checkCallbackTimestamp(NaN, NOW).ok).toBe(false);
    expect(checkCallbackTimestamp(Infinity, NOW).ok).toBe(false);
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

// Drain the fire-and-forget watchApplyJobAndRecord promise so it can't bleed
// into the next test's mock assertions.
const flush = () => new Promise((r) => setTimeout(r, 10));

describe('build-callback handler — flag gate + replay guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.enabled = true;
    mockRedis.nxResult = true; // default: newly set → first time → apply
    mockRedis.nxThrows = false;
    mockTriggerApply.mockResolvedValue({ name: 'apply-job-1' });
    mockWaitApply.mockResolvedValue('succeeded');
  });

  afterEach(async () => {
    await flush();
  });

  it('503s when the appBlocks flag is off — apply path never runs (kill switch)', async () => {
    mockFlag.enabled = false;
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    expect(res._status).toBe(503);
    expect(mockTriggerApply).not.toHaveBeenCalled();
  });

  it('gates on the PIPELINE flag key, not the user-facing flag (Decision 1)', async () => {
    // pipeline flag on → proceeds; assert the gate evaluated the pipeline key
    // and NEVER the user-facing `app-blocks-enabled`.
    mockFlag.enabled = true;
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    expect(mockedIsFlipt).toHaveBeenCalledWith('app-blocks-pipeline-enabled');
    expect(mockedIsFlipt).not.toHaveBeenCalledWith(
      'app-blocks-enabled',
      expect.anything(),
      expect.anything()
    );
    expect(mockedIsFlipt).not.toHaveBeenCalledWith('app-blocks-enabled');
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
    mockRedis.nxResult = true; // newly set → first time
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ ok: true, applied: true });
    expect(mockTriggerApply).toHaveBeenCalledTimes(1);
    expect(mockTriggerApply).toHaveBeenCalledWith(
      expect.objectContaining({ slug: SLUG, sha: SHA, appBlockId: APB })
    );
    // Lock the dedup contract: atomic NX-set on the (appBlockId, sha) key with the TTL.
    expect(mockSetNx).toHaveBeenCalledWith(expect.stringContaining(`apply:${APB}:${SHA}`), '1', 600);
  });

  it('short-circuits a replayed success callback without re-triggering apply', async () => {
    mockRedis.nxResult = false; // setNxKeepTtlWithEx → false (key present) → replay within the window
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ applied: false, reason: 'duplicate callback (replay-guarded)' });
    expect(mockTriggerApply).not.toHaveBeenCalled();
  });

  it('fails OPEN on a Redis error — apply still runs so an outage cannot block a deploy', async () => {
    mockRedis.nxThrows = true;
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ applied: true });
    expect(mockTriggerApply).toHaveBeenCalledTimes(1);
  });

  it('does not consume the replay slot for a build-failure callback (no apply path)', async () => {
    const res = makeRes();
    await invoke(signedReq({ ...validSuccessBody(), status: 'Failed' }), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ applied: false });
    expect(mockTriggerApply).not.toHaveBeenCalled();
    expect(mockSetNx).not.toHaveBeenCalled(); // dedup slot untouched by a failure callback
  });

  it('clears the replay slot on a DEFINITIVE apply failure so a same-sha retry is not blocked', async () => {
    mockWaitApply.mockResolvedValue('failed');
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    await flush(); // let the fire-and-forget watcher run
    expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining(`apply:${APB}:${SHA}`));
  });

  it('does NOT clear the slot on apply timeout (the Job may still be running)', async () => {
    mockWaitApply.mockResolvedValue('timeout');
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    await flush();
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it('records the deploy and keeps the slot on apply success', async () => {
    mockWaitApply.mockResolvedValue('succeeded');
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    await flush();
    expect(mockAppBlockUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: APB } }));
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it('clears the replay slot when triggerApply itself throws — no watcher runs, so the catch must free it', async () => {
    mockTriggerApply.mockRejectedValue(new Error('k8s API down'));
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    expect(res._status).toBe(500);
    // mark was set (SET NX) then freed in the catch so a same-sha retry isn't wedged
    expect(mockSetNx).toHaveBeenCalledTimes(1);
    expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining(`apply:${APB}:${SHA}`));
  });

  // ---- F5: callback `ts` replay-freshness through the handler ----------------

  it('applies on a fresh ts (present + within skew)', async () => {
    const fresh = Math.floor(Date.now() / 1000);
    const res = makeRes();
    await invoke(signedReq({ ...validSuccessBody(), ts: fresh }), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ ok: true, applied: true });
    expect(mockTriggerApply).toHaveBeenCalledTimes(1);
  });

  it('401s a stale (replayed) ts and never reaches the apply path', async () => {
    const stale = Math.floor(Date.now() / 1000) - 3600; // 1h old → way outside 300s
    const res = makeRes();
    await invoke(signedReq({ ...validSuccessBody(), ts: stale }), res);
    expect(res._status).toBe(401);
    expect(mockTriggerApply).not.toHaveBeenCalled();
    // dedup slot untouched — the ts gate is upstream of the redis mark.
    expect(mockSetNx).not.toHaveBeenCalled();
  });

  it('applies when ts is absent (enforce-if-present rollout tolerance)', async () => {
    const res = makeRes();
    // validSuccessBody() carries no ts at all.
    await invoke(signedReq(validSuccessBody()), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ applied: true });
    expect(mockTriggerApply).toHaveBeenCalledTimes(1);
  });

  it('401s a present-but-non-finite ts', async () => {
    const res = makeRes();
    await invoke(signedReq({ ...validSuccessBody(), ts: 'not-a-number' }), res);
    expect(res._status).toBe(401);
    expect(mockTriggerApply).not.toHaveBeenCalled();
  });
});
