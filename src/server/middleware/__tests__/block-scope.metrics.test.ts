import { describe, expect, it, vi, beforeEach } from 'vitest';
// Setup-order import: installs the ~/env/server mock with the real test RSA
// keypair BEFORE block-token.service / the middleware evaluate env at module
// load (same posture as block-scope.runtime-flag.test.ts).
import '~/__tests__/setup';
import client from 'prom-client';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * App Blocks runtime observability — per-app REST RED coverage.
 *
 * Drives a REAL, valid block JWT (minted via BlockTokenService, signed with the
 * test RSA key from ~/__tests__/setup) through the REAL `withBlockScope`
 * middleware and asserts that `civitai_app_block_requests_total` increments with
 * the correct {app_block_id, endpoint, result} on the success / 5xx /
 * client-error / forbidden (missing-scope) paths, and that the duration
 * histogram records a sample. Mirrors block-scope.runtime-flag.test.ts's setup;
 * mocks ONLY the runtime flag (ON), revocation (not revoked), and the
 * fire-and-forget audit-log service (so the finish handler doesn't touch a DB).
 */

const { mockFlipt, isFliptMock } = vi.hoisted(() => {
  const mockFlipt = { runtime: true };
  return {
    mockFlipt,
    isFliptMock: vi.fn(async (flag: string) =>
      flag === 'app-blocks-runtime-enabled' ? mockFlipt.runtime : false
    ),
  };
});
vi.mock('~/server/flipt/client', () => ({ isFlipt: isFliptMock }));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: vi.fn(async () => false) },
}));
// The success path registers a fire-and-forget res.on('finish') audit logger
// that dynamic-imports this service; stub it so invoking the finish listeners
// doesn't reach a real DB.
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: vi.fn(async () => undefined),
}));

import { withBlockScope } from '../block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';
import type { AppBlockEndpoint } from '~/server/metrics/app-block-runtime.metrics';

const MODEL_ID = 12345;
const APP_BLOCK_ID = 'apb_metrics_test';
const REQUIRED_SCOPE = 'models:read:self';

async function mintToken(
  scopes: string[] = [REQUIRED_SCOPE],
  opts: { dev?: boolean; appBlockId?: string } = {}
): Promise<string> {
  const r = await BlockTokenService.sign({
    userId: 42,
    blockId: 'blk_test',
    appId: 'app_test',
    appBlockId: opts.appBlockId ?? APP_BLOCK_ID,
    blockInstanceId: 'bki_test',
    scopes,
    ctx: { modelId: MODEL_ID },
    ...(opts.dev ? { dev: true } : {}),
  });
  return r.token;
}

// A fake res that captures finish/close listeners so the test can drive the
// response-finished transition the metric fires on.
function makeRes() {
  const finishListeners: Array<() => void> = [];
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send() {
      return this;
    },
    end() {
      return this;
    },
    setHeader() {
      return this;
    },
    removeHeader() {
      return this;
    },
    writeHead() {
      return this;
    },
    getHeader() {
      return undefined;
    },
    on(event: string, cb: () => void) {
      if (event === 'finish' || event === 'close') finishListeners.push(cb);
      return this;
    },
    _finish() {
      for (const cb of finishListeners) cb();
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown; _finish(): void };
}

function makeReq(token: string): NextApiRequest {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    query: { id: String(MODEL_ID) },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

async function counterValue(
  endpoint: AppBlockEndpoint,
  result: string,
  appBlockId: string = APP_BLOCK_ID
): Promise<number> {
  const metric = client.register.getSingleMetric('civitai_app_block_requests_total');
  if (!metric) return 0;
  const data = await (metric as { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }).get();
  const match = data.values.find(
    (v) => v.labels.app_block_id === appBlockId && v.labels.endpoint === endpoint && v.labels.result === result
  );
  return match?.value ?? 0;
}

async function histogramCount(endpoint: AppBlockEndpoint): Promise<number> {
  const metric = client.register.getSingleMetric('civitai_app_block_request_duration_seconds');
  if (!metric) return 0;
  const data = await (metric as { get(): Promise<{ values: Array<{ metricName?: string; labels: Record<string, string>; value: number }> }> }).get();
  const match = data.values.find(
    (v) => v.metricName?.endsWith('_count') && v.labels.app_block_id === APP_BLOCK_ID && v.labels.endpoint === endpoint
  );
  return match?.value ?? 0;
}

/** Wrapped handler that just sets a status and returns. */
function statusHandler(code: number) {
  return vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
    res.status(code).json({ ok: code < 400 });
  });
}

beforeEach(() => {
  mockFlipt.runtime = true;
  isFliptMock.mockClear();
});

describe('withBlockScope — per-app REST RED metric', () => {
  it('increments result=success + records a duration sample on a 2xx', async () => {
    const before = await counterValue('model_detail', 'success');
    const beforeHist = await histogramCount('model_detail');
    const route = withBlockScope(statusHandler(200) as never, {
      endpoint: 'model_detail',
      requiredScope: REQUIRED_SCOPE,
    });
    const res = makeRes();
    await route(makeReq(await mintToken()) as never, res as never);
    res._finish();

    expect(await counterValue('model_detail', 'success')).toBe(before + 1);
    expect(await histogramCount('model_detail')).toBe(beforeHist + 1);
  });

  it('increments result=server_error on a 5xx', async () => {
    const before = await counterValue('model_detail', 'server_error');
    const route = withBlockScope(statusHandler(500) as never, {
      endpoint: 'model_detail',
      requiredScope: REQUIRED_SCOPE,
    });
    const res = makeRes();
    await route(makeReq(await mintToken()) as never, res as never);
    res._finish();

    expect(await counterValue('model_detail', 'server_error')).toBe(before + 1);
  });

  it('increments result=client_error on a 4xx (non-403)', async () => {
    const before = await counterValue('model_detail', 'client_error');
    const route = withBlockScope(statusHandler(404) as never, {
      endpoint: 'model_detail',
      requiredScope: REQUIRED_SCOPE,
    });
    const res = makeRes();
    await route(makeReq(await mintToken()) as never, res as never);
    res._finish();

    expect(await counterValue('model_detail', 'client_error')).toBe(before + 1);
  });

  it('increments result=forbidden when the middleware itself rejects a missing scope (403)', async () => {
    const before = await counterValue('model_detail', 'forbidden');
    // The wrapped handler would 200, but the token lacks the required scope so
    // the middleware 403s BEFORE calling it — the metric must still attribute it.
    const wrapped = statusHandler(200);
    const route = withBlockScope(wrapped as never, {
      endpoint: 'model_detail',
      requiredScope: 'buzz:read:self', // token only carries models:read:self
    });
    const res = makeRes();
    // token carries only models:read:self
    await route(makeReq(await mintToken(['models:read:self'])) as never, res as never);
    res._finish();

    expect(res.statusCode).toBe(403);
    expect(wrapped).not.toHaveBeenCalled();
    expect(await counterValue('model_detail', 'forbidden')).toBe(before + 1);
  });

  it('buckets a DEV token (synthetic appBlockId) to app_block_id="dev"', async () => {
    const before = await counterValue('model_detail', 'success', 'dev');
    // Dev tokens carry a caller-constructed synthetic appBlockId — an unbounded
    // label vector. It must collapse to the single 'dev' bucket, NOT pass raw.
    const route = withBlockScope(statusHandler(200) as never, {
      endpoint: 'model_detail',
      requiredScope: REQUIRED_SCOPE,
    });
    const res = makeRes();
    await route(
      makeReq(await mintToken([REQUIRED_SCOPE], { dev: true, appBlockId: 'apb_synthetic_dev_xyz' })) as never,
      res as never
    );
    res._finish();

    expect(await counterValue('model_detail', 'success', 'dev')).toBe(before + 1);
    // The synthetic id NEVER became a label.
    expect(await counterValue('model_detail', 'success', 'apb_synthetic_dev_xyz')).toBe(0);
  });

  it('keeps a normal (non-dev) token on its real appBlockId', async () => {
    const before = await counterValue('model_detail', 'success', APP_BLOCK_ID);
    const route = withBlockScope(statusHandler(200) as never, {
      endpoint: 'model_detail',
      requiredScope: REQUIRED_SCOPE,
    });
    const res = makeRes();
    await route(makeReq(await mintToken()) as never, res as never);
    res._finish();

    expect(await counterValue('model_detail', 'success', APP_BLOCK_ID)).toBe(before + 1);
  });
});
