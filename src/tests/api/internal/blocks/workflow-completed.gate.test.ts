import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Decision 1 — pipeline flag gate for POST /api/internal/blocks/workflow-completed.
 *
 * The orchestrator → civitai completion callback is gated by the dedicated
 * global `app-blocks-pipeline-enabled` flag (NOT the mod-segmented user flag).
 * These tests pin:
 *   - pipeline flag OFF / absent → 503 "App Blocks not enabled", install lookup
 *     + dedup never run (kill switch, fail-safe to dark);
 *   - pipeline flag ON → the handler proceeds PAST the gate (reaches the install
 *     lookup / dedup / 200 path);
 *   - the gate reads the PIPELINE key, never the user-facing `app-blocks-enabled`.
 *
 * `isFlipt` is mocked PER-KEY (only `app-blocks-pipeline-enabled` reflects the
 * toggle; `app-blocks-enabled` is hard-false) so a regression that repointed the
 * gate back to the user flag would 503 even with the pipeline "on".
 */

const JOB_TOKEN = 'test-job-token';
const BLOCK_INSTANCE_ID = 'bki_0123456789ABCDEFGHJKMNPQRS';
const WORKFLOW_ID = 'wf_test_123';

const { mockFlag, mockFindUnique, mockIncrBy, mockExpire } = vi.hoisted(() => ({
  mockFlag: { enabled: true },
  mockFindUnique: vi.fn(),
  mockIncrBy: vi.fn(),
  mockExpire: vi.fn(),
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('503s when the pipeline flag is off — install lookup + dedup never run (kill switch)', async () => {
    mockFlag.enabled = false;
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(res._status).toBe(503);
    expect(res._body).toMatchObject({ error: 'App Blocks not enabled' });
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockIncrBy).not.toHaveBeenCalled();
  });

  it('proceeds PAST the gate when the pipeline flag is on (reaches the install/dedup path → 200)', async () => {
    mockFlag.enabled = true;
    const res = makeRes();
    await invoke(makeReq(), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ ok: true });
    // It got past the gate: install lookup + dedup ran.
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    expect(mockIncrBy).toHaveBeenCalledTimes(1);
  });

  it('gates on the PIPELINE flag key, never the user-facing app-blocks-enabled (Decision 1)', async () => {
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
