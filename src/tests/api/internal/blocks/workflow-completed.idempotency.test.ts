import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Idempotency + JOB_TOKEN auth + install-validation contract for
 * POST /api/internal/blocks/workflow-completed.
 *
 * The sibling workflow-completed.gate.test.ts pins ONLY the Flipt pipeline-flag
 * kill switch + a single unauth 401. This file covers the rest of the handler's
 * stable contract (Critical path 8 — idempotency dedup, plus the JOB_TOKEN auth
 * surface and the install pre-validation that gates the dedup write):
 *
 *   - JOB_TOKEN auth: missing-env-secret → 401; wrong header → 401; correct
 *     header → proceeds (the timing-safe `safeEqualHeader` path);
 *   - method != POST → 405;
 *   - install validation runs BEFORE the 7-day dedup marker is written
 *     (audit-9 #6): not-found / empty targetModelIds → 404 and NO incrBy;
 *   - idempotency (M-6): the FIRST delivery proceeds (incrBy → 1, sets the TTL,
 *     returns {ok:true}); a RETRY short-circuits with {ok:true, idempotent:true}
 *     and does NOT re-run the (eventual) billing path;
 *   - Redis fail-closed: an incrBy throw makes the handler treat the delivery
 *     as already-processed (idempotent short-circuit) so a retry can never
 *     double-bill while Redis is down;
 *   - zod body validation: bad blockInstanceId / negative buzzSpent / missing
 *     required fields → 400 (and dedup never runs).
 *
 * Mocking mirrors workflow-completed.gate.test.ts exactly so the two files share
 * the same boundary assumptions.
 */

const JOB_TOKEN = 'test-job-token';
const BLOCK_INSTANCE_ID = 'bki_0123456789ABCDEFGHJKMNPQRS';
const WORKFLOW_ID = 'wf_test_123';
const DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;

const { mockEnvStore, mockFindUnique, mockIncrBy, mockExpire, mockExecuteRaw } = vi.hoisted(() => ({
  // Inlined literal: vi.hoisted() runs before the top-level `const JOB_TOKEN`,
  // so it can't reference that binding (keep this in sync with JOB_TOKEN below).
  mockEnvStore: { JOB_TOKEN: 'test-job-token' } as Record<string, unknown>,
  mockFindUnique: vi.fn(),
  mockIncrBy: vi.fn(),
  mockExpire: vi.fn(),
  mockExecuteRaw: vi.fn(),
}));

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
// Pipeline flag is hard-ON here — this file is about the post-gate contract.
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn(async (flag: string) => flag === 'app-blocks-pipeline-enabled'),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { blockUserSubscription: { findUnique: mockFindUnique } },
  // G6: the handler persists the queue read-model status on first delivery.
  dbWrite: { $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a) },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { incrBy: mockIncrBy, expire: mockExpire },
  REDIS_KEYS: { BLOCKS: { TOKEN_RATE_LIMIT: 'blocks:token-rate-limit' } },
}));

function makeReq(over: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'POST',
    headers: { 'x-civitai-internal-token': JOB_TOKEN },
    body: { workflowId: WORKFLOW_ID, blockInstanceId: BLOCK_INSTANCE_ID, buzzSpent: 0 },
    ...over,
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

async function invoke(req: NextApiRequest, res: NextApiResponse) {
  const handler = (await import('~/pages/api/internal/blocks/workflow-completed')).default;
  await handler(req, res);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnvStore.JOB_TOKEN = JOB_TOKEN;
  // Default: valid install + first-time dedup so the happy path reaches 200.
  mockFindUnique.mockResolvedValue({ id: 'sub_1', targetModelIds: [7], appBlockId: 'apb_1' });
  mockIncrBy.mockResolvedValue(1);
  mockExpire.mockResolvedValue(1);
  mockExecuteRaw.mockResolvedValue(1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workflow-completed — JOB_TOKEN auth', () => {
  it('401s a wrong internal token and never touches the DB/Redis', async () => {
    const res = makeRes();
    await invoke(makeReq({ headers: { 'x-civitai-internal-token': 'wrong' } }), res);
    expect(res._status).toBe(401);
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockIncrBy).not.toHaveBeenCalled();
  });

  it('401s a token of a DIFFERENT length (safeEqualHeader length guard)', async () => {
    const res = makeRes();
    await invoke(makeReq({ headers: { 'x-civitai-internal-token': JOB_TOKEN + 'x' } }), res);
    expect(res._status).toBe(401);
  });

  it('401s when the token header is missing entirely', async () => {
    const res = makeRes();
    await invoke(makeReq({ headers: {} }), res);
    expect(res._status).toBe(401);
  });

  it('401s (fail-closed) when JOB_TOKEN is not configured on the server', async () => {
    // A missing server secret must NOT degrade into accept-anything.
    mockEnvStore.JOB_TOKEN = undefined;
    const res = makeRes();
    await invoke(makeReq({ headers: { 'x-civitai-internal-token': '' } }), res);
    expect(res._status).toBe(401);
  });

  it('accepts the correct token and reaches the post-auth path', async () => {
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(res._status).toBe(200);
  });
});

describe('workflow-completed — method + body validation', () => {
  it('405s a non-POST method before auth', async () => {
    const res = makeRes();
    await invoke(makeReq({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('400s a blockInstanceId that does not match the bki_<crockford26> shape', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: { workflowId: WORKFLOW_ID, blockInstanceId: 'nope', buzzSpent: 0 } }), res);
    expect(res._status).toBe(400);
    expect(mockIncrBy).not.toHaveBeenCalled();
  });

  it('400s a negative buzzSpent', async () => {
    const res = makeRes();
    await invoke(
      makeReq({ body: { workflowId: WORKFLOW_ID, blockInstanceId: BLOCK_INSTANCE_ID, buzzSpent: -1 } }),
      res
    );
    expect(res._status).toBe(400);
  });

  it('400s an empty workflowId (min(1))', async () => {
    const res = makeRes();
    await invoke(
      makeReq({ body: { workflowId: '', blockInstanceId: BLOCK_INSTANCE_ID, buzzSpent: 0 } }),
      res
    );
    expect(res._status).toBe(400);
  });

  it('400s a missing body without throwing', async () => {
    const res = makeRes();
    await invoke(makeReq({ body: undefined }), res);
    expect(res._status).toBe(400);
  });
});

describe('workflow-completed — install validation gates the dedup write (audit-9 #6)', () => {
  it('404s when the install is not found and NEVER writes a dedup marker', async () => {
    mockFindUnique.mockResolvedValue(null);
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(res._status).toBe(404);
    // Critical: a bogus pair must not burn a 7-day Redis slot.
    expect(mockIncrBy).not.toHaveBeenCalled();
  });

  it('404s when the install has empty targetModelIds and never writes a dedup marker', async () => {
    mockFindUnique.mockResolvedValue({ id: 'sub_1', targetModelIds: [], appBlockId: 'apb_1' });
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(res._status).toBe(404);
    expect(mockIncrBy).not.toHaveBeenCalled();
  });

  it('404s when targetModelIds is null and never writes a dedup marker', async () => {
    mockFindUnique.mockResolvedValue({ id: 'sub_1', targetModelIds: null, appBlockId: 'apb_1' });
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(res._status).toBe(404);
    expect(mockIncrBy).not.toHaveBeenCalled();
  });
});

describe('workflow-completed — idempotency dedup (M-6, Critical path 8)', () => {
  it('FIRST delivery: incrBy returns 1 → processes, sets the 7-day TTL, {ok:true}', async () => {
    mockIncrBy.mockResolvedValue(1);
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true });
    // Marker keyed on workflowId ALONE (audit-10 M6) and TTL set on first sight.
    // Assert the EXACT key shape, not just .toContain — a composite key (e.g.
    // accidentally folding in blockInstanceId) would still contain the workflowId
    // yet silently break cross-call dedup.
    expect(mockIncrBy).toHaveBeenCalledTimes(1);
    expect(mockIncrBy.mock.calls[0][0]).toBe(`blocks:token-rate-limit:wf:${WORKFLOW_ID}`);
    expect(mockExpire).toHaveBeenCalledTimes(1);
    expect(mockExpire.mock.calls[0][1]).toBe(DEDUP_TTL_SECONDS);
  });

  it('RETRY: incrBy returns 2 → short-circuits with {ok:true, idempotent:true} and does NOT re-set the TTL', async () => {
    mockIncrBy.mockResolvedValue(2);
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, idempotent: true });
    // A retry must not refresh/extend the dedup window.
    expect(mockExpire).not.toHaveBeenCalled();
  });

  it('two sequential deliveries of the same workflowId: first processes, second is idempotent', async () => {
    // Simulate Redis returning the real monotonic count across two calls.
    mockIncrBy.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const res1 = makeRes();
    await invoke(makeReq(), res1);
    const res2 = makeRes();
    await invoke(makeReq(), res2);
    expect(res1._body).toEqual({ ok: true });
    expect(res2._body).toEqual({ ok: true, idempotent: true });
  });

  it('Redis fail-closed: an incrBy throw is treated as already-processed (no double-bill)', async () => {
    mockIncrBy.mockRejectedValue(new Error('redis down'));
    const res = makeRes();
    await invoke(makeReq(), res);
    // markWorkflowProcessed swallows the error and returns false → idempotent
    // short-circuit. The handler must NOT throw / 500 and must NOT proceed to
    // the (eventual) billing path.
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, idempotent: true });
    expect(mockExpire).not.toHaveBeenCalled();
  });
});
