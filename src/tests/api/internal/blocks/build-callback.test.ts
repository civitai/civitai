import { createHmac } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// withAxiom is a passthrough in tests.
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));

// The handler module imports ~/server/db/client (Prisma init at module load).
// The pure helper tests don't touch the db; the handler-level tests below need
// dbWrite.appBlock.update, so give it a mockable surface.
const mockUpdate = vi.hoisted(() => vi.fn());
vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: { appBlock: { update: mockUpdate } },
}));
// callbackPendingRedisKey is a pure key builder used by consumePendingRun; the
// real module pulls in env at import, so stub it with a deterministic key shape.
const mockTriggerApply = vi.hoisted(() => vi.fn());
const mockWaitForApplyJob = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerApply: mockTriggerApply,
  waitForApplyJob: mockWaitForApplyJob,
  callbackPendingRedisKey: (slug: string, sha: string, appBlockId: string) =>
    `system:blocks:callback:pending:${slug}:${sha}:${appBlockId}`,
}));

const mockSetCommitStatus = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  setCommitStatus: mockSetCommitStatus,
}));

// Mockable sysRedis.getDel so the consume-once cross-check can be exercised.
const mockGetDel = vi.hoisted(() => vi.fn());
vi.mock('~/server/redis/client', () => ({
  sysRedis: { getDel: mockGetDel },
  REDIS_SYS_KEYS: { BLOCKS: { CALLBACK_PENDING: 'system:blocks:callback:pending' } },
}));

// Mutable env mock so each test can set / clear
// BLOCK_BUILD_CALLBACK_SECRET[_NEXT] to exercise the dual-acceptance rotation
// window (F6). Overrides the global ~/env/server mock in src/__tests__/setup.ts
// for this file. vi.hoisted so the object exists before the hoisted vi.mock
// factory runs.
const mockEnv = vi.hoisted(() => ({} as Record<string, string | undefined>));
vi.mock('~/env/server', () => ({ env: mockEnv }));

import handler, {
  checkCallbackTimestamp,
  consumePendingRun,
  expectedImageRef,
  verifySignature,
} from '~/pages/api/internal/blocks/build-callback';

/**
 * L-CALLBACK coverage. The build-callback handler accepts an `imageRef` from
 * the Tekton pipeline. The pipeline always pushes the immutable
 * `ghcr.io/civitai/app-block-<slug>:<sha>`. The handler must bind the
 * accepted ref to ITS OWN slug + sha — a bare `app-block-` prefix check would
 * let a signature-valid callback for slug A carry `app-block-<B>:<sha>` and
 * deploy B's image onto A's row/Deployment, and would accept a mutable
 * `:latest` tag.
 */
describe('build-callback imageRef binding', () => {
  const SHA = 'a'.repeat(40);

  it('accepts exactly the canonical (slug, sha) image', () => {
    const slug = 'generate-from-model';
    const ref = expectedImageRef(slug, SHA);
    expect(ref).toBe(`ghcr.io/civitai/app-block-${slug}:${SHA}`);
    expect(ref === expectedImageRef(slug, SHA)).toBe(true);
  });

  it('rejects another slug under the same prefix', () => {
    const ours = expectedImageRef('slug-a', SHA);
    const theirs = `ghcr.io/civitai/app-block-slug-b:${SHA}`;
    expect(ours === theirs).toBe(false);
    // the handler compares body.imageRef !== expectedImageRef(body.slug, body.sha)
    expect(theirs === expectedImageRef('slug-a', SHA)).toBe(false);
  });

  it('rejects a mutable :latest tag for our own slug', () => {
    const slug = 'slug-a';
    const latest = `ghcr.io/civitai/app-block-${slug}:latest`;
    expect(latest === expectedImageRef(slug, SHA)).toBe(false);
  });

  it('rejects a different sha for our own slug', () => {
    const slug = 'slug-a';
    const otherSha = 'b'.repeat(40);
    expect(expectedImageRef(slug, otherSha) === expectedImageRef(slug, SHA)).toBe(false);
  });

  it('rejects a prefix-matching but unrelated repo', () => {
    const slug = 'slug-a';
    const sneaky = `ghcr.io/civitai/app-block-${slug}-evil:${SHA}`;
    expect(sneaky === expectedImageRef(slug, SHA)).toBe(false);
  });
});

/**
 * F6 — dual-secret HMAC rotation window. verifySignature must accept a
 * signature computed under the CURRENT secret OR the optional *_NEXT secret, so
 * BLOCK_BUILD_CALLBACK_SECRET can be rotated without dropping in-flight build
 * callbacks. With _NEXT unset the behavior is unchanged (single-secret,
 * fail-closed).
 */
describe('build-callback verifySignature dual-secret window (F6)', () => {
  const body = Buffer.from(JSON.stringify({ slug: 'slug-a', status: 'Succeeded' }));
  const sign = (secret: string, raw = body) =>
    createHmac('sha256', secret).update(raw).digest('hex');

  beforeEach(() => {
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET = undefined;
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET_NEXT = undefined;
  });
  afterEach(() => {
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET = undefined;
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET_NEXT = undefined;
  });

  it('accepts a signature valid under the current secret', () => {
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET = 'current-secret';
    expect(verifySignature(body, sign('current-secret'))).toBe(true);
  });

  it('accepts a signature valid under the NEXT secret (new signer) during rotation', () => {
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET = 'old-secret';
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET_NEXT = 'new-secret';
    expect(verifySignature(body, sign('new-secret'))).toBe(true);
    // Old secret still accepted (in-flight callbacks from the old signer).
    expect(verifySignature(body, sign('old-secret'))).toBe(true);
  });

  it('tolerates a sha256= prefix', () => {
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET = 'old-secret';
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET_NEXT = 'new-secret';
    expect(verifySignature(body, `sha256=${sign('new-secret')}`)).toBe(true);
  });

  it('rejects a NEXT-signed signature when NEXT is unset (unchanged single-secret behavior)', () => {
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET = 'current-secret';
    expect(verifySignature(body, sign('some-future-secret'))).toBe(false);
  });

  it('still rejects a garbage signature with both secrets set', () => {
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET = 'old-secret';
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET_NEXT = 'new-secret';
    expect(verifySignature(body, 'deadbeef')).toBe(false);
    expect(verifySignature(body, '')).toBe(false);
    expect(verifySignature(body, undefined)).toBe(false);
    expect(verifySignature(body, sign('wrong-secret'))).toBe(false);
  });

  it('fails closed when no secret is configured (no current, no NEXT)', () => {
    expect(verifySignature(body, sign('anything'))).toBe(false);
  });
});

/**
 * F5 — replay tolerance on the signed `ts`. The datapacket-talos callback-task
 * signer stamps an integer unix-second `ts` INTO the HMAC-signed body. A replay
 * carries its original stale `ts` and must be rejected; an absent `ts` must be
 * allowed (rollout tolerance — enforce-if-present).
 */
describe('build-callback checkCallbackTimestamp (F5 ts tolerance)', () => {
  const NOW = 1_700_000_000; // fixed reference second

  it('accepts a fresh ts within the ±300s window', () => {
    expect(checkCallbackTimestamp(NOW, NOW).ok).toBe(true);
    expect(checkCallbackTimestamp(NOW - 299, NOW).ok).toBe(true);
    expect(checkCallbackTimestamp(NOW + 299, NOW).ok).toBe(true);
  });

  it('rejects a stale ts (replayed callback) beyond the window', () => {
    const r = checkCallbackTimestamp(NOW - 3600, NOW);
    expect(r.ok).toBe(false);
    const rFuture = checkCallbackTimestamp(NOW + 3600, NOW);
    expect(rFuture.ok).toBe(false);
  });

  it('rejects exactly at the boundary + 1 second', () => {
    expect(checkCallbackTimestamp(NOW - 301, NOW).ok).toBe(false);
    expect(checkCallbackTimestamp(NOW + 301, NOW).ok).toBe(false);
  });

  it('ALLOWS an absent ts (rollout tolerance — signer adds it in its own PR)', () => {
    expect(checkCallbackTimestamp(undefined, NOW).ok).toBe(true);
    expect(checkCallbackTimestamp(null, NOW).ok).toBe(true);
  });

  it('rejects a non-finite / non-number ts', () => {
    expect(checkCallbackTimestamp('1700000000', NOW).ok).toBe(false);
    expect(checkCallbackTimestamp(Number.NaN, NOW).ok).toBe(false);
    expect(checkCallbackTimestamp(Infinity, NOW).ok).toBe(false);
  });
});

/**
 * F5 — consume-once pending-run cross-check. triggerBuild records an outstanding
 * (slug, sha, appBlockId); the callback GETDELs it. Present → consumed (genuine
 * run). Missing → replay/out-of-band. Redis error → unavailable (never breaks a
 * legit deploy). The enforce-vs-report-only decision on 'missing' lives in the
 * handler and is gated by BLOCK_CALLBACK_REQUIRE_PENDING_RUN.
 */
describe('build-callback consumePendingRun (F5 cross-check)', () => {
  const SHA = 'a'.repeat(40);
  const APB = 'apb_0123456789ABCDEFGHJKMNPQ';

  beforeEach(() => {
    mockGetDel.mockReset();
  });

  it('consumes a present marker (genuine outstanding run)', async () => {
    mockGetDel.mockResolvedValueOnce('1');
    await expect(consumePendingRun('slug-a', SHA, APB)).resolves.toBe('consumed');
    expect(mockGetDel).toHaveBeenCalledWith(
      `system:blocks:callback:pending:slug-a:${SHA}:${APB}`
    );
  });

  it('reports missing when the marker is absent (replay / out-of-band)', async () => {
    mockGetDel.mockResolvedValueOnce(null);
    await expect(consumePendingRun('slug-a', SHA, APB)).resolves.toBe('missing');
  });

  it('reports unavailable on a Redis error (never break a legit deploy)', async () => {
    mockGetDel.mockRejectedValueOnce(new Error('redis down'));
    await expect(consumePendingRun('slug-a', SHA, APB)).resolves.toBe('unavailable');
  });

  it('is consume-once: a second GETDEL of the same key returns missing', async () => {
    mockGetDel.mockResolvedValueOnce('1').mockResolvedValueOnce(null);
    await expect(consumePendingRun('slug-a', SHA, APB)).resolves.toBe('consumed');
    await expect(consumePendingRun('slug-a', SHA, APB)).resolves.toBe('missing');
  });
});

/**
 * F5-T — HANDLER-LEVEL coverage that the pure-function tests can't reach: the
 * enforce-vs-report-only branch on a MISSING pending-run marker, and the
 * double-callback (consume-once) outcome. These drive the real handler so the
 * 409-under-enforce and the GETDEL-consume path are exercised end to end.
 */
describe('build-callback handler — F5 pending-run enforcement', () => {
  const SECRET = 'callback-secret';
  const SLUG = 'generate-from-model';
  const SHA = 'a'.repeat(40);
  const APB = 'apb_01JABCDEFGHJKMNPQRSTVWXYZ0';
  const PENDING_KEY = `system:blocks:callback:pending:${SLUG}:${SHA}:${APB}`;

  function callbackBody(over: Record<string, unknown> = {}): Buffer {
    return Buffer.from(
      JSON.stringify({
        slug: SLUG,
        sha: SHA,
        appBlockId: APB,
        imageRef: expectedImageRef(SLUG, SHA),
        status: 'Succeeded',
        ...over,
      })
    );
  }

  function makeReq(raw: Buffer): NextApiRequest {
    const stream = Readable.from([raw]) as unknown as NextApiRequest;
    const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
    stream.method = 'POST';
    stream.headers = { 'x-appblocks-signature': sig };
    return stream;
  }

  function makeRes(): NextApiResponse & { _status: number; _body: unknown } {
    const res = {
      _status: 0,
      _body: null as unknown,
      status(this: any, n: number) {
        this._status = n;
        return this;
      },
      json(this: any, b: unknown) {
        this._body = b;
        return this;
      },
      setHeader: vi.fn(),
      end: vi.fn(),
    };
    return res as unknown as NextApiResponse & { _status: number; _body: unknown };
  }

  // In-memory store so GETDEL round-trips (present → consumed → missing).
  let store: Set<string>;

  beforeEach(() => {
    store = new Set<string>();
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET = SECRET;
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET_NEXT = undefined;
    mockEnv.BLOCK_CALLBACK_REQUIRE_PENDING_RUN = undefined;

    mockGetDel.mockReset();
    mockGetDel.mockImplementation(async (key: string) => {
      if (store.has(key)) {
        store.delete(key);
        return '1';
      }
      return null;
    });

    mockTriggerApply.mockReset();
    mockTriggerApply.mockResolvedValue({ name: 'apply-job-1' });
    mockWaitForApplyJob.mockReset();
    // Background watcher: resolve fast so no unhandled rejection escapes.
    mockWaitForApplyJob.mockResolvedValue('succeeded');
    mockUpdate.mockReset();
    mockUpdate.mockResolvedValue({});
    mockSetCommitStatus.mockReset();
    mockSetCommitStatus.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET = undefined;
    mockEnv.BLOCK_BUILD_CALLBACK_SECRET_NEXT = undefined;
    mockEnv.BLOCK_CALLBACK_REQUIRE_PENDING_RUN = undefined;
  });

  it('REJECTS a missing-marker callback with 409 when enforce is on', async () => {
    mockEnv.BLOCK_CALLBACK_REQUIRE_PENDING_RUN = 'true';
    // store is empty → marker missing.
    const res = makeRes();
    await handler(makeReq(callbackBody()), res);
    expect(res._status).toBe(409);
    expect(mockTriggerApply).not.toHaveBeenCalled();
  });

  it('CONTINUES (report-only) on a missing marker when enforce is unset', async () => {
    // store empty → missing, but enforce flag unset → proceed to apply.
    const res = makeRes();
    await handler(makeReq(callbackBody()), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ ok: true, applied: true });
    expect(mockTriggerApply).toHaveBeenCalledTimes(1);
  });

  it('double-callback: first consumes the marker + applies; second is missing → 409 under enforce', async () => {
    mockEnv.BLOCK_CALLBACK_REQUIRE_PENDING_RUN = 'true';
    store.add(PENDING_KEY); // genuine outstanding run from triggerBuild.

    // First callback: marker present → consumed → applies.
    const res1 = makeRes();
    await handler(makeReq(callbackBody()), res1);
    expect(res1._status).toBe(200);
    expect(res1._body).toMatchObject({ ok: true, applied: true });
    expect(store.has(PENDING_KEY)).toBe(false); // consume-once.
    expect(mockTriggerApply).toHaveBeenCalledTimes(1);

    // Second callback for the same (slug,sha,appBlockId): marker gone → 409.
    const res2 = makeRes();
    await handler(makeReq(callbackBody()), res2);
    expect(res2._status).toBe(409);
    expect(mockTriggerApply).toHaveBeenCalledTimes(1); // no second apply.
  });
});
