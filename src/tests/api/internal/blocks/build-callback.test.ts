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
  mockMarkDeploy,
  attempts,
} = vi.hoisted(() => {
  /**
   * An in-memory `app_block_build_attempts`: rows, its partial unique index on
   * (mode, run_id, status) honoured by `skipDuplicates`, and newest-first `findFirst`.
   * `missing` makes every call throw the way Prisma does before the migration is applied.
   */
  const attempts = {
    rows: [] as Array<Record<string, unknown> & { id: number }>,
    missing: false,
    reset() {
      attempts.rows = [];
      attempts.missing = false;
    },
    fail() {
      throw Object.assign(
        new Error(
          'The table `public.app_block_build_attempts` does not exist in the current database.'
        ),
        { code: 'P2021' }
      );
    },
    createMany: vi.fn(
      async ({
        data,
        skipDuplicates,
      }: {
        data: Record<string, unknown>[];
        skipDuplicates?: boolean;
      }) => {
        if (attempts.missing) attempts.fail();
        let count = 0;
        for (const d of data) {
          const dup =
            d.runId != null &&
            attempts.rows.some(
              (r) => r.mode === d.mode && r.runId === d.runId && r.status === d.status
            );
          if (dup) {
            if (skipDuplicates) continue;
            throw new Error('unique violation');
          }
          attempts.rows.push({ ...d, id: attempts.rows.length + 1 });
          count++;
        }
        return { count };
      }
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (attempts.missing) attempts.fail();
      const hits = attempts.rows
        .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
        .sort((a, b) => b.id - a.id);
      return hits[0] ?? null;
    }),
  };
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
    mockTriggerApply: vi.fn<(...a: any[]) => Promise<{ name: string }>>(async () => ({
      name: 'apply-job-1',
    })),
    mockWaitApply: vi.fn<(...a: any[]) => Promise<string>>(async () => 'succeeded'),
    mockSetCommitStatus: vi.fn(async () => undefined),
    mockAppBlockUpdate: vi.fn(async () => undefined),
    mockMarkDeploy: vi.fn<(...a: any[]) => Promise<void>>(async () => undefined),
    attempts,
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
  dbWrite: {
    appBlock: { update: mockAppBlockUpdate },
    appBlockBuildAttempt: { createMany: attempts.createMany, findFirst: attempts.findFirst },
    // Resolves the build attempt's publish_request_id from (slug, sha).
    appBlockPublishRequest: { findFirst: vi.fn(async () => ({ id: 'pubreq_RESOLVED' })) },
  },
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
// Include listRepoTreeAtRef + getBlobContent: build-callback itself only needs setCommitStatus, but a
// saturated worker pool let this partial factory leak into a co-resident file (push-diff-enrichment)
// whose REAL publish-request.service reaches them via reconstructBundleFromForgejo → surfacing as
// "No 'listRepoTreeAtRef' export is defined on the mock". Completing the surface removes that leak.
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  setCommitStatus: mockSetCommitStatus,
  listRepoTreeAtRef: vi.fn(),
  getBlobContent: vi.fn(),
}));
// Phase 2: build-callback marks the per-request deploy lifecycle. Mock the
// helper so we can assert the transitions (the real one writes to the DB).
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  markRequestDeployState: mockMarkDeploy,
}));

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
    expect(`ghcr.io/civitai/app-block-slug-b:${SHA}` === expectedImageRef('slug-a', SHA)).toBe(
      false
    );
  });
  it('rejects a mutable :latest tag for our own slug', () => {
    expect(`ghcr.io/civitai/app-block-slug-a:latest` === expectedImageRef('slug-a', SHA)).toBe(
      false
    );
  });
  it('rejects a different sha for our own slug', () => {
    expect(expectedImageRef('slug-a', 'b'.repeat(40)) === expectedImageRef('slug-a', SHA)).toBe(
      false
    );
  });
  it('rejects a prefix-matching but unrelated repo', () => {
    expect(`ghcr.io/civitai/app-block-slug-a-evil:${SHA}` === expectedImageRef('slug-a', SHA)).toBe(
      false
    );
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
    expect(mockSetNx).toHaveBeenCalledWith(
      expect.stringContaining(`apply:${APB}:${SHA}`),
      '1',
      600
    );
  });

  it('short-circuits a replayed success callback without re-triggering apply', async () => {
    mockRedis.nxResult = false; // setNxKeepTtlWithEx → false (key present) → replay within the window
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({
      applied: false,
      reason: 'duplicate callback (replay-guarded)',
    });
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
    // Phase 2: a build failure marks the request 'failed' so the dev sees it.
    expect(mockMarkDeploy).toHaveBeenCalledWith(
      SLUG,
      SHA,
      'failed',
      expect.stringMatching(/Build/)
    );
  });

  it('clears the replay slot on a DEFINITIVE apply failure so a same-sha retry is not blocked', async () => {
    mockWaitApply.mockResolvedValue('failed');
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    await flush(); // let the fire-and-forget watcher run
    expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining(`apply:${APB}:${SHA}`));
    // Phase 2: 'deploying' on apply trigger, then 'failed' from the watcher.
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'deploying');
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'failed', 'Deploy failed');
  });

  it('does NOT clear the slot on apply timeout (the Job may still be running)', async () => {
    mockWaitApply.mockResolvedValue('timeout');
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    await flush();
    expect(mockRedisDel).not.toHaveBeenCalled();
    // Phase 2: a timeout is surfaced as 'failed' with the timeout detail.
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'failed', 'Deploy timed out');
  });

  it('records the deploy and keeps the slot on apply success', async () => {
    mockWaitApply.mockResolvedValue('succeeded');
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    await flush();
    expect(mockAppBlockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: APB } })
    );
    expect(mockRedisDel).not.toHaveBeenCalled();
    // Phase 2: the request transitions 'deploying' (apply trigger) → 'live' (watcher).
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'deploying');
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'live');
  });

  it('clears the replay slot when triggerApply itself throws — no watcher runs, so the catch must free it', async () => {
    mockTriggerApply.mockRejectedValue(new Error('k8s API down'));
    const res = makeRes();
    await invoke(signedReq(validSuccessBody()), res);
    expect(res._status).toBe(500);
    // mark was set (SET NX) then freed in the catch so a same-sha retry isn't wedged
    expect(mockSetNx).toHaveBeenCalledTimes(1);
    expect(mockRedisDel).toHaveBeenCalledWith(expect.stringContaining(`apply:${APB}:${SHA}`));
    // Phase 2: 'deploying' is written before triggerApply, then 'failed' when it throws.
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'deploying');
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'failed', 'Deploy could not start');
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

// ---- OPTIONAL `failureReason` excerpt ---------------------------------------
//
// The pipeline may append ONE optional trailing string field, `failureReason`, to
// a NON-SUCCESS callback. These tests pin BOTH deploy orderings of that
// independently-shipped contract:
//
//   new pipeline + OLD web  — the field is unknown; the handler has no strict
//     schema (it JSON.parses and validates named fields only) and the HMAC is
//     computed over the RAW BYTES before parsing, so an added field can neither
//     break the signature nor the parse. Proven by the "old-web" simulation below,
//     which verifies a body CONTAINING failureReason against `verifySignature`.
//
//   OLD pipeline + new web  — the field is absent; `deploy_detail` must be
//     BYTE-IDENTICAL to what shipped before. Pinned as an exact-string assertion.

describe('build-callback handler — failureReason excerpt (A1/A2)', () => {
  const failBody = (over: Record<string, unknown> = {}) => ({
    ...validSuccessBody(),
    status: 'Failed',
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.enabled = true;
    mockRedis.nxResult = true;
    mockRedis.nxThrows = false;
  });
  afterEach(async () => {
    await flush();
  });

  it('ABSENT failureReason → the EXACT pre-feature deploy_detail (dark-safe)', async () => {
    const res = makeRes();
    await invoke(signedReq(failBody()), res);
    expect(res._status).toBe(200);
    // Byte-identical to the previous `Build ${status.slice(0,60)}` expression.
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'failed', 'Build Failed');
  });

  it('PRESENT failureReason → the Build prefix, a blank line, then the excerpt', async () => {
    const res = makeRes();
    await invoke(
      signedReq(failBody({ failureReason: 'ERROR: no package-lock.json is committed' })),
      res
    );
    expect(res._status).toBe(200);
    expect(mockMarkDeploy).toHaveBeenCalledWith(
      SLUG,
      SHA,
      'failed',
      'Build Failed\n\nERROR: no package-lock.json is committed'
    );
  });

  it('NON-STRING failureReason is ignored (same detail as absent)', async () => {
    for (const bogus of [42, true, { message: 'x' }, ['x'], null]) {
      vi.clearAllMocks();
      const res = makeRes();
      await invoke(signedReq(failBody({ failureReason: bogus })), res);
      expect(res._status).toBe(200);
      expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'failed', 'Build Failed');
    }
  });

  it('re-sanitizes server-side — escapes/control chars never reach the DB', async () => {
    const ESC = String.fromCharCode(0x1b);
    const NUL = String.fromCharCode(0x00);
    const res = makeRes();
    await invoke(
      signedReq(
        failBody({ failureReason: `${ESC}[1;31mERROR${ESC}[0m${NUL}: bad lockfile\r\nline2` })
      ),
      res
    );
    const detail = mockMarkDeploy.mock.calls.at(-1)?.[3] as string;
    expect(detail).toBe('Build Failed\n\nERROR: bad lockfile\nline2');
    expect(detail).not.toContain(ESC);
    expect(detail).not.toContain(NUL);
    expect(detail).not.toContain('\r');
  });

  it('OVERSIZED failureReason is truncated with an explicit marker', async () => {
    const res = makeRes();
    await invoke(signedReq(failBody({ failureReason: 'z'.repeat(7000) })), res);
    const detail = mockMarkDeploy.mock.calls.at(-1)?.[3] as string;
    expect(detail.length).toBeLessThan(4000);
    expect(detail.endsWith('... [truncated]')).toBe(true);
  });

  it('a SUCCESS callback ignores failureReason entirely (apply path unchanged)', async () => {
    const res = makeRes();
    await invoke(signedReq({ ...validSuccessBody(), failureReason: 'should be ignored' }), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ ok: true, applied: true });
    expect(mockTriggerApply).toHaveBeenCalledTimes(1);
    // No 'failed' transition, and no excerpt anywhere in the states written.
    for (const call of mockMarkDeploy.mock.calls) expect(call[2]).not.toBe('failed');
  });

  it('the RESPONSE body is unchanged by the new field (Tekton contract intact)', async () => {
    const res = makeRes();
    await invoke(signedReq(failBody({ failureReason: 'boom' })), res);
    expect(res._body).toEqual({ ok: true, applied: false, reason: 'build failed' });
  });

  // ---- HMAC is unaffected by the added field --------------------------------

  it('a body CONTAINING failureReason verifies — the signature is over raw bytes', () => {
    const raw = Buffer.from(JSON.stringify(failBody({ failureReason: 'why it broke' })), 'utf8');
    const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
    expect(verifySignature(raw, sig)).toBe(true);
    expect(verifySignature(raw, `sha256=${sig}`)).toBe(true);
  });

  it('flipping ONE byte of a failureReason body breaks the signature', () => {
    const raw = Buffer.from(JSON.stringify(failBody({ failureReason: 'why it broke' })), 'utf8');
    const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
    const tampered = Buffer.from(raw);
    tampered[tampered.length - 5] ^= 0x01;
    expect(verifySignature(tampered, sig)).toBe(false);
  });

  it('OLD-WEB SIMULATION: an old handler ignores the unknown field and still verifies', () => {
    // The pre-feature handler had NO `failureReason` in its CallbackBody type and no
    // strict schema — it JSON.parsed and read named fields only. Reproduce that:
    // signature over the raw bytes passes, and the parsed object still exposes every
    // field the old handler cared about, so `new pipeline + old web` is a no-op.
    const body = failBody({ failureReason: 'unknown to the old handler' });
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    expect(verifySignature(raw, createHmac('sha256', SECRET).update(raw).digest('hex'))).toBe(true);
    const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    expect(parsed.slug).toBe(SLUG);
    expect(parsed.sha).toBe(SHA);
    expect(parsed.appBlockId).toBe(APB);
    expect(parsed.status).toBe('Failed');
  });

  it('a REALISTIC 2000-char excerpt stays well inside MAX_BODY_BYTES', () => {
    // Contract: excerpt <= 2000 chars; base body ~250 B; MAX_BODY_BYTES = 8 KiB.
    // A real build-log excerpt is printable text plus newlines/quotes, each of
    // which costs 1-2 bytes once JSON-escaped.
    const printable = ('ERROR: cannot find module "foo"\n' as string).repeat(65).slice(0, 2000);
    const body = JSON.stringify(failBody({ failureReason: printable }));
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(8 * 1024);
  });

  it('DOCUMENTED CEILING: an all-control-character excerpt WOULD exceed 8 KiB', () => {
    //  JSON-escapes to six bytes, so a pathological 2000-char excerpt of
    // pure control characters serializes to ~12 KB and `readRawBody` would 413 it
    // BEFORE the handler ever parses.
    //
    // Not a security issue and not a regression — the pre-existing 8 KiB ceiling
    // still holds and rejects it. The consequence is a DEGRADATION: that callback
    // is dropped, so the request keeps its previous state (it looks stalled)
    // instead of flipping to 'failed'. The emitting pipeline is contractually
    // required to send a SANITIZED excerpt, which by construction contains no
    // control characters, so this is unreachable in practice. Pinned so the
    // arithmetic is on the record rather than assumed.
    const pathological = JSON.stringify(
      failBody({ failureReason: String.fromCharCode(0x01).repeat(2000) })
    );
    expect(Buffer.byteLength(pathological, 'utf8')).toBeGreaterThan(8 * 1024);
    // The safe budget for a control-character-free excerpt: even fully quote/
    // newline-escaped at 2 bytes each, 2000 chars fits.
    const escapeHeavy = JSON.stringify(failBody({ failureReason: '"\n'.repeat(1000) }));
    expect(Buffer.byteLength(escapeHeavy, 'utf8')).toBeLessThan(8 * 1024);
  });
});

// ---- OPTIONAL structured signals + build attempts + stale-run guard -----------
//
// `failedStep` / `pipelineStatus` / `failedReason` / `runId` are optional and additive.
// Absent → the callback behaves exactly as before. Present and valid → stored on the
// attempt row. Present and invalid → that field is dropped and the callback proceeds.
// The attempts table may not exist yet (its migration is applied by hand), and the
// deploy_state write must not depend on it.

describe('build-callback handler — structured signals and build attempts', () => {
  const RUN_OLD = 'app-blocks-generate-from-model-aaaaaaaa-111111';
  const RUN_NEW = 'app-blocks-generate-from-model-aaaaaaaa-222222';
  const failBody = (over: Record<string, unknown> = {}) => ({
    ...validSuccessBody(),
    status: 'None',
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    attempts.reset();
    mockFlag.enabled = true;
    mockRedis.nxResult = true;
    mockRedis.nxThrows = false;
    mockTriggerApply.mockResolvedValue({ name: 'apply-job-1' });
    mockWaitApply.mockResolvedValue('succeeded');
  });
  afterEach(async () => {
    await flush();
  });

  /** Record a trigger the way approve / retrigger do, through the real service. */
  async function triggered(runName: string) {
    const { recordBuildTriggered } = await import(
      '~/server/services/blocks/build-attempts.service'
    );
    expect(
      await recordBuildTriggered({
        mode: 'build',
        publishRequestId: 'pubreq_RESOLVED',
        slug: SLUG,
        sha: SHA,
        runName,
      })
    ).toBe(true);
  }

  const callbackRows = () => attempts.rows.filter((r) => r.status !== 'triggered');

  it('ABSENT signals: deploy_state, commit status and response exactly as before; the row carries nulls', async () => {
    const res = makeRes();
    await invoke(signedReq(failBody()), res);
    expect(res._body).toEqual({ ok: true, applied: false, reason: 'build failed' });
    expect(mockMarkDeploy).toHaveBeenCalledTimes(1);
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'failed', 'Build None');
    expect(mockSetCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failure', description: 'Build None' })
    );
    expect(callbackRows()).toEqual([
      {
        id: 1,
        publishRequestId: 'pubreq_RESOLVED',
        slug: SLUG,
        sha: SHA,
        runId: null,
        mode: 'build',
        status: 'failed',
        failedStep: null,
        failedReason: null,
        // No step reported → no class stored, so the UI keeps its text fallback.
        failureClass: null,
        pipelineStatus: null,
        createdAt: expect.any(Date),
      },
    ]);
  });

  it('VALID signals round-trip onto the attempt row with the derived class', async () => {
    const res = makeRes();
    await invoke(
      signedReq(
        failBody({
          failedStep: 'build',
          failedReason: 'TaskRunTimeout',
          pipelineStatus: 'Failed',
          runId: RUN_OLD,
        })
      ),
      res
    );
    expect(res._status).toBe(200);
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'failed', 'Build None');
    expect(callbackRows()).toEqual([
      expect.objectContaining({
        runId: RUN_OLD,
        status: 'failed',
        failedStep: 'build',
        failedReason: 'TaskRunTimeout',
        failureClass: 'transient',
        pipelineStatus: 'Failed',
      }),
    ]);
  });

  it('a SUCCESS records a succeeded attempt with its run id and still applies', async () => {
    const res = makeRes();
    await invoke(
      signedReq({
        ...validSuccessBody(),
        failedStep: 'none',
        pipelineStatus: 'Succeeded',
        runId: RUN_OLD,
      }),
      res
    );
    expect(res._body).toMatchObject({ ok: true, applied: true });
    expect(callbackRows()).toEqual([
      expect.objectContaining({
        runId: RUN_OLD,
        status: 'succeeded',
        failedStep: 'none',
        failureClass: null,
        pipelineStatus: 'Succeeded',
      }),
    ]);
  });

  it('an INVALID field is dropped and logged; the callback and the valid fields go through', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = makeRes();
    await invoke(
      signedReq(failBody({ failedStep: 'scan', failedReason: 'Not A Reason!', runId: RUN_OLD })),
      res
    );
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, applied: false, reason: 'build failed' });
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'failed', 'Build None');
    expect(callbackRows()).toEqual([
      expect.objectContaining({
        failedStep: 'scan',
        failedReason: null,
        runId: RUN_OLD,
        failureClass: 'unknown',
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped invalid optional field(s) failedReason')
    );
    warn.mockRestore();
  });

  it('TABLE MISSING: the attempt write and the stale check both fail, deploy_state is still written', async () => {
    attempts.missing = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = makeRes();
    await invoke(signedReq(failBody({ failedStep: 'scan', runId: RUN_OLD })), res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, applied: false, reason: 'build failed' });
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'failed', 'Build None');
    // Both table calls were attempted and threw — this is the path under test, not a no-op.
    expect(attempts.findFirst).toHaveBeenCalled();
    expect(attempts.createMany).toHaveBeenCalled();
    expect(attempts.rows).toEqual([]);
    warn.mockRestore();
  });

  it('TABLE MISSING on a success: the apply still runs', async () => {
    attempts.missing = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = makeRes();
    await invoke(signedReq({ ...validSuccessBody(), runId: RUN_OLD }), res);
    expect(res._body).toMatchObject({ ok: true, applied: true });
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'deploying');
    expect(attempts.createMany).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('RUN-ID GUARD: a late failure from a SUPERSEDED run leaves the newer run’s state alone', async () => {
    await triggered(RUN_OLD);
    await triggered(RUN_NEW); // a moderator retrigger
    const res = makeRes();
    await invoke(signedReq(failBody({ failedStep: 'scan', runId: RUN_OLD })), res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, applied: false, reason: 'superseded run' });
    expect(mockMarkDeploy).not.toHaveBeenCalled();
    expect(mockSetCommitStatus).not.toHaveBeenCalled();
    // History still records what the old run reported — as `superseded`, which the
    // latest-outcome read never returns, so it cannot relabel the newer run's result.
    expect(callbackRows()).toEqual([
      expect.objectContaining({ runId: RUN_OLD, status: 'superseded', failedStep: 'scan' }),
    ]);
  });

  it('RUN-ID GUARD: the CURRENT run’s failure is applied', async () => {
    await triggered(RUN_OLD);
    await triggered(RUN_NEW);
    const res = makeRes();
    await invoke(signedReq(failBody({ failedStep: 'scan', runId: RUN_NEW })), res);
    expect(res._body).toEqual({ ok: true, applied: false, reason: 'build failed' });
    expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'failed', 'Build None');
  });

  it('RUN-ID GUARD is enforce-if-present: no runId, or a run with no recorded trigger, proceeds', async () => {
    await triggered(RUN_OLD);
    await triggered(RUN_NEW);
    for (const body of [
      failBody({ failedStep: 'scan' }),
      failBody({ runId: 'app-blocks-unrecorded-run-1' }),
    ]) {
      vi.clearAllMocks();
      const res = makeRes();
      await invoke(signedReq(body), res);
      expect(res._body).toEqual({ ok: true, applied: false, reason: 'build failed' });
      expect(mockMarkDeploy).toHaveBeenCalledWith(SLUG, SHA, 'failed', 'Build None');
    }
  });

  it('a repeated delivery of the same failure adds no second row', async () => {
    for (let i = 0; i < 3; i++) {
      await invoke(signedReq(failBody({ failedStep: 'push', runId: RUN_OLD })), makeRes());
    }
    expect(callbackRows()).toHaveLength(1);
    // The dedup is the DB's partial unique index; what the code owns is asking for it.
    for (const [arg] of attempts.createMany.mock.calls) expect(arg.skipDuplicates).toBe(true);
  });

  /** The current value of one series of the build-outcome counter. */
  async function series(labels: string): Promise<number> {
    const client = (await import('prom-client')).default;
    const metric = client.register.getSingleMetric('civitai_app_block_builds_total') as unknown as
      | { get(): Promise<{ values: { value: number; labels: Record<string, string> }[] }> }
      | undefined;
    if (!metric) return 0;
    const { values } = await metric.get();
    const [mode, outcome, step, cls] = labels.split('/');
    return (
      values.find(
        (v) =>
          v.labels.mode === mode &&
          v.labels.outcome === outcome &&
          v.labels.failed_step === step &&
          v.labels.failure_class === cls
      )?.value ?? 0
    );
  }

  it.each([
    ['a reported step', { failedStep: 'scan' }, 'build/failed/scan/unknown'],
    [
      'a build timeout',
      { failedStep: 'build', failedReason: 'TaskRunTimeout' },
      'build/failed/build/transient',
    ],
    ['no step (older pipeline)', {}, 'build/failed/unreported/unknown'],
  ] as const)('counts a failure with %s on its series', async (_n, extra, labels) => {
    const before = await series(labels);
    await invoke(signedReq(failBody(extra)), makeRes());
    expect((await series(labels)) - before).toBe(1);
  });

  it('counts a success, and an apply failure of the built image as platform', async () => {
    mockWaitApply.mockResolvedValue('failed');
    const ok = await series('build/succeeded/none/none');
    const apply = await series('build/failed/apply/platform');
    await invoke(signedReq(validSuccessBody()), makeRes());
    await flush(); // the apply watcher is fire-and-forget
    expect((await series('build/succeeded/none/none')) - ok).toBe(1);
    expect((await series('build/failed/apply/platform')) - apply).toBe(1);
  });

  it('does NOT count a superseded run’s ignored failure', async () => {
    await triggered(RUN_OLD);
    await triggered(RUN_NEW);
    const before = await series('build/failed/scan/unknown');
    await invoke(signedReq(failBody({ failedStep: 'scan', runId: RUN_OLD })), makeRes());
    expect(await series('build/failed/scan/unknown')).toBe(before);
  });
});
