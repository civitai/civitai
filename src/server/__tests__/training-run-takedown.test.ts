import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as OrchestratorToken from '~/server/orchestrator/get-orchestrator-token';

/**
 * A training run's epochs are the model's weights. `resolveTrainingRun` is what the epoch download,
 * the epoch archive and the run state all read, so a deleted or taken-down model's run is refused
 * there to everyone but moderators.
 */

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
import { resolveTrainingRun } from '~/server/services/orchestrator/training/training-state';

const OWNER = { id: 10, isModerator: false };
const MODERATOR = { id: 1, isModerator: true };
const EPOCH_URL = 'https://orchestration.civitai.com/v2/consumer/blobs/MODEL3.safetensors?sig=abc';

type ModelState = { status: string; mode: string | null };
const PUBLISHED: ModelState = { status: 'Published', mode: null };
const TAKEN_DOWN: ModelState = { status: 'Published', mode: 'TakenDown' };
const DELETED: ModelState = { status: 'Deleted', mode: null };

function givenModel(state: ModelState) {
  // The model's state comes back only when the read selects it, as in prod.
  dbMock.dbWrite.modelVersion.findFirst.mockImplementation((async (args: {
    select?: { model?: { select?: { mode?: boolean; status?: boolean } } };
  }) => ({
    id: 1284593,
    status: 'Published',
    trainingStatus: 'InReview',
    trainingDetails: { baseModel: 'krea2' },
    meta: null,
    model: {
      id: 7,
      userId: OWNER.id,
      name: 'esadribicstyle',
      ...(args.select?.model?.select?.mode ? { mode: state.mode } : {}),
      ...(args.select?.model?.select?.status ? { status: state.status } : {}),
    },
    files: [
      {
        id: 5,
        type: 'Training Data',
        metadata: {
          trainingResults: { version: 2, epochs: [{ epochNumber: 3, modelUrl: EPOCH_URL }] },
        },
      },
    ],
  })) as never);
}

const resolve = (user: { id: number; isModerator: boolean }) =>
  resolveTrainingRun({
    modelVersionId: 1284593,
    userId: user.id,
    isModerator: user.isModerator,
    ctx: {} as never,
  });

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

async function downloadEpoch(user: { id: number; isModerator: boolean }) {
  const res = makeRes();
  const req = { query: { modelVersionId: '1284593', epochNumber: '3' }, on: vi.fn(), off: vi.fn() };
  await (handler as unknown as (r: unknown, s: unknown, u: unknown) => Promise<unknown>)(
    req,
    res,
    user
  );
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: null }))
  );
});

describe('resolveTrainingRun on a taken-down or deleted model', () => {
  it.each([
    ['taken down', TAKEN_DOWN],
    ['deleted', DELETED],
  ])('refuses its owner when %s, as if the version did not exist', async (_state, state) => {
    dbMock.dbWrite.modelVersion.findFirst.mockResolvedValue(null as never);
    const missing = await resolve(OWNER).catch((e: unknown) => e);
    givenModel(state);

    const refused = await resolve(OWNER).catch((e: unknown) => e);

    expect(refused).toMatchObject({ code: 'NOT_FOUND' });
    expect((refused as Error).message).toBe((missing as Error).message);
  });

  it('still resolves for a moderator', async () => {
    givenModel(TAKEN_DOWN);

    await expect(resolve(MODERATOR)).resolves.toBeDefined();
  });

  it('resolves for the owner of a model that is neither', async () => {
    givenModel(PUBLISHED);

    await expect(resolve(OWNER)).resolves.toBeDefined();
  });
});

describe('/api/download/training/[modelVersionId] on a taken-down model', () => {
  it('answers its owner 404 and fetches no epoch', async () => {
    givenModel(TAKEN_DOWN);

    const res = await downloadEpoch(OWNER);

    expect(res.statusCode).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('serves a moderator', async () => {
    givenModel(TAKEN_DOWN);

    await downloadEpoch(MODERATOR);

    expect(fetch).toHaveBeenCalledWith(EPOCH_URL, expect.anything());
  });
});
