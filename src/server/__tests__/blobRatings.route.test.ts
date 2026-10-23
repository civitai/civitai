import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import '~/__tests__/mocks/logging.mock';

const { headBlob } = vi.hoisted(() => ({ headBlob: vi.fn() }));

// Hand-listed: the real package cannot load in the node test environment (directory imports).
vi.mock('@civitai/orchestration-client', () => ({
  headBlob,
  NsfwLevel: { PG: 'pg', PG13: 'pg13', R: 'r', X: 'x', XXX: 'xxx', NA: 'na' },
}));
vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: () => ({}),
}));
// Not spread from the real module: loading it pulls in the whole orchestrator client.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  OrchestratorEndpoint: (handler: unknown) => handler,
}));

const handler = (await import('~/pages/api/orchestrator/blobRatings')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse,
  user: unknown,
  token: string
) => Promise<void>;

async function call(body: unknown) {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(json: unknown) {
      out.body = json;
      return res;
    },
  } as unknown as NextApiResponse;
  await handler({ method: 'POST', body } as NextApiRequest, res, { id: 42 }, 'secret-token');
  return out;
}

const answered = (status: number, level?: string) => ({
  response: new Response(null, {
    status,
    headers: level ? { 'X-NSFW-Level': level } : {},
  }),
});

describe('POST /api/orchestrator/blobRatings', () => {
  it("reads each blob's level, and anything without one as unrated", async () => {
    headBlob.mockImplementation(async ({ path }: { path: { blobId: string } }) => {
      switch (path.blobId) {
        case 'R1.jpeg':
          return answered(204, 'R');
        case 'PG13.jpeg':
          return answered(204, 'PG13');
        case 'SCANNING.jpeg':
          return answered(204, 'NA');
        case 'GONE.jpeg':
          return answered(404);
        default:
          throw new Error('network down');
      }
    });

    const { status, body } = await call({
      blobIds: ['R1.jpeg', 'PG13.jpeg', 'SCANNING.jpeg', 'GONE.jpeg', 'DOWN.jpeg'],
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      ratings: [
        { blobId: 'R1.jpeg', nsfwLevel: 'r' },
        { blobId: 'PG13.jpeg', nsfwLevel: 'pg13' },
        { blobId: 'SCANNING.jpeg', nsfwLevel: null },
        { blobId: 'GONE.jpeg', nsfwLevel: null },
        { blobId: 'DOWN.jpeg', nsfwLevel: null },
      ],
    });
  });

  it('refuses an id that is not a blob id', async () => {
    headBlob.mockClear();
    expect((await call({ blobIds: ['../workflows/x'] })).status).toBe(400);
    expect(headBlob).not.toHaveBeenCalled();
  });
});
