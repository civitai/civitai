import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * G6 — the completion callback updates the block_workflows queue read-model.
 *
 * POST /api/internal/blocks/workflow-completed persists the settled workflow's
 * status into block_workflows so a block can rebuild its output queue. These
 * tests pin the queue-update contract:
 *   - first delivery UPDATEs (status, workflow_id), server-derived from the body;
 *   - the status defaults to 'succeeded' when the body omits it, and an explicit
 *     terminal status is honored;
 *   - a RETRY (idempotency short-circuit) does NOT touch the queue again;
 *   - the JOB_TOKEN guard runs BEFORE any queue write (unauthenticated → no write).
 */

const JOB_TOKEN = 'test-job-token';
const BLOCK_INSTANCE_ID = 'bki_0123456789ABCDEFGHJKMNPQRS';
const WORKFLOW_ID = 'wf_test_123';

const { mockFindUnique, mockIncrBy, mockExpire, mockExecuteRaw } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockIncrBy: vi.fn(),
  mockExpire: vi.fn(),
  mockExecuteRaw: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/env/server', () => ({
  env: new Proxy({ JOB_TOKEN } as Record<string, unknown>, {
    get(t, p: string) {
      if (p in t) return t[p];
      if (p === 'LOGGING') return '';
      return undefined;
    },
  }),
}));
// Pipeline flag hard-ON — this file is about the (un-gated) queue update, not the gate.
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn(async (flag: string) => flag === 'app-blocks-pipeline-enabled'),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { blockUserSubscription: { findUnique: mockFindUnique } },
  dbWrite: { $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a) },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { incrBy: mockIncrBy, expire: mockExpire },
  REDIS_KEYS: { BLOCKS: { TOKEN_RATE_LIMIT: 'blocks:token-rate-limit' } },
}));

function makeReq(bodyOver: Record<string, unknown> = {}, over: Partial<NextApiRequest> = {}) {
  return {
    method: 'POST',
    headers: { 'x-civitai-internal-token': JOB_TOKEN },
    body: { workflowId: WORKFLOW_ID, blockInstanceId: BLOCK_INSTANCE_ID, buzzSpent: 0, ...bodyOver },
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

// The UPDATE is `dbWrite.$executeRaw` as a tagged template: (strings, status, workflowId).
function updateArgs(call: unknown[]): { status: unknown; workflowId: unknown } {
  return { status: call[1], workflowId: call[2] };
}

describe('workflow-completed — G6 queue read-model update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue({ id: 'sub_1', targetModelIds: [7], appBlockId: 'apb_1' });
    mockIncrBy.mockResolvedValue(1); // first delivery
    mockExpire.mockResolvedValue(1);
    mockExecuteRaw.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('first delivery UPDATEs the queue with a default status of succeeded', async () => {
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(res._status).toBe(200);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(updateArgs(mockExecuteRaw.mock.calls[0])).toEqual({
      status: 'succeeded',
      workflowId: WORKFLOW_ID,
    });
  });

  it('honors an explicit terminal status in the callback body', async () => {
    const res = makeRes();
    await invoke(makeReq({ status: 'failed' }), res);
    expect(res._status).toBe(200);
    expect(updateArgs(mockExecuteRaw.mock.calls[0])).toEqual({
      status: 'failed',
      workflowId: WORKFLOW_ID,
    });
  });

  it('rejects an out-of-set status at the schema (400) before any queue write', async () => {
    const res = makeRes();
    await invoke(makeReq({ status: 'not-a-status' }), res);
    expect(res._status).toBe(400);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it('RETRY (idempotent) short-circuits and does NOT update the queue again', async () => {
    mockIncrBy.mockResolvedValue(2); // second delivery → already processed
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ idempotent: true });
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it('a lost queue update (DB error) still returns 200 (best-effort, fail-safe)', async () => {
    mockExecuteRaw.mockRejectedValueOnce(new Error('db down'));
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ ok: true });
  });

  it('JOB_TOKEN guard runs BEFORE the queue update (unauthenticated → 401, no write)', async () => {
    const res = makeRes();
    await invoke(makeReq({}, { headers: { 'x-civitai-internal-token': 'wrong' } }), res);
    expect(res._status).toBe(401);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });
});
