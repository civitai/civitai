import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const { getConsumerBlobUploadUrl } = vi.hoisted(() => ({ getConsumerBlobUploadUrl: vi.fn() }));
const { logToAxiom } = loggingMock;

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
  await handler({ method: 'GET' } as NextApiRequest, res, { id: 42 }, 'secret-token');
  return out;
}

const { getConsumerBlobUploadUrlService } = await import(
  '~/server/services/orchestrator/consumerBlobUpload'
);

const upstream = (status: number, error?: unknown) =>
  getConsumerBlobUploadUrl.mockResolvedValueOnce({ data: undefined, error, response: { status } });

beforeEach(() => logToAxiom.mockClear());
const logged = () =>
  logToAxiom.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);

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

describe('presign failure logging', () => {
  it('logs an upstream 5xx as a bounded warning before answering 502', async () => {
    upstream(503, { detail: 'upstream down', status: 503 });
    expect((await call()).status).toBe(502);
    // Strict, so a field is pinned even where its expected value is `undefined`.
    expect(logged()).toStrictEqual([
      {
        type: 'warning',
        name: 'consumer-blob-presign-failed',
        userId: 42,
        code: 'SERVICE_UNAVAILABLE',
        errorName: 'TRPCError',
        errorMessage: 'Generation services are temporarily unavailable. Please try again.',
        // TRPCError wraps a non-Error cause in an Error that carries its fields.
        causeName: 'Error',
        causeCode: undefined,
        causeStatus: 503,
        causeMessage: '',
        causeDetail: 'upstream down',
        rootCauseCode: undefined,
      },
    ]);
    expect(logToAxiom.mock.calls[0]).toHaveLength(2);
    expect((logToAxiom.mock.calls[0] as unknown[])[1]).toBe('civitai-prod');
  });

  it('logs an unreachable upstream with its root connection code', async () => {
    // The production shape: the client RESOLVES on a fetch failure, with the fetch's TypeError as
    // `error` and no response; the connection code sits on that TypeError's own cause.
    const root = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    getConsumerBlobUploadUrl.mockResolvedValueOnce({
      data: undefined,
      error: new TypeError('fetch failed', { cause: root }),
      response: undefined,
    });
    expect((await call()).status).toBe(502);
    expect(logged()).toEqual([
      expect.objectContaining({
        type: 'warning',
        code: 'SERVICE_UNAVAILABLE',
        errorName: 'TRPCError',
        causeName: 'TypeError',
        causeMessage: 'fetch failed',
        rootCauseCode: 'ECONNREFUSED',
      }),
    ]);
  });

  it('truncates every logged string, such as an upstream error page', async () => {
    const long = (tag: string) => `${tag}${'x'.repeat(5_000)}`;
    const cause = Object.assign(new Error(long('<!DOCTYPE html>')), {
      name: long('name'),
      code: long('code'),
      detail: long('detail'),
    });
    getConsumerBlobUploadUrl.mockRejectedValueOnce(
      Object.assign(new Error(long('message'), { cause }), { name: long('name') })
    );
    await call();
    const entry = logged()[0];
    const fields = ['errorName', 'errorMessage', 'causeName', 'causeCode', 'causeMessage'];
    const all = fields.concat('causeDetail', 'rootCauseCode');
    expect(all.map((f) => (entry[f] as string).length)).toEqual(Array(7).fill(300));
  });

  it('truncates a raw string cause', async () => {
    getConsumerBlobUploadUrl.mockRejectedValueOnce(
      new Error('bad gateway', { cause: `<!DOCTYPE html>${'x'.repeat(5_000)}` })
    );
    await call();
    expect((logged()[0].causeMessage as string).length).toBe(300);
  });

  it('still answers 502, and handles the failure, when the log write fails', async () => {
    let handled = false;
    // Not a real promise: `vi.fn` attaches its own handler to a returned promise to track its
    // result, which would hide a missing `.catch` on a rejected one.
    logToAxiom.mockImplementationOnce(
      () =>
        ({
          then: () => undefined,
          catch: (onRejected: (e: unknown) => unknown) => {
            handled = true;
            return Promise.resolve(onRejected(new Error('log sink down')));
          },
        } as unknown as Promise<void>)
    );
    upstream(503, { detail: 'upstream down' });
    expect(await call()).toEqual({ status: 502, body: 'Failed to get upload URL' });
    expect(handled).toBe(true);
  });

  it.each([
    [401, 403],
    [403, 403],
    [400, 400],
    [429, 429],
    [404, 400],
  ])('does not log an expected upstream %i (answered %i)', async (upstreamStatus, answered) => {
    upstream(upstreamStatus, { detail: 'x' });
    expect((await call()).status).toBe(answered);
    expect(logToAxiom).not.toHaveBeenCalled();
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
