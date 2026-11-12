import { beforeEach, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The job token is not what this file tests.
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  JobEndpoint: (handler: unknown) => handler,
}));

const restoreModels = (await import('~/pages/api/internal/restore-models')).default;

const MODEL = 3;
let lockedMeta: Record<string, unknown>;
let lockedBaseModel: string;

beforeEach(() => {
  vi.clearAllMocks();
  lockedMeta = {};
  lockedBaseModel = 'SDXL 1.0';
  // The candidates read before the publishes: no removal record yet.
  dbMock.dbWrite.$queryRawUnsafe.mockResolvedValue([
    { id: MODEL, meta: { unpublishedReason: 'duplicate' }, versionIds: [30] },
  ] as never);
  let lockHeld = false;
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (
      Array.isArray(strings) &&
      /FROM "Model"\s+WHERE id = \?\s+FOR NO KEY UPDATE/.test(strings.join('?')) &&
      values[0] === MODEL
    )
      lockHeld = true;
    if (Array.isArray(strings) && /FROM "ModelVersion"[\s\S]*FOR SHARE/.test(strings.join('?')))
      return [{ id: 30, baseModel: lockedBaseModel }];
    return [];
  }) as never);
  // Before the lock, the row as the candidates read it; under it, what a wipe may have written since.
  dbMock.dbWrite.model.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) =>
    where.id === MODEL
      ? { status: 'Unpublished', meta: lockHeld ? lockedMeta : { unpublishedReason: 'duplicate' } }
      : null) as never);
  dbMock.dbWrite.model.update.mockResolvedValue({
    id: MODEL,
    nsfw: false,
    userId: 5,
    status: 'Published',
    modelVersions: [],
  } as never);
});

const run = async () => {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  await (restoreModels as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    { query: { modelIds: [MODEL] } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res;
};

it('leaves a model a content wipe kept after the candidates were read, and still answers 200', async () => {
  lockedMeta = { removedWithOwner: true, statusBeforeRemoval: 'Published' };

  const res = await run();

  expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
});

it('republishes a model no wipe kept, with its meta as it is under the lock', async () => {
  lockedMeta = { unpublishedReason: 'duplicate', showcaseCollectionId: 9 };

  await run();

  expect(dbMock.dbWrite.model.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ meta: { showcaseCollectionId: 9 } }),
    })
  );
});

it('skips a model a publish rule refuses and still restores the rest', async () => {
  const OTHER = 4;
  dbMock.dbWrite.$queryRawUnsafe.mockResolvedValue([
    { id: MODEL, meta: { unpublishedReason: 'duplicate' }, versionIds: [30] },
    { id: OTHER, meta: { unpublishedReason: 'duplicate' }, versionIds: [40] },
  ] as never);
  // Version 30 is on a non-commercial base model and still stores a licensing fee.
  dbMock.dbWrite.modelVersion.findMany.mockImplementation((async (args: {
    where: { id: { in: number[] }; modelId?: number; licensingFee?: unknown };
  }) => {
    if (args.where.licensingFee) return args.where.id.in.includes(30) ? [{ id: 30 }] : [];
    const rows = [
      { id: 30, modelId: MODEL, baseModel: 'Flux.2 Klein 9B' },
      { id: 40, modelId: OTHER, baseModel: 'SDXL 1.0' },
    ];
    return rows
      .filter((v) => args.where.id.in.includes(v.id) && v.modelId === args.where.modelId)
      .map((v) => ({ ...v, publishedAt: null, meta: {}, model: { type: 'LORA', userId: 5 } }));
  }) as never);
  dbMock.dbWrite.paidAccess.findMany.mockResolvedValue([]);
  dbMock.dbWrite.modelVersion.update.mockResolvedValue({ id: 40, modelId: OTHER } as never);

  const res = await run();

  expect(dbMock.dbWrite.model.update).toHaveBeenCalledTimes(1);
  expect(dbMock.dbWrite.model.update).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ id: OTHER }) })
  );
  expect(res.status).toHaveBeenCalledWith(200);
});

it('leaves a version moved onto a gated base model since the select, and still answers 200', async () => {
  lockedBaseModel = 'Fibo 2.0';
  // The version as the publish reads it before its lock, still on an ungated base model.
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValueOnce([
    {
      id: 30,
      baseModel: 'SDXL 1.0',
      publishedAt: null,
      meta: {},
      model: { type: 'LORA', userId: 5 },
    },
  ] as never);

  const res = await run();

  expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
});

it('never selects a version on a gated base model', async () => {
  await run();

  const [sql] = dbMock.dbWrite.$queryRawUnsafe.mock.calls[0] as [string];
  expect(sql).toMatch(/mv\."baseModel" NOT IN \('Fibo 2\.0'\)/);
});
