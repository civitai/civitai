import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Decision 1 — pipeline flag for POST /api/internal/blocks/workflow-completed.
 *
 * G6 CHANGE: the pipeline flag `app-blocks-pipeline-enabled` NO LONGER gates the
 * whole endpoint. The G6 queue read-model STATUS persistence is UN-GATED (it is
 * not billing) — it runs regardless of the flag, keeping the JOB_TOKEN guard +
 * 7-day idempotency. The flag now gates only the FUTURE Phase-3 billing/ClickHouse
 * path (currently a no-op). These tests pin:
 *   - pipeline flag OFF → still 200 + status persisted (NOT 503); install lookup
 *     + dedup + queue update all run;
 *   - pipeline flag ON → also 200 (billing scaffold is a no-op today);
 *   - the flag read is the PIPELINE key, never the user-facing `app-blocks-enabled`.
 *
 * `isFlipt` is mocked PER-KEY (only `app-blocks-pipeline-enabled` reflects the
 * toggle; `app-blocks-enabled` is hard-false) so a regression that repointed the
 * billing gate at the user flag would be caught.
 */

const JOB_TOKEN = 'test-job-token';
const BLOCK_INSTANCE_ID = 'bki_0123456789ABCDEFGHJKMNPQRS';
const WORKFLOW_ID = 'wf_test_123';

const { mockFlag, mockFindUnique, mockIncrBy, mockExpire, mockExecuteRaw } = vi.hoisted(() => ({
  mockFlag: { enabled: true },
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
// Per-key Flipt mock: only the pipeline key reflects mockFlag.enabled.
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn(async (flag: string) =>
    flag === 'app-blocks-pipeline-enabled' ? mockFlag.enabled : false
  ),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { blockUserSubscription: { findUnique: mockFindUnique } },
  // G6: the handler now persists the queue read-model status via
  // updateBlockWorkflowStatus (dbWrite.$executeRaw). UN-gated by the pipeline flag.
  dbWrite: { $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a) },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { incrBy: mockIncrBy, expire: mockExpire },
  REDIS_KEYS: { BLOCKS: { TOKEN_RATE_LIMIT: 'blocks:token-rate-limit' } },
}));

import { isFlipt } from '~/server/flipt/client';

const mockedIsFlipt = vi.mocked(isFlipt);

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

describe('workflow-completed webhook — pipeline flag gate (Decision 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.enabled = true;
    // Default: valid install + first-time dedup so the ON path reaches 200.
    mockFindUnique.mockResolvedValue({
      id: 'sub_1',
      targetModelIds: [7],
      appBlockId: 'apb_1',
    });
    mockIncrBy.mockResolvedValue(1);
    mockExpire.mockResolvedValue(1);
    mockExecuteRaw.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('G6: still 200 + persists status when the pipeline (billing) flag is OFF (status is un-gated)', async () => {
    mockFlag.enabled = false;
    const res = makeRes();
    await invoke(makeReq(), res);
    // NO LONGER 503 — the queue read-model status update is not billing.
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ ok: true });
    // Install lookup + dedup + the queue status UPDATE all ran despite the flag.
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    expect(mockIncrBy).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it('proceeds to 200 when the pipeline flag is on (billing scaffold is a no-op today)', async () => {
    mockFlag.enabled = true;
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ ok: true });
    // install lookup + dedup + queue update ran.
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    expect(mockIncrBy).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it('reads the PIPELINE flag key for the billing gate, never the user-facing app-blocks-enabled', async () => {
    mockFlag.enabled = true;
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(mockedIsFlipt).toHaveBeenCalledWith('app-blocks-pipeline-enabled');
    expect(mockedIsFlipt).not.toHaveBeenCalledWith(
      'app-blocks-enabled',
      expect.anything(),
      expect.anything()
    );
    expect(mockedIsFlipt).not.toHaveBeenCalledWith('app-blocks-enabled');
  });

  it('still rejects an unauthenticated caller (401) BEFORE the flag is consulted', async () => {
    const res = makeRes();
    await invoke(makeReq({ headers: { 'x-civitai-internal-token': 'wrong' } }), res);
    expect(res._status).toBe(401);
    expect(mockedIsFlipt).not.toHaveBeenCalled();
  });
});
