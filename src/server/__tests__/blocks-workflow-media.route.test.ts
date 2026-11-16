import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveWorkflowMediaForBlockClaims, checkBlockCatalogRateLimit } = vi.hoisted(() => ({
  resolveWorkflowMediaForBlockClaims: vi.fn(),
  checkBlockCatalogRateLimit: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (handler: unknown) => handler }));
vi.mock('~/server/services/blocks/block-media-serving', () => ({
  resolveWorkflowMediaForBlockClaims,
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({ checkBlockCatalogRateLimit }));

const { baseHandler } = await import('~/pages/api/v1/blocks/workflow-media');
const { WORKFLOW_MEDIA_MAX_REFS } = await import(
  '~/shared/constants/block-workflow-media.constants'
);

async function post(body: unknown) {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    setHeader() {
      return res;
    },
    status(code: number) {
      out.status = code;
      return res;
    },
    json(payload: unknown) {
      out.body = payload;
      return res;
    },
  } as unknown as NextApiResponse;
  const req = {
    method: 'POST',
    body,
    blockClaims: { blockInstanceId: 'page_x', appBlockId: 'apb_media_fixture', sub: 'user:5121' },
  } as unknown as NextApiRequest;
  await (baseHandler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(
    req,
    res
  );
  return out;
}

const RESOLVED = {
  media: [{ status: 'visible', url: 'https://civitai.com/api/v1/blocks/media/bm1.t' }],
};
const refs = (n: number) => Array.from({ length: n }, (_, i) => `bm1.r${i}`);

beforeEach(() => {
  resolveWorkflowMediaForBlockClaims.mockReset().mockResolvedValue(RESOLVED);
  checkBlockCatalogRateLimit.mockReset().mockResolvedValue({ allowed: true });
});

describe('POST /api/v1/blocks/workflow-media', () => {
  it('CONTROL: the maximum number of refs is accepted', async () => {
    const r = await post({ refs: refs(WORKFLOW_MEDIA_MAX_REFS) });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(RESOLVED);
    expect(resolveWorkflowMediaForBlockClaims).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['one ref over the limit', { refs: refs(WORKFLOW_MEDIA_MAX_REFS + 1) }],
    ['an empty list', { refs: [] }],
  ])('🔴 refuses %s with a 400, before judging any ref', async (_label, body) => {
    expect((await post(body)).status).toBe(400);
    expect(resolveWorkflowMediaForBlockClaims).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/blocks/workflow-media — a refusal names its app', () => {
  async function refusals(app: string): Promise<number> {
    const { default: promClient } = await import('prom-client');
    const metric = promClient.register.getSingleMetric(
      'civitai_app_block_rate_limit_refusals_total'
    ) as
      | { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
      | undefined;
    if (!metric) return 0;
    const { values } = await metric.get();
    return (
      values.find(
        (v) =>
          v.labels.app_block_id === app &&
          v.labels.surface === 'rest' &&
          v.labels.bucket === 'catalog'
      )?.value ?? 0
    );
  }

  // Pins: the route's own catalog limiter records its refusal under the token's app.
  it('a catalog refusal is one {app, rest, catalog} increment, and a 429', async () => {
    checkBlockCatalogRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 3 });
    const before = await refusals('apb_media_fixture');

    expect((await post({ refs: refs(1) })).status).toBe(429);

    expect((await refusals('apb_media_fixture')) - before).toBe(1);
    expect(resolveWorkflowMediaForBlockClaims).not.toHaveBeenCalled();
  });

  it('an allowed request moves nothing', async () => {
    const before = await refusals('apb_media_fixture');
    expect((await post({ refs: refs(1) })).status).toBe(200);
    expect((await refusals('apb_media_fixture')) - before).toBe(0);
  });
});
