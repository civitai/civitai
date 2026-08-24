import { beforeEach, describe, expect, it, vi } from 'vitest';

// Lives here, not beside the route: Next treats every file under src/pages as a route and
// `next build` runs a route-type validator over it, so a test there fails the build in a
// step nothing else catches.

vi.mock('~/server/utils/endpoint-helpers', () => ({
  AuthedEndpoint: (handler: unknown) => handler,
}));

import { dbMock } from '~/__tests__/mocks';
import handler from '~/pages/api/download/training/[modelVersionId]';

const findUnique = dbMock.dbRead.modelVersion.findUnique;

const OWNER = { id: 10, isModerator: false };
const EPOCH_URL = 'https://orchestration.civitai.com/v2/consumer/blobs/MODEL3.safetensors?sig=abc';

const givenModelVersion = (trainingDetails: unknown) =>
  findUnique.mockResolvedValue({
    id: 1284593,
    trainingDetails,
    model: { id: 7, userId: OWNER.id, name: 'esadribicstyle' },
    files: [
      {
        metadata: {
          trainingResults: {
            version: 2,
            epochs: [{ epochNumber: 3, modelUrl: EPOCH_URL }],
          },
        },
      },
    ],
  });

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    statusCode: 0,
    body: undefined as unknown,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    end: () => res,
  };
  return res;
}

// `body: null` short-circuits the handler right AFTER it sets Content-Disposition, so the
// header is observable without plumbing a real stream through the response.
const call = async () => {
  const res = makeRes();
  const req = { query: { modelVersionId: '1284593', epochNumber: '3' }, on: vi.fn(), off: vi.fn() };
  await (handler as unknown as (r: unknown, s: unknown, u: unknown) => Promise<unknown>)(
    req,
    res,
    OWNER
  );
  return res;
};

describe('training epoch download filename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: null }))
    );
  });

  it('carries the architecture and the version id', async () => {
    givenModelVersion({ baseModel: 'krea2' });

    const res = await call();

    expect(res.headers['Content-Disposition']).toBe(
      'attachment; filename="esadribicstyle_krea2_1284593_epoch_3.safetensors"'
    );
  });

  it('distinguishes a second architecture on the same model', async () => {
    givenModelVersion({ baseModel: 'pony' });

    const res = await call();

    expect(res.headers['Content-Disposition']).toContain('esadribicstyle_pony_');
  });

  it('omits the segment for a run predating the field rather than emitting an empty one', async () => {
    givenModelVersion(null);

    const res = await call();

    expect(res.headers['Content-Disposition']).toBe(
      'attachment; filename="esadribicstyle_1284593_epoch_3.safetensors"'
    );
  });

  it('refuses an epoch URL outside the orchestrator hosts', async () => {
    findUnique.mockResolvedValue({
      id: 1284593,
      trainingDetails: { baseModel: 'krea2' },
      model: { id: 7, userId: OWNER.id, name: 'esadribicstyle' },
      files: [
        {
          metadata: {
            trainingResults: {
              version: 2,
              epochs: [{ epochNumber: 3, modelUrl: 'https://evil.example.com/blobs/x' }],
            },
          },
        },
      ],
    });

    const res = await call();

    expect(res.statusCode).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
