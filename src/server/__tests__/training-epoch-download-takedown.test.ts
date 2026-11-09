import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as OrchestratorToken from '~/server/orchestrator/get-orchestrator-token';

/** Training epochs are a model's weights: a taken-down model's are served to moderators only. */

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  AuthedEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorToken>()),
  getOrchestratorToken: async () => 'token',
}));

import { dbMock } from '~/__tests__/mocks';
import handler from '~/pages/api/download/training/[modelVersionId]';

const OWNER = { id: 10, isModerator: false };
const MODERATOR = { id: 1, isModerator: true };
const EPOCH_URL = 'https://orchestration.civitai.com/v2/consumer/blobs/MODEL3.safetensors?sig=abc';

function givenModel(mode: string | null) {
  dbMock.dbWrite.modelVersion.findFirst.mockResolvedValue({
    id: 1284593,
    trainingStatus: 'InReview',
    trainingDetails: { baseModel: 'krea2' },
    meta: null,
    model: { id: 7, userId: OWNER.id, name: 'esadribicstyle' },
    files: [
      {
        id: 5,
        type: 'Training Data',
        metadata: {
          trainingResults: { version: 2, epochs: [{ epochNumber: 3, modelUrl: EPOCH_URL }] },
        },
      },
    ],
  } as never);
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
    status: 'Published',
    model: { status: 'Published', mode },
  } as never);
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn(),
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

async function download(user: { id: number; isModerator: boolean }, epochNumber = '3') {
  const res = makeRes();
  const req = { query: { modelVersionId: '1284593', epochNumber }, on: vi.fn(), off: vi.fn() };
  await (handler as unknown as (r: unknown, s: unknown, u: unknown) => Promise<unknown>)(
    req,
    res,
    user
  );
  return res;
}

describe('/api/download/training/[modelVersionId] on a taken-down model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: null }))
    );
  });

  it("refuses its owner with the same 404 as an epoch that doesn't exist", async () => {
    givenModel(null);
    const missing = await download(OWNER, '99');
    givenModel('TakenDown');

    const res = await download(OWNER, '99');
    const refused = await download(OWNER);

    expect(res.body).toEqual(missing.body);
    expect(refused.statusCode).toBe(404);
    expect(refused.body).toEqual({ error: 'Epoch 3 not found' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still serves a moderator', async () => {
    givenModel('TakenDown');

    await download(MODERATOR);

    expect(fetch).toHaveBeenCalledWith(EPOCH_URL, expect.anything());
  });

  it('serves the owner of a model that is not taken down', async () => {
    givenModel(null);

    await download(OWNER);

    expect(fetch).toHaveBeenCalledWith(EPOCH_URL, expect.anything());
  });
});
