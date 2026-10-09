import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { getConsumerBlobUploadUrl } = vi.hoisted(() => ({ getConsumerBlobUploadUrl: vi.fn() }));

// Hand-listed: the real package cannot load in the node test environment (directory imports).
vi.mock('@civitai/client', () => ({
  getConsumerBlobUploadUrl,
  handleError: (error: { detail?: string }) => error.detail,
}));
vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: () => ({}),
}));
// Not spread from the real module: loading it pulls in the whole orchestrator client.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  OrchestratorEndpoint: (handler: unknown) => handler,
}));

const handler = (await import('~/pages/api/orchestrator/getConsumerBlobUploadUrl'))
  .default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse,
  user: unknown,
  token: string
) => Promise<void>;

async function call() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
    send(body: unknown) {
      out.body = body;
      return res;
    },
  } as unknown as NextApiResponse;
  await handler({ method: 'GET' } as NextApiRequest, res, {}, 'token');
  return out;
}

const { getConsumerBlobUploadUrlService } = await import(
  '~/server/services/orchestrator/consumerBlobUpload'
);

const upstream = (status: number, error?: unknown) =>
  getConsumerBlobUploadUrl.mockResolvedValueOnce({ data: undefined, error, response: { status } });

describe('GET /api/orchestrator/getConsumerBlobUploadUrl', () => {
  it('returns the presign on success', async () => {
    getConsumerBlobUploadUrl.mockResolvedValueOnce({ data: { uploadUrl: 'u', expiresAt: 'e' } });
    expect(await call()).toEqual({ status: 200, body: { uploadUrl: 'u', expiresAt: 'e' } });
  });

  it.each([401, 403])('passes an upstream %i through as a 403 with its message', async (status) => {
    upstream(status, { detail: 'Not allowed' });
    expect(await call()).toEqual({ status: 403, body: 'Not allowed' });
  });

  it('passes an upstream 400 through as a 400', async () => {
    upstream(400, { detail: 'Bad input' });
    expect(await call()).toEqual({ status: 400, body: 'Bad input' });
  });

  it('passes an upstream 429 with no body through as a 429', async () => {
    upstream(429);
    expect((await call()).status).toBe(429);
  });

  it.each([500, 503])('reports an upstream %i as a generic 502, not a denial', async (status) => {
    upstream(status, { detail: 'internal detail' });
    expect(await call()).toEqual({ status: 502, body: 'Failed to get upload URL' });
  });

  it('reports an upstream 404 as a 400', async () => {
    upstream(404, { detail: 'Not found' });
    expect(await call()).toEqual({ status: 400, body: 'Not found' });
  });

  it('reports a request that got no response as a 502', async () => {
    getConsumerBlobUploadUrl.mockResolvedValueOnce({ data: undefined, error: undefined });
    expect((await call()).status).toBe(502);
  });

  it('reports an unreachable upstream as a 502', async () => {
    getConsumerBlobUploadUrl.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await call()).status).toBe(502);
  });
});

describe('getConsumerBlobUploadUrlService', () => {
  it.each([
    ['no response', undefined],
    ['an upstream 503', { status: 503 }],
  ])('reports %s as SERVICE_UNAVAILABLE', async (_, response) => {
    getConsumerBlobUploadUrl.mockResolvedValueOnce({ data: undefined, error: undefined, response });
    await expect(getConsumerBlobUploadUrlService({ token: 't' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});
